/**
 * BriskSMS Product B Messaging Controller
 * Handles incoming delivery status reports from SMSGate gateways and devices.
 */

import { createHash } from 'node:crypto';
import { ApiKeyScope, OutboundSmsJobStatus, UserRole } from '@brisksms/shared';
import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { sql } from '@brisksms/db';
import { SmsGateProvider } from './providers/smsgate.provider.js';
import { smsGateKeyService } from './services/smsgate-key.service.js';
import { messagingService } from './messaging.service.js';
import { outboundSmsJobService } from './outbound-sms-job.service.js';
import {
  authenticate,
  authenticateDevice,
  assertHumanSessionAuth,
  assertOAuthScope,
  resolveAuthorizedTenantOrgId,
} from '../../core/guards.js';
import { ApiKeyService } from '../developer/api-key.service.js';
import { authService } from '../auth/auth.service.js';
import { dbStore } from '../../core/store.js';

const smsgateProvider = new SmsGateProvider();
const apiKeyService = new ApiKeyService();

async function resolveMessagingAuthContext(
  req: RouteRequest,
  options: {
    suppliedOrgId?: unknown;
    requiredApiKeyScopes: ApiKeyScope[];
    allowedUserRoles?: UserRole[];
  },
): Promise<{ organizationId: string }> {
  const authHeader = (req.headers.authorization || (req.headers as any).Authorization || '') as string;
  const apiKeyHeader = (req.headers['x-api-key'] || (req.headers as any)['X-API-Key'] || '') as string;
  const requestedOrgId =
    typeof options.suppliedOrgId === 'string' && options.suppliedOrgId.trim()
      ? options.suppliedOrgId.trim()
      : undefined;

  let rawKey: string | undefined;
  if (authHeader.startsWith('Bearer bsk_live_')) {
    rawKey = authHeader.replace('Bearer ', '').trim();
  } else if (apiKeyHeader.startsWith('bsk_live_')) {
    rawKey = apiKeyHeader.trim();
  }

  if (rawKey) {
    const keyRecord = await apiKeyService.validateApiKey(rawKey);
    if (!keyRecord) {
      throw new HttpException(401, 'INVALID_API_KEY', 'Unauthorized: Invalid or revoked API key');
    }
    if (!options.requiredApiKeyScopes.some((s) => keyRecord.scopes.includes(s))) {
      throw new HttpException(403, 'INSUFFICIENT_SCOPE', 'Forbidden: API key lacks required messaging scope');
    }
    if (requestedOrgId && requestedOrgId !== keyRecord.organizationId) {
      throw new HttpException(
        403,
        'CROSS_ORGANIZATION_FORBIDDEN',
        'Requested organizationId does not match authenticated API key organization',
      );
    }
    return { organizationId: keyRecord.organizationId };
  }

  await authenticate(req);
  assertOAuthScope(req, options.requiredApiKeyScopes);
  const userId = req.context.userId!;
  const contextOrgId = req.context.organizationId;
  if (contextOrgId && requestedOrgId && requestedOrgId !== contextOrgId) {
    throw new HttpException(
      403,
      'CROSS_ORGANIZATION_FORBIDDEN',
      'Requested organizationId does not match authenticated organization context',
    );
  }

  const orgId = contextOrgId || requestedOrgId;
  if (!orgId) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
  }

  const membership = await dbStore.getMembership(orgId, userId);
  if (!membership) {
    throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
  }
  if (options.allowedUserRoles && !options.allowedUserRoles.includes(membership.role)) {
    throw new HttpException(
      403,
      'INSUFFICIENT_PERMISSIONS',
      `Action requires one of the following roles: ${options.allowedUserRoles.join(', ')}`,
    );
  }

  return { organizationId: orgId };
}

