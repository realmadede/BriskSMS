import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AcquireOutboundSmsJobsRequest,
  CreditLedgerEntryType,
  DeviceStatus,
  FeatureKey,
  InsufficientCreditsError,
  OutboundSmsDispatchOutcome,
  OutboundSmsJob,
  OutboundSmsJobResultResponse,
  OutboundSmsJobStatus,
  QueueOutboundSmsJobRequest,
  ReportOutboundSmsJobResultRequest,
  SmsStatus,
  StartOutboundSmsDispatchRequest,
} from '@brisksms/shared';
import { assertTenantContext, sql, SqlExecutor, withTransaction } from '@brisksms/db';
import { HttpException } from '../../core/http.js';
import { SmsMessageRecord } from '../../core/store.js';
import { entitlementService } from '../subscription/entitlement.service.js';
import { recipientParserService } from './recipient-parser.service.js';
import { MessagingService } from './messaging.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_JOB_TTL_SECONDS = 3600;
const MIN_JOB_TTL_SECONDS = 10;
const MAX_JOB_TTL_SECONDS = 604_800;
const DEFAULT_CLAIM_LEASE_SECONDS = 60;
const MIN_CLAIM_LEASE_SECONDS = 15;
const MAX_CLAIM_LEASE_SECONDS = 300;
const DISPATCHING_LEASE_FLOOR_SECONDS = 120;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ALLOWED_ATTEMPTS = 5;
const MAX_CONTENT_LENGTH = 1600;

export interface EnqueueOutboundSmsResult {
  job: OutboundSmsJob;
  message: SmsMessageRecord;
  idempotentReplay: boolean;
}

export interface AcquireOutboundSmsResult {
  jobs: OutboundSmsJob[];
  relayEnabled: boolean;
  reason?: string;
}

type JobTxOutcome<T> =
  | { kind: 'OK'; value: T }
  | { kind: 'ERR'; statusCode: number; code: string; message: string; details?: Record<string, unknown> };

function mapOutboundSmsJobRow(row: Record<string, any>): OutboundSmsJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    messageId: row.message_id,
    assignedDeviceId: row.assigned_device_id ?? null,
    claimedByDeviceId: row.claimed_by_device_id ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    recipientPhone: row.recipient_phone,
    messageText: row.message_text,
    simSlot: Number(row.sim_slot ?? 1),
    status: row.status as OutboundSmsJobStatus,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    expiresAt: new Date(row.expires_at).toISOString(),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    dispatchStartedAt: row.dispatch_started_at ? new Date(row.dispatch_started_at).toISOString() : null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    gatewayReference: row.gateway_reference ?? null,
    radioResultCode: row.radio_result_code === null || row.radio_result_code === undefined
      ? null
      : Number(row.radio_result_code),
    failureCode: row.failure_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function resolveTtlSeconds(raw?: number): number {
  if (raw === undefined || raw === null) return DEFAULT_JOB_TTL_SECONDS;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'ttlSeconds must be a finite integer');
  }
  const value = Math.floor(raw);
  if (value < MIN_JOB_TTL_SECONDS || value > MAX_JOB_TTL_SECONDS) {
    throw new HttpException(
      400,
      'VALIDATION_ERROR',
      `ttlSeconds must be between ${MIN_JOB_TTL_SECONDS} and ${MAX_JOB_TTL_SECONDS}`,
    );
  }
  return value;
}

function resolveMaxAttempts(raw?: number): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_ATTEMPTS;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'maxAttempts must be an integer');
  }
  if (raw < 1 || raw > MAX_ALLOWED_ATTEMPTS) {
    throw new HttpException(400, 'VALIDATION_ERROR', `maxAttempts must be between 1 and ${MAX_ALLOWED_ATTEMPTS}`);
  }
  return raw;
}

function resolveLeaseSeconds(raw?: number): number {
  if (raw === undefined || raw === null) return DEFAULT_CLAIM_LEASE_SECONDS;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'leaseSeconds must be a finite integer');
  }
  const value = Math.floor(raw);
  if (value < MIN_CLAIM_LEASE_SECONDS || value > MAX_CLAIM_LEASE_SECONDS) {
    throw new HttpException(
      400,
      'VALIDATION_ERROR',
      `leaseSeconds must be between ${MIN_CLAIM_LEASE_SECONDS} and ${MAX_CLAIM_LEASE_SECONDS}`,
    );
  }
  return value;
}

function resolveSimSlot(raw?: number, fallback: number = 1): 1 | 2 {
  const candidate = raw ?? fallback;
  if (candidate !== 1 && candidate !== 2) {
    throw new HttpException(400, 'INVALID_SIM_SLOT', 'simSlot must be 1 or 2');
  }
  return candidate;
}

function parseSimSlotsFilter(raw?: number[]): number[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'availableSimSlots must be an array of slot integers (1 or 2)');
  }
  const unique = new Set<number>();
  for (const slot of raw) {
    if (slot !== 1 && slot !== 2) {
      throw new HttpException(400, 'INVALID_SIM_SLOT', 'availableSimSlots entries must be 1 or 2');
    }
    unique.add(slot);
  }
  return [...unique];
}

function normalizeIdempotencyKey(raw?: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey cannot be blank');
  }
  if (trimmed.length > 120) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey must be 120 characters or fewer');
  }
  return trimmed;
}

export class OutboundSmsJobService {
  constructor(private readonly messagingService: MessagingService = new MessagingService()) {}

  private async refundMessageCreditOnce(
    tx: SqlExecutor,
    organizationId: string,
    messageId: string,
    costCredits: number,
  ): Promise<void> {
    if (costCredits <= 0) return;
    const referenceId = `refund_${messageId}`;

    const accRows = await tx<Record<string, any>>`
      SELECT * FROM "messaging_accounts"
      WHERE "organization_id" = ${organizationId}::uuid
      FOR UPDATE
    `;
    if (accRows.length === 0) return;

    const existingRefund = await tx<{ id: string }>`
      SELECT "id" FROM "messaging_credit_ledger"
      WHERE "organization_id" = ${organizationId}::uuid
        AND "reference_id" = ${referenceId}
        AND "entry_type" = ${CreditLedgerEntryType.REFUND}::"CreditLedgerEntryType"
      LIMIT 1
    `;
    if (existingRefund.length > 0) return;

    const currentBalance = Number(accRows[0]!.credit_balance);
    const nextBalance = currentBalance + costCredits;
    const now = new Date();

    await tx`
      UPDATE "messaging_accounts"
      SET "credit_balance" = ${nextBalance}, "updated_at" = ${now}
      WHERE "organization_id" = ${organizationId}::uuid
    `;

    await tx`
      INSERT INTO "messaging_credit_ledger" (
        "id", "organization_id", "entry_type", "amount_credits", "balance_after", "reference_id", "created_at"
      ) VALUES (
        ${randomUUID()}, ${organizationId}::uuid, ${CreditLedgerEntryType.REFUND}::"CreditLedgerEntryType",
        ${costCredits}, ${nextBalance}, ${referenceId}, ${now}
      )
    `;
  }

