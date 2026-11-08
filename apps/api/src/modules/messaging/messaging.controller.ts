/**
 * BriskSMS Product B Messaging Controller
 * Handles incoming delivery status reports from SMSGate gateways and devices.
 */

import { createHash } from 'node:crypto';
import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { sql } from '@brisksms/db';
import { SmsGateProvider } from './providers/smsgate.provider.js';
import { smsGateKeyService } from './services/smsgate-key.service.js';
import { messagingService } from './messaging.service.js';

const smsgateProvider = new SmsGateProvider();

export function registerMessagingRoutes(router: Router): void {
  /**
   * Official SMSGate Webhook Receiver Endpoint
   * Conforms strictly to docs.sms-gate.app specification:
   * - Signature verification against exact raw HTTP request body bytes concatenated with timestamp
   * - Replay protection backed by durable smsgate_webhook_events table
   * - Idempotent delivery report processing (returns HTTP 200 { duplicate: true } without financial re-mutation)
   * - ACID row-locked state transitions preventing out-of-order terminal state corruption
   */
  /**
   * Official SMSGate Webhook Receiver Endpoint
   * Conforms strictly to docs.sms-gate.app specification:
   * - Authoritative Tenant & Device Binding (rejects untrusted headers/query overrides)
   * - Signature verification against exact raw HTTP request body bytes concatenated with timestamp
   * - Durable, stable event identity (SHA-256 excluding ephemeral transport signatures/timestamps)
   * - Atomic single-transaction state machine and credit consistency
   * - Idempotent delivery report processing (returns HTTP 200 { duplicate: true } on retries)
   */
  router.post('/v1/messaging/webhooks/smsgate', async (req: RouteRequest): Promise<ApiResponse> => {
    // 1. Signature & Timestamp Header Validation
    const signature = (
      (req.headers['x-signature'] as string) ||
      (req.headers['X-Signature'] as string) ||
      ''
    ).trim();

    const timestamp = (
      (req.headers['x-timestamp'] as string) ||
      (req.headers['X-Timestamp'] as string) ||
      ''
    ).trim();

    if (!signature || !timestamp) {
      throw new HttpException(
        400,
        'MISSING_SIGNATURE_HEADERS',
        'X-Signature and X-Timestamp headers are required for SMSGate webhooks',
      );
    }

    const rawPayload = req.body || {};
    const rawBodyBuffer = req.rawBodyBuffer || Buffer.from(req.rawBody || '', 'utf8');

    // 2. Normalize incoming SMSGate delivery report
    const normalizedEvent = smsgateProvider.normalizeWebhookPayload(rawPayload);

    // 3. Authoritative Tenant & Device Identity Resolution
    const suppliedOrgHint = (
      (req.query.org as string) ||
      (req.query.organizationId as string) ||
      (req.headers['x-organization-id'] as string) ||
      (rawPayload.organizationId as string) ||
      ''
    ).trim() || undefined;

    const candidateDeviceId = (
      normalizedEvent.deviceId ||
      (req.headers['x-device-id'] as string) ||
      (rawPayload.deviceId as string) ||
      ''
    ).trim() || undefined;

    let trustedOrgId: string;
    let trustedDeviceId: string | undefined = undefined;

    if (candidateDeviceId) {
      // Authoritatively resolve organization from persisted device association
      const authoritativeOrgId = await smsGateKeyService.resolveAuthoritativeDeviceOrganization(candidateDeviceId);
      if (!authoritativeOrgId) {
        throw new HttpException(
          404,
          'UNKNOWN_DEVICE',
          `Device "${candidateDeviceId}" is not registered to any organization`,
        );
      }

      // Untrusted routing hint verification: Must match authoritative device binding
      if (suppliedOrgHint && suppliedOrgHint !== authoritativeOrgId) {
        throw new HttpException(
          403,
          'TENANT_DEVICE_MISMATCH',
          'Request-supplied organization does not match the authoritative organization registered for this device',
        );
      }

      trustedOrgId = authoritativeOrgId;
      trustedDeviceId = candidateDeviceId;
    } else {
      // Mode B VPS Gateway (no physical Android device ID attached)
      if (!suppliedOrgHint) {
        throw new HttpException(
          400,
          'MISSING_ORGANIZATION_CONTEXT',
          'Unable to determine organizationId for incoming webhook. Provide ?org=<orgId> or register device.',
        );
      }
      trustedOrgId = suppliedOrgHint;
      trustedDeviceId = undefined;
    }

    // Validate that provider message ID (if present) belongs to the trusted organization
    if (normalizedEvent.providerMessageId && normalizedEvent.providerMessageId !== 'unknown') {
      try {
        const msgRows = await sql<Record<string, any>>`
          SELECT organization_id FROM sms_messages
          WHERE provider_message_id = ${normalizedEvent.providerMessageId}
          LIMIT 1
        `;
        if (msgRows.length > 0 && msgRows[0]!.organization_id !== trustedOrgId) {
          throw new HttpException(
            403,
            'TENANT_MESSAGE_MISMATCH',
            'Target provider message ID belongs to a different organization than the verified device/gateway',
          );
        }
      } catch (err: unknown) {
        if (err instanceof HttpException) throw err;
      }
    }

    // 4. Resolve Candidate Signing Keys & Verify Cryptographic Signature
    const candidateKeys = await smsGateKeyService.resolveCandidateKeys(trustedOrgId, trustedDeviceId);
    if (!candidateKeys || candidateKeys.length === 0) {
      throw new HttpException(
        401,
        'MISSING_SIGNING_KEY',
        'No active SMSGate webhook signing key provisioned for this organization/device',
      );
    }

    const verifyResult = smsgateProvider.verifyWebhookSignatureDetailed(
      rawBodyBuffer,
      signature,
      timestamp,
      candidateKeys,
      { skipReplayCache: true },
    );

    if (!verifyResult.isValid) {
      switch (verifyResult.error) {
        case 'EXPIRED_TIMESTAMP':
        case 'TIMESTAMP_EXPIRED':
          throw new HttpException(400, 'TIMESTAMP_EXPIRED', 'X-Timestamp is outside acceptable time tolerance window');
        case 'FUTURE_TIMESTAMP':
          throw new HttpException(400, 'FUTURE_TIMESTAMP', 'X-Timestamp is in the future');
        case 'INVALID_SIGNATURE':
          throw new HttpException(401, 'INVALID_SIGNATURE', 'Cryptographic signature verification failed');
        default:
          throw new HttpException(401, 'INVALID_SIGNATURE', verifyResult.error || 'Signature verification failed');
      }
    }

    // 5. Compute Durable & Stable Event Identity
    // Stable fingerprint: excludes X-Signature and X-Timestamp (which change across retries)
    const stableKey = normalizedEvent.upstreamEventId
      ? `evt:${normalizedEvent.upstreamEventId}`
      : `${normalizedEvent.providerMessageId}:${normalizedEvent.eventType}:${normalizedEvent.rawTimestamp ?? ''}:${normalizedEvent.simNumber ?? 1}`;

    const eventFingerprint = createHash('sha256')
      .update(`${trustedOrgId}:${trustedDeviceId ?? 'GATEWAY'}:${stableKey}`)
      .digest('hex');

    // 6. Concurrency-Safe Transactional State Machine & Credit Consistency
    const result = await messagingService.processSmsGateWebhookDelivery({
      organizationId: trustedOrgId,
      deviceId: trustedDeviceId,
      eventFingerprint,
      event: normalizedEvent,
      signature,
      timestamp,
    });

    return {
      success: true,
      data: {
        duplicate: result.duplicate,
        providerMessageId: normalizedEvent.providerMessageId,
        status: normalizedEvent.eventType,
        messageRecord: result.messageRecord,
        message: result.duplicate
          ? 'Delivery event already processed (idempotent duplicate retry)'
          : undefined,
      },
    };
  });
}