function extractMessagingIdempotencyKey(req: RouteRequest, body: Record<string, unknown>): string | undefined {
  const rawHeader = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
  const headerIdem = typeof rawHeader === 'string' ? rawHeader.trim() : undefined;
  const bodyIdem = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : undefined;

  if (rawHeader !== undefined && !headerIdem) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'Idempotency-Key header cannot be blank');
  }
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== 'string' || !bodyIdem)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey must be a non-empty string when provided');
  }
  if (headerIdem && bodyIdem && headerIdem !== bodyIdem) {
    throw new HttpException(
      400,
      'VALIDATION_ERROR',
      'Conflicting Idempotency-Key header and body.idempotencyKey values',
    );
  }
  return headerIdem || bodyIdem;
}

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

  // 1. Get Prepaid SMS Credit Balance
  router.get('/v1/messaging/balance', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertOAuthScope(req, [ApiKeyScope.SMS_READ, ApiKeyScope.SMS_SEND]);
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.query.organizationId);
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership) {
      throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
    }

    const balances = await messagingService.getAccountBalances(orgId);
    return {
      success: true,
      data: balances,
    };
  });

  // 2. Dispatch Single SMS Message
  router.post('/v1/messaging/send', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const { organizationId: orgId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: body.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_SEND],
    });

    await authService.checkRateLimit(`msg_send_${orgId}`, 120, 60_000);

    const recipientTo = body.to ?? body.recipientPhone ?? body.recipient;
    const messageContent = body.content ?? body.message;
    if (!recipientTo || !messageContent) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'to (or recipientPhone) and content (or message) are required');
    }

    const idempotencyKey = extractMessagingIdempotencyKey(req, body);

    if (body.deviceId || body.deliveryChannel === 'ANDROID_COMPANION') {
      const enqueued = await outboundSmsJobService.enqueueJob(orgId, {
        to: String(recipientTo),
        content: String(messageContent),
        simSlot: body.simSlot !== undefined ? Number(body.simSlot) : undefined,
        deviceId: body.deviceId ? String(body.deviceId) : undefined,
        isPromotional: Boolean(body.isPromotional),
        idempotencyKey,
        ttlSeconds: body.ttlSeconds !== undefined ? Number(body.ttlSeconds) : undefined,
        maxAttempts: body.maxAttempts !== undefined ? Number(body.maxAttempts) : undefined,
      });

      return {
        success: true,
        statusCode: 201,
        data: {
          ...enqueued.message,
          outboundJobId: enqueued.job.id,
          outboundJobStatus: enqueued.job.status,
          idempotentReplay: enqueued.idempotentReplay,
        },
      };
    }

    const messageRecord = await messagingService.sendSingleMessage(orgId, {
      to: String(recipientTo),
      content: String(messageContent),
      simSlot: body.simSlot ? Number(body.simSlot) : 1,
      idempotencyKey,
    });

    return {
      success: true,
      statusCode: 201,
      data: messageRecord,
    };
  });

  // 2a. Enqueue Durable Android Outbound SMSGate Job
  router.post('/v1/messaging/device-jobs', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: body.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_SEND],
      allowedUserRoles: [UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER],
    });
    await authService.checkRateLimit(`msg_devjob_${organizationId}`, 120, 60_000);
    const idempotencyKey = extractMessagingIdempotencyKey(req, body);

    if (!body.to || !body.content) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'to and content are required');
    }

    const result = await outboundSmsJobService.enqueueJob(organizationId, {
      to: String(body.to),
      content: String(body.content),
      simSlot: body.simSlot !== undefined ? Number(body.simSlot) : undefined,
      deviceId: body.deviceId ? String(body.deviceId) : undefined,
      isPromotional: Boolean(body.isPromotional),
      campaignId: body.campaignId ? String(body.campaignId) : undefined,
      idempotencyKey,
      ttlSeconds: body.ttlSeconds !== undefined ? Number(body.ttlSeconds) : undefined,
      maxAttempts: body.maxAttempts !== undefined ? Number(body.maxAttempts) : undefined,
    });

    return {
      success: true,
      statusCode: result.idempotentReplay ? 200 : 201,
      data: result,
    };
  });

  // 2b. Android Device: Acquire Leased Outbound SMS Jobs (must be registered before :jobId param routes)
  router.post('/v1/messaging/device-jobs/acquire', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceAuth = await authenticateDevice(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;

    const result = await outboundSmsJobService.acquireJobsForDevice(
      deviceAuth.deviceId,
      deviceAuth.organizationId,
      {
        limit: body.limit !== undefined ? Number(body.limit) : undefined,
        leaseSeconds: body.leaseSeconds !== undefined ? Number(body.leaseSeconds) : undefined,
        availableSimSlots: Array.isArray(body.availableSimSlots)
          ? body.availableSimSlots.map((v: any) => Number(v))
          : undefined,
      },
    );

    return {
      success: true,
      data: result,
    };
  });

  // 2c. Android Device: Record Dispatch Intent Before Invoking SmsManager
  router.post('/v1/messaging/device-jobs/:jobId/dispatching', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceAuth = await authenticateDevice(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const jobId = req.params.jobId || '';

    const result = await outboundSmsJobService.markDispatching(
      deviceAuth.deviceId,
      deviceAuth.organizationId,
      jobId,
      {
        leaseToken: typeof body.leaseToken === 'string' ? body.leaseToken : '',
        simSlot: body.simSlot !== undefined ? Number(body.simSlot) : undefined,
      },
    );

    return {
      success: true,
      data: result,
    };
  });

  // 2d. Android Device: Report Cellular Dispatch Outcome
  router.post('/v1/messaging/device-jobs/:jobId/result', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceAuth = await authenticateDevice(req);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const jobId = req.params.jobId || '';

    const result = await outboundSmsJobService.reportJobResult(
      deviceAuth.deviceId,
      deviceAuth.organizationId,
      jobId,
      {
        leaseToken: typeof body.leaseToken === 'string' ? body.leaseToken : '',
        outcome: body.outcome,
        simSlot: body.simSlot !== undefined ? Number(body.simSlot) : undefined,
        partsCount: body.partsCount !== undefined ? Number(body.partsCount) : undefined,
        radioResultCode: body.radioResultCode !== undefined ? Number(body.radioResultCode) : undefined,
        gatewayReference: typeof body.gatewayReference === 'string' ? body.gatewayReference : undefined,
        errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : undefined,
        failureCode: typeof body.failureCode === 'string' ? body.failureCode : undefined,
        preRadioFailure: Boolean(body.preRadioFailure),
        carrierTimestamp: typeof body.carrierTimestamp === 'string' ? body.carrierTimestamp : undefined,
      },
    );

    return {
      success: true,
      data: result,
    };
  });

  // 2e. Organization: List & Inspect Outbound SMS Jobs
  router.get('/v1/messaging/device-jobs', async (req: RouteRequest): Promise<ApiResponse> => {
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: req.query.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_SEND, ApiKeyScope.SMS_READ],
    });
    const statusParam = typeof req.query.status === 'string' ? (req.query.status as OutboundSmsJobStatus) : undefined;
    const deviceIdParam = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const limitParam = req.query.limit ? Number(req.query.limit) : undefined;

    const jobs = await outboundSmsJobService.listJobs(organizationId, {
      status: statusParam,
      deviceId: deviceIdParam,
      limit: limitParam,
    });

    return {
      success: true,
      data: { jobs },
    };
  });

  router.get('/v1/messaging/device-jobs/:jobId', async (req: RouteRequest): Promise<ApiResponse> => {
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: req.query.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_SEND, ApiKeyScope.SMS_READ],
    });
    const job = await outboundSmsJobService.getJobById(organizationId, req.params.jobId || '');
    return {
      success: true,
      data: { job },
    };
  });

  // 2f. Organization: Cancel Un-dispatched Outbound SMS Job
  router.post('/v1/messaging/device-jobs/:jobId/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: body.organizationId || req.query.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_SEND],
      allowedUserRoles: [UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER],
    });
    const job = await outboundSmsJobService.cancelJob(
      organizationId,
      req.params.jobId || '',
      typeof body.reason === 'string' ? body.reason : undefined,
    );
    return {
      success: true,
      data: { job },
    };
  });

  // 3. Create & Dispatch Bulk SMS Campaign
  router.post('/v1/messaging/campaigns', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertOAuthScope(req, [ApiKeyScope.SMS_SEND]);
    const userId = req.context.userId!;
    const body = req.body as Record<string, any>;
    const orgId = resolveAuthorizedTenantOrgId(req, body.organizationId);
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership) {
      throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
    }

    await authService.checkRateLimit(`msg_campaign_${orgId}`, 30, 60_000);

    if ((!body.name && !body.title) || (!body.templateText && !body.messageTemplate) || !body.recipients || !Array.isArray(body.recipients)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'name, templateText, and recipients array are required');
    }

    const campaign = await messagingService.createCampaign(orgId, {
      name: String(body.name || body.title),
      templateText: String(body.templateText || body.messageTemplate),
      recipients: body.recipients.map((r: any) => ({
        phoneNumber: String(r.phoneNumber || r.phone || r.recipientPhone),
        variables: r.variables && typeof r.variables === 'object' ? r.variables : undefined,
      })),
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
    });

    return {
      success: true,
      statusCode: 201,
      data: campaign,
    };
  });

  // 3a. List Bulk SMS Campaigns
  router.get('/v1/messaging/campaigns', async (req: RouteRequest): Promise<ApiResponse> => {
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: req.query.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_READ, ApiKeyScope.SMS_SEND],
    });
    const campaigns = await messagingService.listCampaigns(organizationId);
    return {
      success: true,
      data: { campaigns },
    };
  });

  // 3b. Inspect Specific Bulk SMS Campaign
  router.get('/v1/messaging/campaigns/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: req.query.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_READ, ApiKeyScope.SMS_SEND],
    });
    const details = await messagingService.getCampaignById(organizationId, req.params.id || '');
    return {
      success: true,
      data: details,
    };
  });

  // 3c. Enqueue/Trigger Campaign Dispatch
  router.post('/v1/messaging/campaigns/:id/dispatch', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: body.organizationId || req.query.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_SEND],
      allowedUserRoles: [UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER],
    });
    const result = await messagingService.enqueueCampaignDispatch(organizationId, req.params.id || '');
    return {
      success: true,
      data: result,
    };
  });

  // 3d. Cancel Scheduled/Draft Campaign and Release Reserved Credits
  router.post('/v1/messaging/campaigns/:id/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const { organizationId } = await resolveMessagingAuthContext(req, {
      suppliedOrgId: body.organizationId || req.query.organizationId,
      requiredApiKeyScopes: [ApiKeyScope.SMS_SEND],
      allowedUserRoles: [UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER],
    });
    const campaign = await messagingService.cancelCampaign(organizationId, req.params.id || '');
    return {
      success: true,
      data: { campaign },
    };
  });

  // 4. Query Credit Ledger History
  router.get('/v1/messaging/ledger', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertOAuthScope(req, [ApiKeyScope.SMS_READ]);
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.query.organizationId);
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership) {
      throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
    }

    const entries = await messagingService.listLedgerEntries(orgId);
    return {
      success: true,
      data: { entries },
    };
  });

  // 5. Update SMSGate Gateway Mode & Endpoint Configuration
  router.put('/v1/messaging/gateway-config', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'updating gateway configuration');
    const userId = req.context.userId!;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const orgId = resolveAuthorizedTenantOrgId(req, body.organizationId);
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership || ![UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER].includes(membership.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners, Admins, and Developers can update gateway configuration');
    }

    const updated = await messagingService.updateGatewayConfig(orgId, {
      gatewayMode: body.gatewayMode,
      gatewayBaseUrl: body.gatewayBaseUrl,
      apiToken: body.apiToken,
      defaultSimSlot: body.defaultSimSlot !== undefined ? Number(body.defaultSimSlot) : undefined,
    });
    return {
      success: true,
      data: { account: updated },
    };
  });

  // 6. Provision or Rotate Device SMSGate Webhook Signing Key
  router.post('/v1/messaging/signing-keys/device', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'provisioning device SMSGate signing keys');
    const userId = req.context.userId!;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const orgId = resolveAuthorizedTenantOrgId(req, body.organizationId);
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership || ![UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER].includes(membership.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners, Admins, and Developers can manage SMSGate signing keys');
    }

    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    const rotate = Boolean(body.rotate);
    if (!deviceId || !secret || secret.length < 16) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'deviceId and secret (at least 16 chars) are required');
    }

    if (rotate) {
      await smsGateKeyService.rotateDeviceSigningKey(orgId, deviceId, secret, userId);
    } else {
      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, secret, userId);
    }

    return {
      success: true,
      statusCode: 201,
      data: { organizationId: orgId, deviceId, provisioned: true, rotated: rotate },
    };
  });

  // 7. Provision or Rotate Gateway SMSGate Webhook Signing Key
  router.post('/v1/messaging/signing-keys/gateway', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'provisioning gateway SMSGate signing keys');
    const userId = req.context.userId!;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const orgId = resolveAuthorizedTenantOrgId(req, body.organizationId);
    const membership = await dbStore.getMembership(orgId, userId);
    if (!membership || ![UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER].includes(membership.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners, Admins, and Developers can manage SMSGate signing keys');
    }

    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    const rotate = Boolean(body.rotate);
    if (!secret || secret.length < 16) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'secret (at least 16 chars) is required');
    }

    if (rotate) {
      await smsGateKeyService.rotateGatewaySigningKey(orgId, secret, userId);
    } else {
      await smsGateKeyService.setGatewaySigningKey(orgId, secret, userId);
    }

    return {
      success: true,
      statusCode: 201,
      data: { organizationId: orgId, gatewayDefault: true, provisioned: true, rotated: rotate },
    };
  });
}