  private async recordDeliveryAttempt(
    tx: SqlExecutor,
    params: {
      organizationId: string;
      messageId: string;
      attemptNumber: number;
      gatewayProvider: string;
      gatewayReference?: string | null;
      status: SmsStatus;
      errorMessage?: string | null;
      rawResponse?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO "sms_delivery_attempts" (
        "id", "organization_id", "message_id", "attempt_number", "gateway_provider",
        "provider_message_id", "status", "error_message", "raw_response", "attempted_at"
      ) VALUES (
        ${randomUUID()},
        ${params.organizationId}::uuid,
        ${params.messageId}::uuid,
        ${Math.max(1, params.attemptNumber)},
        ${params.gatewayProvider},
        ${params.gatewayReference ?? null},
        ${params.status}::"SmsStatus",
        ${params.errorMessage ?? null},
        ${params.rawResponse ? JSON.stringify(params.rawResponse) : null}::text::jsonb,
        NOW()
      )
    `;
  }

  /**
   * Sweeps stale leases & expired pre-dispatch jobs safely:
   * - DISPATCHING past lease -> UNCERTAIN (never retried, never refunded).
   * - QUEUED / CLAIMED past expires_at -> EXPIRED (single refund, SMS marked FAILED).
   * - CLAIMED past lease & max_attempts exhausted -> FAILED (single refund).
   */
  public async sweepStaleJobs(
    tx: SqlExecutor,
    organizationId?: string,
  ): Promise<{ expiredToUncertain: number; expiredBeforeDispatch: number; exhaustedClaims: number }> {
    const orgFilter = organizationId ?? null;

    // 1. DISPATCHING with expired lease -> UNCERTAIN (radio transmission may have occurred)
    const uncertainRows = await tx<Record<string, any>>`
      UPDATE "outbound_sms_jobs"
      SET "status" = ${OutboundSmsJobStatus.UNCERTAIN}::"OutboundSmsJobStatus",
          "failure_code" = 'DISPATCH_LEASE_EXPIRED',
          "error_message" = 'GATEWAY_UNCERTAIN: device dispatch lease expired before outcome was reported',
          "updated_at" = NOW()
      WHERE "status" = ${OutboundSmsJobStatus.DISPATCHING}::"OutboundSmsJobStatus"
        AND "lease_expires_at" IS NOT NULL
        AND "lease_expires_at" <= NOW()
        AND (${orgFilter}::uuid IS NULL OR "organization_id" = ${orgFilter}::uuid)
      RETURNING *
    `;

    for (const row of uncertainRows) {
      await tx`
        UPDATE "sms_messages"
        SET "last_error" = 'GATEWAY_UNCERTAIN: device dispatch lease expired before outcome was reported',
            "updated_at" = NOW()
        WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${row.organization_id}::uuid
      `;
    }

    // 2. QUEUED / CLAIMED past TTL expires_at -> EXPIRED + atomic credit refund
    const expiredPreDispatch = await tx<Record<string, any>>`
      UPDATE "outbound_sms_jobs"
      SET "status" = ${OutboundSmsJobStatus.EXPIRED}::"OutboundSmsJobStatus",
          "failure_code" = 'JOB_EXPIRED',
          "error_message" = 'Outbound SMS job expired before dispatch started',
          "completed_at" = NOW(),
          "updated_at" = NOW()
      WHERE "status" IN (${OutboundSmsJobStatus.QUEUED}::"OutboundSmsJobStatus", ${OutboundSmsJobStatus.CLAIMED}::"OutboundSmsJobStatus")
        AND "expires_at" <= NOW()
        AND (${orgFilter}::uuid IS NULL OR "organization_id" = ${orgFilter}::uuid)
      RETURNING *
    `;

    for (const row of expiredPreDispatch) {
      const msgRows = await tx<Record<string, any>>`
        UPDATE "sms_messages"
        SET "status" = ${SmsStatus.FAILED}::"SmsStatus",
            "last_error" = 'Outbound SMS job expired before dispatch started',
            "updated_at" = NOW()
        WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${row.organization_id}::uuid
        RETURNING "cost_credits", "gateway_provider"
      `;
      const cost = Number(msgRows[0]?.cost_credits ?? 1);
      const gwProvider = msgRows[0]?.gateway_provider ?? 'ANDROID_COMPANION';
      await this.recordDeliveryAttempt(tx, {
        organizationId: row.organization_id,
        messageId: row.message_id,
        attemptNumber: Number(row.attempt_count || 1),
        gatewayProvider: gwProvider,
        status: SmsStatus.FAILED,
        errorMessage: 'Outbound SMS job expired before dispatch started',
        rawResponse: { failureCode: 'JOB_EXPIRED', expired: true },
      });
      await this.refundMessageCreditOnce(tx, row.organization_id, row.message_id, cost);
    }

    // 3. CLAIMED (dispatch never started) past lease where attempt_count >= max_attempts -> FAILED + refund
    const exhausted = await tx<Record<string, any>>`
      UPDATE "outbound_sms_jobs"
      SET "status" = ${OutboundSmsJobStatus.FAILED}::"OutboundSmsJobStatus",
          "failure_code" = 'MAX_CLAIM_ATTEMPTS_EXHAUSTED',
          "error_message" = 'Outbound SMS job exhausted maximum claim attempts before dispatch started',
          "completed_at" = NOW(),
          "updated_at" = NOW()
      WHERE "status" = ${OutboundSmsJobStatus.CLAIMED}::"OutboundSmsJobStatus"
        AND "lease_expires_at" IS NOT NULL
        AND "lease_expires_at" <= NOW()
        AND "attempt_count" >= "max_attempts"
        AND (${orgFilter}::uuid IS NULL OR "organization_id" = ${orgFilter}::uuid)
      RETURNING *
    `;

    for (const row of exhausted) {
      const msgRows = await tx<Record<string, any>>`
        UPDATE "sms_messages"
        SET "status" = ${SmsStatus.FAILED}::"SmsStatus",
            "last_error" = 'Outbound SMS job exhausted maximum claim attempts before dispatch started',
            "updated_at" = NOW()
        WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${row.organization_id}::uuid
        RETURNING "cost_credits", "gateway_provider"
      `;
      const cost = Number(msgRows[0]?.cost_credits ?? 1);
      const gwProvider = msgRows[0]?.gateway_provider ?? 'ANDROID_COMPANION';
      await this.recordDeliveryAttempt(tx, {
        organizationId: row.organization_id,
        messageId: row.message_id,
        attemptNumber: Number(row.attempt_count || 1),
        gatewayProvider: gwProvider,
        status: SmsStatus.FAILED,
        errorMessage: 'Outbound SMS job exhausted maximum claim attempts before dispatch started',
        rawResponse: { failureCode: 'MAX_CLAIM_ATTEMPTS_EXHAUSTED' },
      });
      await this.refundMessageCreditOnce(tx, row.organization_id, row.message_id, cost);
    }

    return {
      expiredToUncertain: uncertainRows.length,
      expiredBeforeDispatch: expiredPreDispatch.length,
      exhaustedClaims: exhausted.length,
    };
  }

  /**
   * Queues a durable outbound SMS job for Android SMSGate cellular acquisition.
   * Atomically deducts 1 credit, appends ledger USAGE_DEDUCTION, inserts sms_messages,
   * and persists outbound_sms_jobs in PostgreSQL.
   */
  public async enqueueJob(
    organizationId: string,
    dto: QueueOutboundSmsJobRequest,
  ): Promise<EnqueueOutboundSmsResult> {
    assertTenantContext({ organizationId });

    if (!(await entitlementService.isFeatureEnabled(organizationId, FeatureKey.BULK_MESSAGING_ENABLED))) {
      throw new HttpException(
        403,
        'BULK_MESSAGING_DISABLED',
        'Bulk messaging is not enabled on your current subscription plan.',
      );
    }

    if (dto.isPromotional && this.messagingService.isCurfewRestricted()) {
      throw new HttpException(
        403,
        'CURFEW_RESTRICTED',
        'Promotional SMS broadcasts are restricted between 20:00 and 07:00 EAT.',
      );
    }

    const normalizedPhone = recipientParserService.normalizePhoneNumber(dto.to);
    if (!normalizedPhone) {
      throw new HttpException(400, 'INVALID_RECIPIENT_PHONE', `Invalid Tanzanian mobile phone number: ${dto.to}`);
    }

    if (typeof dto.content !== 'string' || !dto.content.trim()) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'Message content is required and cannot be empty');
    }
    if (dto.content.length > MAX_CONTENT_LENGTH) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        `Message content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
      );
    }

