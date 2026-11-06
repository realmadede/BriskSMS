import {
  GatewayCredentials,
  MessageDispatchPayload,
  MessageDispatchResult,
  NormalizedDeliveryEvent,
} from '@brisksms/shared';

/**
 * Universal Internal Messaging Provider Boundary
 */
export interface MessagingProvider {
  /**
   * Dispatches a single message via the gateway relay
   */
  sendMessage(
    credentials: GatewayCredentials,
    payload: MessageDispatchPayload,
  ): Promise<MessageDispatchResult>;

  /**
   * Cryptographically verifies delivery receipt webhook signatures
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
    signingSecret: string,
  ): boolean;

  /**
   * Normalizes upstream gateway webhook payloads into standard domain events
   */
  normalizeWebhookPayload(
    rawPayload: Record<string, unknown>,
  ): NormalizedDeliveryEvent;
}

