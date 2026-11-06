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
   * Dispatches message via SMSGate REST API (Supports Mode A Cloud & Mode B Private VPS)
   */
  async sendMessage(
    credentials: GatewayCredentials,
    payload: MessageDispatchPayload,
  ): Promise<MessageDispatchResult> {
    const baseUrl = credentials.baseUrl.replace(/\/+$/, '');
    const endpoint = `${baseUrl}/message`;
    const simNumber = payload.simSlot ?? credentials.defaultSimSlot ?? 1;

    const requestBody = {
      phoneNumbers: [payload.to],
      message: payload.content,
      simNumber,
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.apiToken}`,
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
   * Verifies delivery webhook signature using HMAC-SHA256
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
   * Normalizes incoming webhook events into standard domain events
   */
  normalizeWebhookPayload(
    rawPayload: Record<string, unknown>,
  ): NormalizedDeliveryEvent {
    const providerMessageId =
      (rawPayload.id as string) ||
      (rawPayload.messageId as string) ||
      (rawPayload.providerMessageId as string) ||
      'unknown';

    const event = String(rawPayload.event || rawPayload.status || '').toUpperCase();

    let eventType: 'SENT' | 'DELIVERED' | 'FAILED' = 'SENT';
    if (event.includes('DELIVER') || event === 'DELIVERED') {
      eventType = 'DELIVERED';
    } else if (event.includes('FAIL') || event === 'FAILED' || event === 'UNDELIVERED') {
      eventType = 'FAILED';
    } else {
      eventType = 'SENT';
    }

    const failureReason =
      (rawPayload.error as string) ||
      (rawPayload.failureReason as string) ||
      (rawPayload.reason as string) ||
      undefined;

    const carrierTimestamp = rawPayload.timestamp
      ? new Date(rawPayload.timestamp as string)
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
