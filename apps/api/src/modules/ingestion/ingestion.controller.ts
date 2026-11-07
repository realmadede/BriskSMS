import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate, authenticateDevice } from '../../core/guards.js';
import { ingestionService } from './ingestion.service.js';
import { EvidenceSourceType } from '@brisksms/shared';

export function registerIngestionRoutes(router: Router): void {
  /**
   * Android Notification Relay Evidence Ingestion Endpoint
   * Authenticated strictly by device Bearer token (bsk_dev_...).
   * Validates device is active and bound to organization.
   * Disallows cross-organization evidence forwarding.
   */
  router.post('/v1/ingestion/evidence', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceCtx = await authenticateDevice(req);
    const body = req.body;

    if (!body || typeof body !== 'object') {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Request body must be a JSON object');
    }

    const senderAddress = body.senderAddress;
    if (!senderAddress || typeof senderAddress !== 'string' || senderAddress.trim().length === 0) {
      throw new HttpException(400, 'INVALID_SENDER_ADDRESS', 'senderAddress is required and must be a non-empty string');
    }
    if (senderAddress.length > 100) {
      throw new HttpException(400, 'INVALID_SENDER_ADDRESS', 'senderAddress must not exceed 100 characters');
    }

    const rawPayload = body.rawPayload;
    if (!rawPayload || typeof rawPayload !== 'string' || rawPayload.trim().length === 0) {
      throw new HttpException(400, 'INVALID_RAW_PAYLOAD', 'rawPayload is required and must be a non-empty string');
    }
    if (rawPayload.length > 4096) {
      throw new HttpException(400, 'PAYLOAD_TOO_LARGE', 'rawPayload exceeds maximum permitted size of 4096 characters');
    }

    if (!body.deviceTimestamp) {
      throw new HttpException(400, 'INVALID_TIMESTAMP', 'deviceTimestamp is required');
    }
    const deviceTimestamp = new Date(body.deviceTimestamp as string | number);
    if (isNaN(deviceTimestamp.getTime())) {
      throw new HttpException(400, 'INVALID_TIMESTAMP', 'deviceTimestamp must be a valid ISO date or Unix timestamp');
    }

    // Tenant isolation validation: Ensure client cannot claim another organization or device ID
    if (body.organizationId && body.organizationId !== deviceCtx.organizationId) {
      throw new HttpException(403, 'CROSS_ORGANIZATION_FORBIDDEN', 'Cannot ingest evidence for another organization');
    }
    if (body.deviceId && body.deviceId !== deviceCtx.deviceId) {
      throw new HttpException(403, 'CROSS_DEVICE_FORBIDDEN', 'deviceId does not match authenticated device identity');
    }

    let simSlot = 1;
    if (body.simSlot !== undefined && body.simSlot !== null) {
      const parsedSlot = Number(body.simSlot);
      if (parsedSlot !== 1 && parsedSlot !== 2) {
        throw new HttpException(400, 'INVALID_SIM_SLOT', 'simSlot must be either 1 or 2');
      }
      simSlot = parsedSlot;
    }

    let sequenceNumber: bigint | undefined = undefined;
    if (body.sequenceNumber !== undefined && body.sequenceNumber !== null) {
      try {
        sequenceNumber = BigInt(body.sequenceNumber as string | number);
      } catch {
        throw new HttpException(400, 'INVALID_SEQUENCE_NUMBER', 'sequenceNumber must be an integer');
      }
    }

    const ack = await ingestionService.ingestEvidence({
      organizationId: deviceCtx.organizationId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId: deviceCtx.deviceId,
      senderAddress: senderAddress.trim(),
      rawPayload: rawPayload.trim(),
      simSlot,
      deviceTimestamp,
      signature: typeof body.signature === 'string' ? body.signature.trim() : undefined,
      nonce: typeof body.nonce === 'string' ? body.nonce.trim() : undefined,
      sequenceNumber,
    });

    return {
      success: true,
      data: ack,
    };
  });

  /**
   * List Raw Payment Evidence (Organization Portal / Audit Endpoint)
   * Authenticated by human user JWT with organization context.
   */
  router.get('/v1/ingestion/evidence', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const orgId = req.context.organizationId || (req.query.organizationId as string);

    if (!orgId) {
      throw new HttpException(400, 'MISSING_ORG', 'Organization context or query param organizationId is required');
    }

    const evidenceList = await ingestionService.listRawEvidence(orgId);
    return {
      success: true,
      data: evidenceList,
    };
  });
}
