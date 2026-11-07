import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GatewayCredentials,
  MessageDispatchPayload,
  MessageDispatchResult,
  NormalizedDeliveryEvent,
} from '@brisksms/shared';
import { MessagingProvider } from '../interfaces/messaging-provider.interface.js';

export class SmsGateProvider implements MessagingProvider {
  /**
   * Resolves and normalizes the target SMSGate endpoint URL.
   * Validates URL scheme (http/https only) and ensures clean path resolution.
   * Supports official self-hosted paths (/api/3rdparty/v1), Cloud paths (/3rdparty/v1),
   * and reverse-proxy aliases (/api/v1).
   */
  resolveEndpoint(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      throw new Error(`Invalid gateway URL scheme: "${baseUrl}". Only HTTP and HTTPS are permitted.`);
    }

    const cleanBase = trimmed.replace(/\/+$/, '');
    if (cleanBase.endsWith('/messages') || cleanBase.endsWith('/message')) {
      return cleanBase;
    }
    return `${cleanBase}/messages`;
  }

  /**
   * Builds the Authorization header supporting both JWT Bearer and HTTP Basic authentication.
   */
  buildAuthHeader(apiToken: string): string {
    const trimmed = apiToken.trim();
    if (trimmed.startsWith('Bearer ') || trimmed.startsWith('Basic ')) {
      return trimmed;
    }
    if (trimmed.includes(':')) {
      return `Basic ${Buffer.from(trimmed).toString('base64')}`;
    }
    return `Bearer ${trimmed}`;
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

    const authHeader = this.buildAuthHeader(credentials.apiToken);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
          'X-Idempotency-Key': payload.idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          providerMessageId: `failed_${Date.now()}`,
          status: 'FAILED',
          rawResponse: { statusCode: response.status, error: errorText },
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
        status: 'FAILED',
        rawResponse: { error: message },
      };
    }
  }

  /**
   * Cryptographically verifies delivery webhook signature using HMAC-SHA256
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
    signingSecret: string,
  ): boolean {
    if (!signatureHeader || !signingSecret) return false;
    try {
      const expectedSignature = createHmac('sha256', signingSecret)
        .update(rawBody, 'utf8')
        .digest('hex');

      const sigBuf = Buffer.from(signatureHeader, 'hex');
      const expectedBuf = Buffer.from(expectedSignature, 'hex');

      if (sigBuf.length !== expectedBuf.length) return false;
      return timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
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

    const timestampVal = payloadObj.receivedAt || payloadObj.timestamp || rawPayload.timestamp;
    const carrierTimestamp = timestampVal
      ? new Date(timestampVal as string)
      : new Date();

    return {
      providerMessageId,
      eventType,
      failureReason,
      carrierTimestamp,
    };
  }
}

export const smsGateProvider = new SmsGateProvider();