    if (dto.deviceId !== undefined && dto.deviceId !== null && !UUID_REGEX.test(dto.deviceId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'deviceId must be a valid UUID when provided');
    }

    const ttlSeconds = resolveTtlSeconds(dto.ttlSeconds);
    const maxAttempts = resolveMaxAttempts(dto.maxAttempts);
    const idempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);

    const account = await this.messagingService.getOrCreateAccount(organizationId);
    const simSlot = resolveSimSlot(dto.simSlot, account.defaultSimSlot);

    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          organizationId,
          to: normalizedPhone,
          content: dto.content,
          simSlot,
          deviceId: dto.deviceId ?? null,
          campaignId: dto.campaignId ?? null,
          ttlSeconds,
          maxAttempts,
        }),
      )
      .digest('hex');

    return withTransaction(async (tx) => {
      const accRows = await tx<Record<string, any>>`
        SELECT * FROM "messaging_accounts"
        WHERE "organization_id" = ${organizationId}::uuid
        FOR UPDATE
      `;
      if (accRows.length === 0 || !accRows[0]!.is_active) {
        throw new HttpException(403, 'MESSAGING_DISABLED', 'Messaging account is disabled for this organization');
      }

      if (idempotencyKey) {
        const existingRows = await tx<Record<string, any>>`
          SELECT * FROM "outbound_sms_jobs"
          WHERE "organization_id" = ${organizationId}::uuid
            AND "idempotency_key" = ${idempotencyKey}
          LIMIT 1
          FOR UPDATE
        `;
        if (existingRows.length > 0) {
          const existingJob = mapOutboundSmsJobRow(existingRows[0]!);
          if (existingRows[0]!.request_fingerprint !== requestFingerprint) {
            throw new HttpException(
              409,
              'IDEMPOTENCY_KEY_REUSE_CONFLICT',
              'Idempotency-Key was already used with different outbound SMS parameters',
            );
          }
          const msg = await this.messagingService.getMessageById(organizationId, existingJob.messageId);
          return {
            job: existingJob,
            message: msg!,
            idempotentReplay: true,
          };
        }
      }

      if (dto.deviceId) {
        const devRows = await tx<Record<string, any>>`
          SELECT "id", "organization_id", "status" FROM "devices"
          WHERE "id" = ${dto.deviceId}::uuid
          FOR UPDATE
        `;
        if (devRows.length === 0) {
          throw new HttpException(404, 'DEVICE_NOT_FOUND', `Device '${dto.deviceId}' not found`);
        }
        if (devRows[0]!.organization_id !== organizationId) {
          throw new HttpException(
            403,
            'CROSS_ORGANIZATION_FORBIDDEN',
            'Target relay device does not belong to your organization',
          );
        }
        if (devRows[0]!.status !== DeviceStatus.ACTIVE) {
          throw new HttpException(
            409,
            'DEVICE_NOT_ACTIVE',
            `Target relay device is not active (status: ${devRows[0]!.status})`,
          );
        }
      }

      const currentBalance = Number(accRows[0]!.credit_balance ?? 0);
      if (currentBalance < 1) {
        throw new InsufficientCreditsError(1, currentBalance);
      }

      const newBalance = currentBalance - 1;
      const now = new Date();
      const jobId = randomUUID();
      const messageId = randomUUID();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const ledgerRef = idempotencyKey || `smsjob_${jobId}`;

      await tx`
        UPDATE "messaging_accounts"
        SET "credit_balance" = ${newBalance}, "updated_at" = ${now}
        WHERE "organization_id" = ${organizationId}::uuid
      `;

      await tx`
        INSERT INTO "messaging_credit_ledger" (
          "id", "organization_id", "entry_type", "amount_credits", "balance_after", "reference_id", "metadata", "created_at"
        ) VALUES (
          ${randomUUID()},
          ${organizationId}::uuid,
          ${CreditLedgerEntryType.USAGE_DEDUCTION}::"CreditLedgerEntryType",
          1,
          ${newBalance},
          ${ledgerRef},
          ${JSON.stringify({ jobId, messageId, recipientPhone: normalizedPhone, simSlot })}::text::jsonb,
          ${now}
        )
      `;

      const msgRows = await tx<Record<string, any>>`
        INSERT INTO "sms_messages" (
          "id", "organization_id", "campaign_id", "recipient_phone", "message_text",
          "status", "cost_credits", "sim_slot", "gateway_provider", "attempt_count", "created_at", "updated_at"
        ) VALUES (
          ${messageId}::uuid,
          ${organizationId}::uuid,
          ${dto.campaignId ?? null}::uuid,
          ${normalizedPhone},
          ${dto.content},
          ${SmsStatus.QUEUED}::"SmsStatus",
          1,
          ${simSlot},
          'ANDROID_COMPANION',
          1,
          ${now},
          ${now}
        )
        RETURNING *
      `;

      const jobRows = await tx<Record<string, any>>`
        INSERT INTO "outbound_sms_jobs" (
          "id", "organization_id", "message_id", "assigned_device_id",
          "idempotency_key", "request_fingerprint", "recipient_phone", "message_text",
          "sim_slot", "status", "expires_at", "attempt_count", "max_attempts",
          "created_at", "updated_at"
        ) VALUES (
          ${jobId}::uuid,
          ${organizationId}::uuid,
          ${messageId}::uuid,
          ${dto.deviceId ?? null}::uuid,
          ${idempotencyKey ?? null},
          ${requestFingerprint},
          ${normalizedPhone},
          ${dto.content},
          ${simSlot},
          ${OutboundSmsJobStatus.QUEUED}::"OutboundSmsJobStatus",
          ${expiresAt},
          0,
          ${maxAttempts},
          ${now},
          ${now}
        )
        RETURNING *
      `;

      const msgRow = msgRows[0]!;
      const message: SmsMessageRecord = {
        id: msgRow.id,
        organizationId: msgRow.organization_id,
        campaignId: msgRow.campaign_id ?? null,
        recipientPhone: msgRow.recipient_phone,
        messageText: msgRow.message_text,
        status: msgRow.status as SmsStatus,
        costCredits: Number(msgRow.cost_credits),
        simSlot: Number(msgRow.sim_slot),
        providerMessageId: msgRow.provider_message_id ?? null,
        gatewayProvider: msgRow.gateway_provider as any,
        attemptCount: Number(msgRow.attempt_count ?? 1),
        lastError: msgRow.last_error ?? undefined,
        deliveredAt: msgRow.delivered_at ? new Date(msgRow.delivered_at) : null,
        createdAt: new Date(msgRow.created_at),
        updatedAt: new Date(msgRow.updated_at),
      };

      return {
        job: mapOutboundSmsJobRow(jobRows[0]!),
        message,
        idempotentReplay: false,
      };
    });
  }

  /**
   * Atomically acquires leased outbound SMS jobs for an authenticated ACTIVE Android device.
   * Uses monotonic row locking (devices FOR UPDATE -> outbound_sms_jobs FOR UPDATE SKIP LOCKED)
   * so multiple concurrent API replicas never claim the same job simultaneously.
   */
  public async acquireJobsForDevice(
    deviceId: string,
    organizationId: string,
    options: AcquireOutboundSmsJobsRequest = {},
  ): Promise<AcquireOutboundSmsResult> {
    assertTenantContext({ organizationId });

    const limit = options.limit === undefined ? 1 : Math.floor(Number(options.limit));
    if (!Number.isFinite(limit) || limit < 1 || limit > 10) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'limit must be between 1 and 10');
    }

    const leaseSeconds = resolveLeaseSeconds(options.leaseSeconds);
    const availableSlots = parseSimSlotsFilter(options.availableSimSlots);

    if (!(await entitlementService.isFeatureEnabled(organizationId, FeatureKey.BULK_MESSAGING_ENABLED))) {
      return { jobs: [], relayEnabled: false, reason: 'BULK_MESSAGING_DISABLED' };
    }

    const account = await this.messagingService.getOrCreateAccount(organizationId);
    if (!account.isActive) {
      return { jobs: [], relayEnabled: false, reason: 'MESSAGING_DISABLED' };
    }

    if (availableSlots !== null && availableSlots.length === 0) {
      return { jobs: [], relayEnabled: true, reason: 'NO_AVAILABLE_SIM' };
    }

    return withTransaction(async (tx) => {
      // Lock Order: devices FIRST
      const devRows = await tx<Record<string, any>>`
        SELECT "id", "status" FROM "devices"
        WHERE "id" = ${deviceId}::uuid AND "organization_id" = ${organizationId}::uuid
        FOR UPDATE
      `;
      if (devRows.length === 0) {
        throw new HttpException(404, 'DEVICE_NOT_FOUND', 'Device not found in organization');
      }
      if (devRows[0]!.status === DeviceStatus.REVOKED) {
        throw new HttpException(403, 'DEVICE_REVOKED', 'Revoked devices cannot acquire outbound SMS jobs');
      }
      if (devRows[0]!.status !== DeviceStatus.ACTIVE) {
        throw new HttpException(403, 'DEVICE_INACTIVE', 'Device must be ACTIVE to acquire outbound SMS jobs');
      }

      // Sweep stale leases/deadlines for this organization before claiming
      await this.sweepStaleJobs(tx, organizationId);

      // Select eligible QUEUED or reclaimable CLAIMED jobs with FOR UPDATE SKIP LOCKED
      const allowSlot1 = availableSlots === null || availableSlots.includes(1);
      const allowSlot2 = availableSlots === null || availableSlots.includes(2);
      const candidateRows = await tx<Record<string, any>>`
        SELECT * FROM "outbound_sms_jobs"
        WHERE "organization_id" = ${organizationId}::uuid
          AND "expires_at" > NOW()
          AND ("assigned_device_id" IS NULL OR "assigned_device_id" = ${deviceId}::uuid)
          AND (
            ("sim_slot" = 1 AND ${allowSlot1}::boolean)
            OR ("sim_slot" = 2 AND ${allowSlot2}::boolean)
          )
          AND (
            "status" = ${OutboundSmsJobStatus.QUEUED}::"OutboundSmsJobStatus"
            OR (
              "status" = ${OutboundSmsJobStatus.CLAIMED}::"OutboundSmsJobStatus"
              AND "lease_expires_at" IS NOT NULL
              AND "lease_expires_at" <= NOW()
              AND "attempt_count" < "max_attempts"
            )
          )
        ORDER BY "created_at" ASC, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;

      const acquired: OutboundSmsJob[] = [];
      for (const row of candidateRows) {
        const leaseToken = randomBytes(24).toString('hex');
        const updatedRows = await tx<Record<string, any>>`
          UPDATE "outbound_sms_jobs"
          SET "status" = ${OutboundSmsJobStatus.CLAIMED}::"OutboundSmsJobStatus",
              "claimed_by_device_id" = ${deviceId}::uuid,
              "lease_token" = ${leaseToken},
              "lease_expires_at" = NOW() + (${leaseSeconds}::int * INTERVAL '1 second'),
              "claimed_at" = COALESCE("claimed_at", NOW()),
              "attempt_count" = "attempt_count" + 1,
              "updated_at" = NOW()
          WHERE "id" = ${row.id}::uuid
          RETURNING *
        `;
        acquired.push(mapOutboundSmsJobRow(updatedRows[0]!));
      }

      return { jobs: acquired, relayEnabled: true };
    });
  }

  /**
   * Separates job acquisition (CLAIMED) from actual cellular radio dispatch (DISPATCHING).
   * Android MUST call and receive acceptance here BEFORE invoking SmsManager.
   */
  public async markDispatching(
    deviceId: string,
    organizationId: string,
    jobId: string,
    input: StartOutboundSmsDispatchRequest,
  ): Promise<OutboundSmsJobResultResponse> {
    assertTenantContext({ organizationId });
    if (!UUID_REGEX.test(jobId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'Invalid jobId UUID');
    }
    const leaseToken = typeof input?.leaseToken === 'string' ? input.leaseToken.trim() : '';
    if (!leaseToken) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'leaseToken is required');
    }
    const requestedSlot = input.simSlot !== undefined ? resolveSimSlot(input.simSlot) : undefined;

    const outcome = await withTransaction<JobTxOutcome<OutboundSmsJobResultResponse>>(async (tx) => {
      const devRows = await tx<Record<string, any>>`
        SELECT "id", "status" FROM "devices"
        WHERE "id" = ${deviceId}::uuid AND "organization_id" = ${organizationId}::uuid
        FOR UPDATE
      `;
      if (devRows.length === 0) {
        return { kind: 'ERR', statusCode: 404, code: 'DEVICE_NOT_FOUND', message: 'Device not found' };
      }
      if (devRows[0]!.status === DeviceStatus.REVOKED) {
        return { kind: 'ERR', statusCode: 403, code: 'DEVICE_REVOKED', message: 'Revoked device cannot dispatch SMS jobs' };
      }
      if (devRows[0]!.status !== DeviceStatus.ACTIVE) {
        return { kind: 'ERR', statusCode: 403, code: 'DEVICE_INACTIVE', message: 'Device is not active' };
      }

      const jobRows = await tx<Record<string, any>>`
        SELECT * FROM "outbound_sms_jobs"
        WHERE "id" = ${jobId}::uuid
        FOR UPDATE
      `;
      if (jobRows.length === 0) {
        return { kind: 'ERR', statusCode: 404, code: 'SMS_JOB_NOT_FOUND', message: `Outbound SMS job '${jobId}' not found` };
      }

      const row = jobRows[0]!;
      if (row.organization_id !== organizationId) {
        return {
          kind: 'ERR',
          statusCode: 403,
          code: 'CROSS_ORGANIZATION_FORBIDDEN',
          message: 'Outbound SMS job belongs to a different organization',
        };
      }
      if (row.claimed_by_device_id !== deviceId) {
        return {
          kind: 'ERR',
          statusCode: 403,
          code: 'SMS_JOB_DEVICE_MISMATCH',
          message: 'Outbound SMS job is not claimed by this device',
        };
      }
      if (!row.lease_token || row.lease_token !== leaseToken) {
        return {
          kind: 'ERR',
          statusCode: 409,
          code: 'STALE_SMS_JOB_LEASE',
          message: 'Outbound SMS job lease token does not match the active claim',
        };
      }

      if (row.status === OutboundSmsJobStatus.DISPATCHING) {
        return {
          kind: 'OK',
          value: { accepted: true, idempotentReplay: true, job: mapOutboundSmsJobRow(row) },
        };
      }

      if (row.status === OutboundSmsJobStatus.CANCELLED) {
        return { kind: 'ERR', statusCode: 409, code: 'SMS_JOB_CANCELLED', message: 'Outbound SMS job was cancelled' };
      }

      const now = new Date();
      if (row.status === OutboundSmsJobStatus.EXPIRED) {
        return { kind: 'ERR', statusCode: 409, code: 'SMS_JOB_EXPIRED', message: 'Outbound SMS job has expired' };
      }

      if (row.status !== OutboundSmsJobStatus.CLAIMED) {
        return {
          kind: 'ERR',
          statusCode: 409,
          code: 'SMS_JOB_TERMINAL_CONFLICT',
          message: `Cannot enter DISPATCHING from status '${row.status}'`,
        };
      }

      if (new Date(row.expires_at).getTime() <= now.getTime()) {
        await tx`
          UPDATE "outbound_sms_jobs"
          SET "status" = ${OutboundSmsJobStatus.EXPIRED}::"OutboundSmsJobStatus",
              "failure_code" = 'JOB_EXPIRED',
              "error_message" = 'Outbound SMS job expired before dispatch started',
              "completed_at" = ${now},
              "updated_at" = ${now}
          WHERE "id" = ${jobId}::uuid
        `;
        await tx`
          UPDATE "sms_messages"
          SET "status" = ${SmsStatus.FAILED}::"SmsStatus",
              "last_error" = 'Outbound SMS job expired before dispatch started',
              "updated_at" = ${now}
          WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
        `;
        await this.refundMessageCreditOnce(tx, organizationId, row.message_id, 1);
        return { kind: 'ERR', statusCode: 409, code: 'SMS_JOB_EXPIRED', message: 'Outbound SMS job has expired' };
      }

      if (!row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= now.getTime()) {
        return {
          kind: 'ERR',
          statusCode: 409,
          code: 'STALE_SMS_JOB_LEASE',
          message: 'Claim lease has already expired; re-acquire before dispatching',
        };
      }

      const effectiveSlot = requestedSlot ?? Number(row.sim_slot ?? 1);
      const updatedRows = await tx<Record<string, any>>`
        UPDATE "outbound_sms_jobs"
        SET "status" = ${OutboundSmsJobStatus.DISPATCHING}::"OutboundSmsJobStatus",
            "sim_slot" = ${effectiveSlot},
            "dispatch_started_at" = ${now},
            "lease_expires_at" = GREATEST(
              COALESCE("lease_expires_at", ${now}),
              ${now}::timestamptz + (${DISPATCHING_LEASE_FLOOR_SECONDS}::int * INTERVAL '1 second')
            ),
            "updated_at" = ${now}
        WHERE "id" = ${jobId}::uuid
        RETURNING *
      `;

      await tx`
        UPDATE "sms_messages"
        SET "sim_slot" = ${effectiveSlot},
            "attempt_count" = ${Number(row.attempt_count || 1)},
            "updated_at" = ${now}
        WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
      `;

      return {
        kind: 'OK',
        value: { accepted: true, idempotentReplay: false, job: mapOutboundSmsJobRow(updatedRows[0]!) },
      };
    });

    if (outcome.kind === 'ERR') {
      throw new HttpException(outcome.statusCode, outcome.code, outcome.message, outcome.details);
    }
    return outcome.value;
  }

  /**
   * Reconciles cellular dispatch outcomes reported by the claiming Android device.
   * Guarantees idempotency, terminal-state immutability, no-fake-DELIVERED, and single refunds.
   */
  public async reportJobResult(
    deviceId: string,
    organizationId: string,
    jobId: string,
    input: ReportOutboundSmsJobResultRequest,
  ): Promise<OutboundSmsJobResultResponse> {
    assertTenantContext({ organizationId });
    if (!UUID_REGEX.test(jobId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'Invalid jobId UUID');
    }
    const leaseToken = typeof input?.leaseToken === 'string' ? input.leaseToken.trim() : '';
    if (!leaseToken) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'leaseToken is required');
    }
    const allowedOutcomes: OutboundSmsDispatchOutcome[] = ['SUBMITTED', 'DELIVERED', 'FAILED', 'UNCERTAIN'];
    if (!allowedOutcomes.includes(input.outcome)) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        `outcome must be one of: ${allowedOutcomes.join(', ')}`,
      );
    }

    const effectiveSlot = input.simSlot !== undefined ? resolveSimSlot(input.simSlot) : undefined;
    const radioResultCode = input.radioResultCode !== undefined && input.radioResultCode !== null
      ? Number(input.radioResultCode)
      : undefined;
    if (radioResultCode !== undefined && !Number.isInteger(radioResultCode)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'radioResultCode must be an integer');
    }

    const gatewayReference = typeof input.gatewayReference === 'string' && input.gatewayReference.trim()
      ? input.gatewayReference.trim().slice(0, 120)
      : null;
    const failureCode = typeof input.failureCode === 'string' && input.failureCode.trim()
      ? input.failureCode.trim().slice(0, 64)
      : null;
    const errorMessage = typeof input.errorMessage === 'string' && input.errorMessage.trim()
      ? input.errorMessage.trim().slice(0, 500)
      : null;

    let carrierTimestamp = new Date();
    if (input.carrierTimestamp) {
      const parsedDate = new Date(input.carrierTimestamp);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new HttpException(400, 'VALIDATION_ERROR', 'carrierTimestamp must be a valid ISO timestamp');
      }
      carrierTimestamp = parsedDate;
    }

    const outcome = await withTransaction<JobTxOutcome<OutboundSmsJobResultResponse>>(async (tx) => {
      const devRows = await tx<Record<string, any>>`
        SELECT "id", "status" FROM "devices"
        WHERE "id" = ${deviceId}::uuid AND "organization_id" = ${organizationId}::uuid
        FOR UPDATE
      `;
      if (devRows.length === 0) {
        return { kind: 'ERR', statusCode: 404, code: 'DEVICE_NOT_FOUND', message: 'Device not found' };
      }
      if (devRows[0]!.status === DeviceStatus.REVOKED) {
        return { kind: 'ERR', statusCode: 403, code: 'DEVICE_REVOKED', message: 'Revoked device cannot report SMS results' };
      }
      if (devRows[0]!.status !== DeviceStatus.ACTIVE) {
        return { kind: 'ERR', statusCode: 403, code: 'DEVICE_INACTIVE', message: 'Device is not active' };
      }

      const jobRows = await tx<Record<string, any>>`
        SELECT * FROM "outbound_sms_jobs"
        WHERE "id" = ${jobId}::uuid
        FOR UPDATE
      `;
      if (jobRows.length === 0) {
        return { kind: 'ERR', statusCode: 404, code: 'SMS_JOB_NOT_FOUND', message: `Outbound SMS job '${jobId}' not found` };
      }

      const row = jobRows[0]!;
      if (row.organization_id !== organizationId) {
        return {
          kind: 'ERR',
          statusCode: 403,
          code: 'CROSS_ORGANIZATION_FORBIDDEN',
          message: 'Outbound SMS job belongs to a different organization',
        };
      }
      if (row.claimed_by_device_id !== deviceId) {
        return {
          kind: 'ERR',
          statusCode: 403,
          code: 'SMS_JOB_DEVICE_MISMATCH',
          message: 'Outbound SMS job is not claimed by this device',
        };
      }
      if (!row.lease_token || row.lease_token !== leaseToken) {
        return {
          kind: 'ERR',
          statusCode: 409,
          code: 'STALE_SMS_JOB_LEASE',
          message: 'Outbound SMS job lease token does not match the active claim',
        };
      }

      const msgRows = await tx<Record<string, any>>`
        SELECT * FROM "sms_messages"
        WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
        FOR UPDATE
      `;
      const msgRow = msgRows[0];
      const costCredits = Number(msgRow?.cost_credits ?? 1);
      const gwProvider = String(msgRow?.gateway_provider ?? 'ANDROID_COMPANION');
      const currentStatus = row.status as OutboundSmsJobStatus;

      // Idempotent replays and terminal state guards
      if (currentStatus === OutboundSmsJobStatus.DELIVERED) {
        if (input.outcome === 'DELIVERED') {
          return { kind: 'OK', value: { accepted: true, idempotentReplay: true, job: mapOutboundSmsJobRow(row) } };
        }
        return {
          kind: 'ERR',
          statusCode: 409,
          code: 'SMS_JOB_TERMINAL_CONFLICT',
          message: `Cannot transition already DELIVERED job to '${input.outcome}'`,
        };
      }

      if (currentStatus === OutboundSmsJobStatus.FAILED) {
        if (input.outcome === 'FAILED') {
          return { kind: 'OK', value: { accepted: true, idempotentReplay: true, job: mapOutboundSmsJobRow(row) } };
        }
        return {
          kind: 'ERR',
          statusCode: 409,
          code: 'SMS_JOB_TERMINAL_CONFLICT',
          message: `Cannot transition already FAILED job to '${input.outcome}'`,
        };
      }

      if (currentStatus === OutboundSmsJobStatus.EXPIRED || currentStatus === OutboundSmsJobStatus.CANCELLED) {
        return {
          kind: 'ERR',
          statusCode: 409,
          code: currentStatus === OutboundSmsJobStatus.EXPIRED ? 'SMS_JOB_EXPIRED' : 'SMS_JOB_CANCELLED',
          message: `Cannot submit result for job in status '${currentStatus}'`,
        };
      }

      if (currentStatus === OutboundSmsJobStatus.QUEUED) {
        return {
          kind: 'ERR',
          statusCode: 409,
          code: 'SMS_JOB_NOT_CLAIMED',
          message: 'Job has not been claimed by this device',
        };
      }

      if (currentStatus === OutboundSmsJobStatus.CLAIMED) {
        if (!(input.outcome === 'FAILED' && input.preRadioFailure === true)) {
          return {
            kind: 'ERR',
            statusCode: 409,
            code: 'SMS_JOB_DISPATCH_NOT_STARTED',
            message: 'Dispatch intent (/dispatching) must be recorded before reporting radio dispatch results',
          };
        }
      }

      if (currentStatus === OutboundSmsJobStatus.SUBMITTED) {
        if (input.outcome === 'SUBMITTED') {
          return { kind: 'OK', value: { accepted: true, idempotentReplay: true, job: mapOutboundSmsJobRow(row) } };
        }
        if (input.outcome !== 'DELIVERED') {
          return {
            kind: 'ERR',
            statusCode: 409,
            code: 'SMS_JOB_TERMINAL_CONFLICT',
            message: `Cannot transition SUBMITTED job to '${input.outcome}'`,
          };
        }
      }

      if (currentStatus === OutboundSmsJobStatus.UNCERTAIN) {
        if (input.outcome === 'UNCERTAIN') {
          return { kind: 'OK', value: { accepted: true, idempotentReplay: true, job: mapOutboundSmsJobRow(row) } };
        }
        if (input.outcome === 'FAILED' && input.preRadioFailure !== true && radioResultCode === undefined) {
          return {
            kind: 'ERR',
            statusCode: 409,
            code: 'SMS_JOB_TERMINAL_CONFLICT',
            message: 'UNCERTAIN job cannot be refunded without preRadioFailure or explicit carrier radioResultCode',
          };
        }
      }

      const now = new Date();
      const targetSlot = effectiveSlot ?? Number(row.sim_slot ?? 1);
      const rawResultPayload = {
        outcome: input.outcome,
        simSlot: targetSlot,
        partsCount: input.partsCount ?? null,
        radioResultCode: radioResultCode ?? null,
        failureCode,
        preRadioFailure: Boolean(input.preRadioFailure),
      };

      if (input.outcome === 'SUBMITTED') {
        const updatedRows = await tx<Record<string, any>>`
          UPDATE "outbound_sms_jobs"
          SET "status" = ${OutboundSmsJobStatus.SUBMITTED}::"OutboundSmsJobStatus",
              "sim_slot" = ${targetSlot},
              "submitted_at" = COALESCE("submitted_at", ${carrierTimestamp}),
              "gateway_reference" = COALESCE(${gatewayReference}, "gateway_reference"),
              "radio_result_code" = COALESCE(${radioResultCode ?? null}::int, "radio_result_code"),
              "error_message" = NULL,
              "failure_code" = NULL,
              "last_result_payload" = ${JSON.stringify(rawResultPayload)}::text::jsonb,
              "updated_at" = ${now}
          WHERE "id" = ${jobId}::uuid
          RETURNING *
        `;
        await tx`
          UPDATE "sms_messages"
          SET "status" = ${SmsStatus.SUBMITTED}::"SmsStatus",
              "sim_slot" = ${targetSlot},
              "provider_message_id" = COALESCE(${gatewayReference}, "provider_message_id"),
              "last_error" = NULL,
              "updated_at" = ${now}
          WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
        `;
        await this.recordDeliveryAttempt(tx, {
          organizationId,
          messageId: row.message_id,
          attemptNumber: Number(row.attempt_count || 1),
          gatewayProvider: gwProvider,
          gatewayReference,
          status: SmsStatus.SUBMITTED,
          rawResponse: rawResultPayload,
        });
        return {
          kind: 'OK',
          value: { accepted: true, idempotentReplay: false, job: mapOutboundSmsJobRow(updatedRows[0]!) },
        };
      }

      if (input.outcome === 'DELIVERED') {
        const updatedRows = await tx<Record<string, any>>`
          UPDATE "outbound_sms_jobs"
          SET "status" = ${OutboundSmsJobStatus.DELIVERED}::"OutboundSmsJobStatus",
              "sim_slot" = ${targetSlot},
              "submitted_at" = COALESCE("submitted_at", ${carrierTimestamp}),
              "delivered_at" = ${carrierTimestamp},
              "completed_at" = ${now},
              "gateway_reference" = COALESCE(${gatewayReference}, "gateway_reference"),
              "radio_result_code" = COALESCE(${radioResultCode ?? null}::int, "radio_result_code"),
              "error_message" = NULL,
              "failure_code" = NULL,
              "last_result_payload" = ${JSON.stringify(rawResultPayload)}::text::jsonb,
              "updated_at" = ${now}
          WHERE "id" = ${jobId}::uuid
          RETURNING *
        `;
        await tx`
          UPDATE "sms_messages"
          SET "status" = ${SmsStatus.DELIVERED}::"SmsStatus",
              "sim_slot" = ${targetSlot},
              "provider_message_id" = COALESCE(${gatewayReference}, "provider_message_id"),
              "delivered_at" = ${carrierTimestamp},
              "last_error" = NULL,
              "updated_at" = ${now}
          WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
        `;
        await this.recordDeliveryAttempt(tx, {
          organizationId,
          messageId: row.message_id,
          attemptNumber: Number(row.attempt_count || 1),
          gatewayProvider: gwProvider,
          gatewayReference,
          status: SmsStatus.DELIVERED,
          rawResponse: rawResultPayload,
        });
        return {
          kind: 'OK',
          value: { accepted: true, idempotentReplay: false, job: mapOutboundSmsJobRow(updatedRows[0]!) },
        };
      }

      if (input.outcome === 'FAILED') {
        const reasonText = errorMessage || 'Android cellular dispatch failed';
        const updatedRows = await tx<Record<string, any>>`
          UPDATE "outbound_sms_jobs"
          SET "status" = ${OutboundSmsJobStatus.FAILED}::"OutboundSmsJobStatus",
              "sim_slot" = ${targetSlot},
              "radio_result_code" = COALESCE(${radioResultCode ?? null}::int, "radio_result_code"),
              "failure_code" = COALESCE(${failureCode}, 'CARRIER_DISPATCH_FAILED'),
              "error_message" = ${reasonText},
              "completed_at" = ${now},
              "last_result_payload" = ${JSON.stringify(rawResultPayload)}::text::jsonb,
              "updated_at" = ${now}
          WHERE "id" = ${jobId}::uuid
          RETURNING *
        `;
        await tx`
          UPDATE "sms_messages"
          SET "status" = ${SmsStatus.FAILED}::"SmsStatus",
              "sim_slot" = ${targetSlot},
              "last_error" = ${reasonText},
              "updated_at" = ${now}
          WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
        `;
        await this.recordDeliveryAttempt(tx, {
          organizationId,
          messageId: row.message_id,
          attemptNumber: Number(row.attempt_count || 1),
          gatewayProvider: gwProvider,
          status: SmsStatus.FAILED,
          errorMessage: reasonText,
          rawResponse: rawResultPayload,
        });
        await this.refundMessageCreditOnce(tx, organizationId, row.message_id, costCredits);
        return {
          kind: 'OK',
          value: { accepted: true, idempotentReplay: false, job: mapOutboundSmsJobRow(updatedRows[0]!) },
        };
      }

      // outcome === 'UNCERTAIN': record explicitly, preserve credit deduction, never auto-requeue
      const uncertainMsg = errorMessage || 'GATEWAY_UNCERTAIN: cellular dispatch outcome unknown';
      const updatedRows = await tx<Record<string, any>>`
        UPDATE "outbound_sms_jobs"
        SET "status" = ${OutboundSmsJobStatus.UNCERTAIN}::"OutboundSmsJobStatus",
            "sim_slot" = ${targetSlot},
            "failure_code" = COALESCE(${failureCode}, 'DISPATCH_OUTCOME_UNCERTAIN'),
            "error_message" = ${uncertainMsg},
            "last_result_payload" = ${JSON.stringify(rawResultPayload)}::text::jsonb,
            "updated_at" = ${now}
        WHERE "id" = ${jobId}::uuid
        RETURNING *
      `;
      await tx`
        UPDATE "sms_messages"
        SET "last_error" = ${uncertainMsg},
            "updated_at" = ${now}
        WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
      `;
      return {
        kind: 'OK',
        value: { accepted: true, idempotentReplay: false, job: mapOutboundSmsJobRow(updatedRows[0]!) },
      };
    });

    if (outcome.kind === 'ERR') {
      throw new HttpException(outcome.statusCode, outcome.code, outcome.message, outcome.details);
    }
    return outcome.value;
  }

  public async listJobs(
    organizationId: string,
    filters: { status?: OutboundSmsJobStatus; deviceId?: string; limit?: number } = {},
  ): Promise<OutboundSmsJob[]> {
    assertTenantContext({ organizationId });
    const limit = Math.min(Math.max(Math.floor(filters.limit ?? 50), 1), 200);
    const status = filters.status ?? null;
    const deviceId = filters.deviceId ?? null;

    const rows = await sql<Record<string, any>>`
      SELECT * FROM "outbound_sms_jobs"
      WHERE "organization_id" = ${organizationId}::uuid
        AND (${status}::"OutboundSmsJobStatus" IS NULL OR "status" = ${status}::"OutboundSmsJobStatus")
        AND (
          ${deviceId}::uuid IS NULL
          OR "assigned_device_id" = ${deviceId}::uuid
          OR "claimed_by_device_id" = ${deviceId}::uuid
        )
      ORDER BY "created_at" DESC
      LIMIT ${limit}
    `;
    return rows.map(mapOutboundSmsJobRow);
  }

  public async getJobById(organizationId: string, jobId: string): Promise<OutboundSmsJob> {
    assertTenantContext({ organizationId });
    if (!UUID_REGEX.test(jobId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'Invalid jobId UUID');
    }

    const rows = await sql<Record<string, any>>`
      SELECT * FROM "outbound_sms_jobs"
      WHERE "id" = ${jobId}::uuid
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new HttpException(404, 'SMS_JOB_NOT_FOUND', `Outbound SMS job '${jobId}' not found`);
    }
    if (rows[0]!.organization_id !== organizationId) {
      throw new HttpException(403, 'CROSS_ORGANIZATION_FORBIDDEN', 'Outbound SMS job belongs to another organization');
    }
    return mapOutboundSmsJobRow(rows[0]!);
  }

  /**
   * Cancels an un-dispatched outbound SMS job (QUEUED only) and refunds credit atomically.
   */
  public async cancelJob(organizationId: string, jobId: string, reason?: string): Promise<OutboundSmsJob> {
    assertTenantContext({ organizationId });
    if (!UUID_REGEX.test(jobId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'Invalid jobId UUID');
    }

    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM "outbound_sms_jobs"
        WHERE "id" = ${jobId}::uuid
        FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new HttpException(404, 'SMS_JOB_NOT_FOUND', `Outbound SMS job '${jobId}' not found`);
      }
      const row = rows[0]!;
      if (row.organization_id !== organizationId) {
        throw new HttpException(403, 'CROSS_ORGANIZATION_FORBIDDEN', 'Outbound SMS job belongs to another organization');
      }
      if (row.status === OutboundSmsJobStatus.CANCELLED) {
        return mapOutboundSmsJobRow(row);
      }
      if (row.status !== OutboundSmsJobStatus.QUEUED) {
        throw new HttpException(
          409,
          'SMS_JOB_CANNOT_CANCEL',
          `Cannot cancel outbound SMS job in status '${row.status}'`,
        );
      }

      const now = new Date();
      const cancelReason = (reason && reason.trim()) || 'Cancelled by organization operator';
      const updatedRows = await tx<Record<string, any>>`
        UPDATE "outbound_sms_jobs"
        SET "status" = ${OutboundSmsJobStatus.CANCELLED}::"OutboundSmsJobStatus",
            "failure_code" = 'CANCELLED',
            "error_message" = ${cancelReason},
            "completed_at" = ${now},
            "updated_at" = ${now}
        WHERE "id" = ${jobId}::uuid
        RETURNING *
      `;
      await tx`
        UPDATE "sms_messages"
        SET "status" = ${SmsStatus.FAILED}::"SmsStatus",
            "last_error" = ${cancelReason},
            "updated_at" = ${now}
        WHERE "id" = ${row.message_id}::uuid AND "organization_id" = ${organizationId}::uuid
      `;
      await this.refundMessageCreditOnce(tx, organizationId, row.message_id, 1);
      return mapOutboundSmsJobRow(updatedRows[0]!);
    });
  }
}

export const outboundSmsJobService = new OutboundSmsJobService();
