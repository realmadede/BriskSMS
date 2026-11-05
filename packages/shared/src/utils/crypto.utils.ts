import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Computes a deterministic SHA-256 deduplication hash for an incoming transaction
 * Invariant formula: SHA256(org_id + provider + provider_reference + amount_cents + timestamp)
 */
export function computeDeduplicationHash(
  organizationId: string,
  provider: string,
  reference: string,
  amountCents: number | bigint,
  timestamp: string | Date,
): string {
  const normalizedTime = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  const canonicalPayload = [
    organizationId.trim(),
    provider.trim().toUpperCase(),
    reference.trim().toUpperCase(),
    amountCents.toString(),
    normalizedTime,
  ].join('|');

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

/**
 * Computes HMAC-SHA256 signature for outgoing webhook payload
 */
export function computeWebhookSignature(secret: string, timestamp: number, payloadBody: string): string {
  const signedPayload = `${timestamp}.${payloadBody}`;
  return createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
}

/**
 * Constant-time signature verification to prevent timing attacks
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  payloadBody: string,
  expectedSignature: string,
): boolean {
  const computedSignature = computeWebhookSignature(secret, timestamp, payloadBody);
  const computedBuffer = Buffer.from(computedSignature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (computedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(computedBuffer, expectedBuffer);
}
