import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GatewayCredentials,
  GatewayAuthCredentials,
  MessageDispatchPayload,
  MessageDispatchResult,
  NormalizedDeliveryEvent,
} from '@brisksms/shared';
import { MessagingProvider } from '../interfaces/messaging-provider.interface.js';

export interface WebhookVerificationResult {
  isValid: boolean;
  error?: string;
}

export class SmsGateProvider implements MessagingProvider {
  private replayCache = new Map<string, number>();

  /**
   * Resolves and normalizes the target SMSGate endpoint URL.
   * Validates URL scheme (http/https only) and ensures clean path resolution.
   * Prevents Server-Side Request Forgery (SSRF) against cloud metadata and private network addresses.
   */
  resolveEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      throw new Error(`Invalid gateway URL scheme: "${baseUrl}". Only HTTP and HTTPS are permitted.`);
    }

    let urlObj: URL;
    try {
      urlObj = new URL(trimmed);
    } catch {
      throw new Error(`Malformed gateway URL: "${baseUrl}"`);
    }

    // SSRF Destination Validation
    const host = urlObj.hostname.toLowerCase();
    const isPrivateAllowed = process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS === 'true';

    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^127\.\d+\.\d+\.\d+$/.test(host);

    const isLinkLocalOrMetadata =
      host.startsWith('169.254.') ||
      host.startsWith('fe80:') ||
      host === 'metadata.google.internal' ||
      host === 'instance-data';

    const isPrivateIpv4 =
      /^10\.\d+\.\d+\.\d+$/.test(host) ||
      /^192\.168\.\d+\.\d+$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);

    const isPrivateIpv6 = /^f[cd][0-9a-f]{2}:/i.test(host);

    if ((isLoopback || isLinkLocalOrMetadata || isPrivateIpv4 || isPrivateIpv6) && !isPrivateAllowed) {
      throw new Error(
        `Gateway URL resolves to prohibited internal or private network destination: "${host}". Only public internet endpoints are permitted.`,
      );
    }

    const cleanBase = trimmed.replace(/\/+$/, '');
    if (cleanBase.endsWith('/messages') || cleanBase.endsWith('/message')) {
      return cleanBase;
    }
    return `${cleanBase}/messages`;
  }

  /**
   * Builds Authorization header from explicit credential configuration.
   * Strictly validates required fields without guessing or inferring mode from string patterns.
   */
  buildAuthHeader(
    auth:
      | GatewayAuthCredentials
      | { type: 'BASIC'; username?: string; password?: string }
      | { type: 'BEARER'; token?: string }
      | string,
  ): string {
    if (!auth) {
      throw new Error('Authentication credentials must be provided');
    }

    if (typeof auth === 'object' && auth !== null) {
      if (auth.type === 'BASIC') {
        const username = auth.username?.trim();
        const password = auth.password?.trim();
        if (!username || !password) {
          throw new Error('Invalid Basic credentials: username and password are required and cannot be empty');
        }
        return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      }

      if (auth.type === 'BEARER') {
        const token = auth.token?.trim();
        if (!token) {
          throw new Error('Invalid Bearer credentials: token is required and cannot be empty');
        }

        // Verify JWT structure and expiration if formatted as 3 dot-separated base64 segments
        const parts = token.split('.');
        if (parts.length === 3) {
          try {
            const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
            const payload = JSON.parse(payloadJson);
            if (payload.exp && typeof payload.exp === 'number') {
              const nowSec = Math.floor(Date.now() / 1000);
              if (payload.exp < nowSec) {
                throw new Error(`Bearer JWT access token is expired (exp: ${payload.exp}, now: ${nowSec})`);
              }
            }
          } catch (err: unknown) {
            if (err instanceof Error && err.message.includes('expired')) {
              throw err;
            }
            throw new Error('Malformed Bearer JWT token structure');
          }
        }
        return `Bearer ${token.replace(/^Bearer\s+/i, '')}`;
      }

      throw new Error(
        `Unsupported or missing credential type: "${(auth as any).type}". Must be "BASIC" or "BEARER"`,
      );
    }

    // Explicit check for pre-formatted header strings
    const trimmed = String(auth).trim();
    if (!trimmed) {
      throw new Error('Empty credential token string provided');
    }
    if (trimmed.startsWith('Bearer ') || trimmed.startsWith('Basic ')) {
      return trimmed;
    }

    // Refuse to guess auth type from raw un-typed strings
    throw new Error(
      'Ambiguous credential string: Explicit credential type (BASIC or BEARER) is required',
    );
  }

  /**
   * Cryptographically verifies delivery webhook signature with detailed diagnostic result.
   * Conforms to official SMSGate specification:
   * - Signing input: rawBody + timestamp (exact bytes concatenated)
   * - X-Timestamp validation: Unix timestamp in seconds with replay and clock skew protection
   * - Key rotation support: verifies against currentKey or previousKey
   */
  verifyWebhookSignatureDetailed(
    rawBody: string | Buffer,
    signatureHeader: string,
    timestampHeader: string,
    signingSecret: string | string[],
    options?: { toleranceSeconds?: number; clockSkewTolerance?: number; skipReplayCache?: boolean },
  ): WebhookVerificationResult {
    // 1. Signature header existence & format
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return { isValid: false, error: 'MISSING_SIGNATURE' };
    }
    const cleanSig = signatureHeader.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleanSig)) {
      return { isValid: false, error: 'MALFORMED_SIGNATURE' };
    }

    // 2. Timestamp header existence & format
    if (!timestampHeader || typeof timestampHeader !== 'string') {
      return { isValid: false, error: 'MISSING_TIMESTAMP' };
    }
    const cleanTimestamp = timestampHeader.trim();
    if (!/^\d+$/.test(cleanTimestamp)) {
      return { isValid: false, error: 'MALFORMED_TIMESTAMP' };
    }
    const timestampSec = parseInt(cleanTimestamp, 10);
    if (!Number.isSafeInteger(timestampSec) || timestampSec <= 0) {
      return { isValid: false, error: 'MALFORMED_TIMESTAMP' };
    }

    // 3. Timestamp Freshness & Clock Skew Validation
    const nowSec = Math.floor(Date.now() / 1000);
    const tolerance = options?.toleranceSeconds ?? 300; // 5 minutes
    const clockSkew = options?.clockSkewTolerance ?? 60; // 60 seconds future skew

    if (nowSec - timestampSec > tolerance) {
      return { isValid: false, error: 'EXPIRED_TIMESTAMP' };
    }
    if (timestampSec - nowSec > clockSkew) {
      return { isValid: false, error: 'FUTURE_TIMESTAMP' };
    }

    // 4. In-process Replay Attack Prevention (skipped when distributed DB deduplication is active)
    const replayKey = `${cleanSig}:${cleanTimestamp}`;
    const nowMs = Date.now();
    if (!options?.skipReplayCache) {
      const cachedExpiry = this.replayCache.get(replayKey);
      if (cachedExpiry && cachedExpiry > nowMs) {
        return { isValid: false, error: 'REPLAY_ATTACK' };
      }
    }

    // 5. Signing Secret Availability
    const candidateSecrets = Array.isArray(signingSecret)
      ? signingSecret.filter((s) => typeof s === 'string' && s.trim().length > 0)
      : typeof signingSecret === 'string' && signingSecret.trim().length > 0
        ? [signingSecret]
        : [];

    if (candidateSecrets.length === 0) {
      return { isValid: false, error: 'MISSING_SIGNING_KEY' };
    }

    // 6. Signature Computation: Exact raw HTTP request body bytes concatenated with timestamp string bytes
    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const tsBuf = Buffer.from(cleanTimestamp, 'utf8');
    const signingInput = Buffer.concat([bodyBuf, tsBuf]);
    const sigBuf = Buffer.from(cleanSig, 'hex');

    let matched = false;
    for (const secret of candidateSecrets) {
      try {
        const expectedSignature = createHmac('sha256', secret)
          .update(signingInput)
          .digest('hex');
        const expectedBuf = Buffer.from(expectedSignature, 'hex');

        if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
          matched = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!matched) {
      return { isValid: false, error: 'INVALID_SIGNATURE' };
    }

    // 7. Store in replay cache until window expires (if in-process cache enabled)
    if (!options?.skipReplayCache) {
      this.replayCache.set(replayKey, nowMs + tolerance * 1000);
      this.pruneReplayCache(nowMs);
    }

    return { isValid: true };
  }

  /**
   * Cryptographically verifies delivery webhook signature returning a boolean.
   */
  verifyWebhookSignature(
    rawBody: string | Buffer,
    signatureHeader: string,
    timestampHeader: string,
    signingSecret: string | string[],
  ): boolean {
    const result = this.verifyWebhookSignatureDetailed(
      rawBody,
      signatureHeader,
      timestampHeader,
      signingSecret,
    );
    return result.isValid;
  }

  /**
   * Cleans expired entries from replay cache to prevent memory bloat.
   */
  private pruneReplayCache(nowMs: number): void {
    if (this.replayCache.size > 1000) {
      for (const [key, expiry] of this.replayCache.entries()) {
        if (expiry <= nowMs) {
          this.replayCache.delete(key);
        }
      }
    }
  }

  /**
   * Resets replay cache (primarily for unit test isolation).
   */
  clearReplayCache(): void {
    this.replayCache.clear();
  }

  /**
   * Dispatches message via SMSGate REST API conforming strictly to docs.sms-gate.app schema.
   * Exclusively transmits `textMessage` without the deprecated/conflicting `message` field.
   */
  async sendMessage(
    credentials: GatewayCredentials,
    payload: MessageDispatchPayload,
  ): Promise<MessageDispatchResult> {
    // 1. Input pre-validation
    if (!payload.to || !payload.to.trim()) {
      return {
        providerMessageId: `failed_${Date.now()}`,
        status: 'FAILED',
        rawResponse: { error: 'Recipient phone number is required and cannot be empty' },
      };
    }

    if (!payload.content || !payload.content.trim()) {
      return {
        providerMessageId: `failed_${Date.now()}`,
        status: 'FAILED',
        rawResponse: { error: 'Message content cannot be empty' },
      };
    }

    let endpoint: string;
    try {
      endpoint = this.resolveEndpoint(credentials.baseUrl);
    } catch (err: unknown) {
      return {
        providerMessageId: `failed_${Date.now()}`,
        status: 'FAILED',
        rawResponse: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    let authHeader: string;
    try {
      const authInput =
        credentials.auth ??
        (credentials.apiToken
          ? credentials.apiToken.startsWith('Bearer ') || credentials.apiToken.startsWith('Basic ')
            ? credentials.apiToken
            : { type: 'BEARER' as const, token: credentials.apiToken }
          : undefined);
      if (!authInput) {
        throw new Error('Authentication credentials must be provided');
      }
      authHeader = this.buildAuthHeader(authInput as any);
    } catch (err: unknown) {
      return {
        providerMessageId: `failed_${Date.now()}`,
        status: 'FAILED',
        rawResponse: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    const simNumber = payload.simSlot ?? credentials.defaultSimSlot ?? 1;

    // Strict official SMSGate schema: Only `textMessage` is specified.
    // Deprecated `message`, `dataMessage`, and `mmsMessage` must NOT be combined.
    const requestBody = {
      textMessage: {
        text: payload.content,
      },
      phoneNumbers: [payload.to],
      simNumber,
      withDeliveryReport: true,
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
          'X-Idempotency-Key': payload.idempotencyKey,
        },
        body: JSON.stringify(requestBody),
        redirect: 'error',
      });

      if (!response.ok) {
        const errorText = await response.text();
        const isClientError = response.status >= 400 && response.status < 500;
        return {
          providerMessageId: `failed_${Date.now()}`,
          status: isClientError ? 'FAILED' : 'UNCERTAIN',
          rawResponse: { statusCode: response.status, error: errorText, uncertain: !isClientError },
        };
      }

      const json = (await response.json()) as Record<string, unknown>;
      const providerId =
        (json.id as string) ||
        (json.messageId as string) ||
        (Array.isArray(json) && json[0]?.id ? String(json[0].id) : null) ||
        `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      return {
        providerMessageId: providerId,
        status: 'DISPATCHED',
        rawResponse: json,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        providerMessageId: `err_${Date.now()}`,
        status: 'UNCERTAIN',
        rawResponse: { error: message, uncertain: true },
      };
    }
  }

  /**
   * Normalizes incoming webhook events into standard domain events.
   * Handles official SMSGate nested payload (payload.messageId / payload.simNumber).
   */
  normalizeWebhookPayload(
    rawPayload: Record<string, unknown>,
  ): NormalizedDeliveryEvent {
    const payloadObj = (rawPayload.payload as Record<string, unknown>) ?? rawPayload;
    const providerMessageId =
      (payloadObj.messageId as string) ||
      (payloadObj.id as string) ||
      (rawPayload.id as string) ||
      (rawPayload.messageId as string) ||
      (rawPayload.providerMessageId as string) ||
      'unknown';

    const deviceId =
      (rawPayload.deviceId as string) ||
      (payloadObj.deviceId as string) ||
      undefined;

    const rawEvent = String(rawPayload.event || rawPayload.status || '').toLowerCase();

    let eventType: 'SENT' | 'DELIVERED' | 'FAILED' = 'SENT';
    if (rawEvent === 'sms:delivered' || rawEvent.includes('deliver')) {
      eventType = 'DELIVERED';
    } else if (rawEvent === 'sms:failed' || rawEvent.includes('fail') || rawEvent.includes('undeliver')) {
      eventType = 'FAILED';
    } else if (rawEvent === 'sms:sent' || rawEvent.includes('sent')) {
      eventType = 'SENT';
    }

    const failureReason =
      (payloadObj.error as string) ||
      (payloadObj.failureReason as string) ||
      (payloadObj.reason as string) ||
      (rawPayload.error as string) ||
      (rawPayload.failureReason as string) ||
      (rawPayload.reason as string) ||
      undefined;

    const timestampVal = payloadObj.receivedAt || payloadObj.timestamp || rawPayload.timestamp || payloadObj.deliveredAt || payloadObj.sentAt || payloadObj.failedAt;
    const carrierTimestamp = timestampVal
      ? new Date(timestampVal as string)
      : new Date();

    const upstreamEventId =
      (rawPayload.id as string) ||
      (rawPayload.eventId as string) ||
      (payloadObj.id as string) ||
      undefined;

    const simNumber =
      typeof payloadObj.simNumber === 'number'
        ? payloadObj.simNumber
        : typeof rawPayload.simNumber === 'number'
          ? rawPayload.simNumber
          : undefined;

    const recipient =
      (payloadObj.recipient as string) ||
      (rawPayload.recipient as string) ||
      undefined;

    return {
      providerMessageId,
      eventType,
      failureReason,
      carrierTimestamp,
      rawTimestamp: timestampVal ? String(timestampVal) : undefined,
      deviceId,
      upstreamEventId,
      simNumber,
      recipient,
      rawEvent,
    };
  }
}

export const smsGateProvider = new SmsGateProvider();
