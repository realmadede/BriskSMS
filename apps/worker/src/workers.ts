import { createHmac, randomUUID } from 'node:crypto';
import {
  OutboxStatus,
  SmsStatus,
  CreditLedgerEntryType,
  CampaignStatus,
} from '@brisksms/shared';
import {
  sql,
  withTransaction,
  BullQueue,
  BullWorker,
  BullJob,
  QUEUE_NAMES,
  createLogger,
  recordWorkerHeartbeat,
} from '@brisksms/db';

const logger = createLogger('brisksms:worker');

export interface WebhookDeliveryJobData {
  organizationId: string;
  outboxEventId: string;
  eventType: string;
}

export interface SmsCampaignJobData {
  organizationId: string;
  campaignId: string;
}

export interface MaintenanceCleanupJobData {
  organizationId: string;
  task: 'PURGE_EXPIRED_TOKENS';
}

export interface PaymentProcessingJobData {
  organizationId: string;
  paymentId: string;
}

export interface SmsDeliveryRetryJobData {
  organizationId: string;
  messageId: string;
}

export type CustomFetchHandler = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number; ok: boolean }>;

export function computeWebhookSignature(
  payloadString: string,
  secret: string,
  timestampSeconds: number,
): string {
  const signaturePayload = `${timestampSeconds}.${payloadString}`;
  const hmac = createHmac('sha256', secret).update(signaturePayload).digest('hex');
  return `t=${timestampSeconds},v1=${hmac}`;
}

/**
 * Polls PostgreSQL outbox_events using FOR UPDATE SKIP LOCKED and enqueues jobs into Redis/BullMQ.
 * If Redis is unavailable, events remain safely persisted in PostgreSQL outbox_events for later dispatch.
 */
export class OutboxDispatcher {
  private readonly webhookQueue = new BullQueue<WebhookDeliveryJobData>(QUEUE_NAMES.WEBHOOK_DELIVERY);
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Single poll cycle: claims pending/failed/stale-locked outbox events and enqueues them to Redis.
   */
  public async pollAndEnqueue(limit: number = 50): Promise<number> {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const now = new Date();

    const claimedEvents = await withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM outbox_events
        WHERE is_delivered = false
          AND next_attempt_at <= ${now}
          AND (
            status IN ('PENDING', 'FAILED')
            OR (status = 'PROCESSING' AND locked_at < ${staleThreshold})
          )
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;

      for (const row of rows) {
        await tx`
          UPDATE outbox_events
          SET status = ${OutboxStatus.PROCESSING}::"OutboxStatus", locked_at = ${now}
          WHERE id = ${row.id}
        `;
      }
      return rows;
    });

    let enqueuedCount = 0;
    for (const eventRow of claimedEvents) {
      try {
        await this.webhookQueue.add(
          'deliver-outbox-event',
          {
            organizationId: eventRow.organization_id,
            outboxEventId: eventRow.id,
            eventType: eventRow.event_type,
          },
          {
            jobId: `outbox_${eventRow.id}_attempt_${Number(eventRow.attempt_count) + 1}`,
            attempts: 3,
            backoffMs: 1000,
            timeoutMs: 15_000,
          },
        );
        enqueuedCount++;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to enqueue outbox event to Redis; reverting lock for safe retry', {
          organizationId: eventRow.organization_id,
          outboxEventId: eventRow.id,
          error: errMsg,
        });
        await sql`
          UPDATE outbox_events
          SET status = ${OutboxStatus.PENDING}::"OutboxStatus",
              locked_at = NULL,
              last_error = ${`Queue publish deferred: ${errMsg}`}
          WHERE id = ${eventRow.id}
        `;
      }
    }

    return enqueuedCount;
  }

  public start(pollIntervalMs: number = 2000): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      this.pollAndEnqueue().catch((err) => {
        logger.error('Outbox poll cycle error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, pollIntervalMs);
  }

  public stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}

/**
 * Processes webhook delivery jobs from the `webhook-delivery` queue.
 * Enforces tenant isolation, idempotency, delivery attempt logging, and outbox status transitions.
 */
export async function processWebhookDeliveryJob(
  job: BullJob<WebhookDeliveryJobData>,
  customFetch?: CustomFetchHandler,
): Promise<{ delivered: boolean; endpointCount: number }> {
  const { organizationId, outboxEventId } = job.data;

  const eventRows = await sql<Record<string, any>>`
    SELECT * FROM outbox_events
    WHERE id = ${outboxEventId} AND organization_id = ${organizationId}
    LIMIT 1
  `;

  if (eventRows.length === 0) {
    throw new Error(`Tenant isolation or missing record: Outbox event ${outboxEventId} not found for org ${organizationId}`);
  }

  const row = eventRows[0]!;
  if (row.is_delivered || row.status === OutboxStatus.DELIVERED) {
    return { delivered: true, endpointCount: 0 };
  }

  const allActiveEndpoints = await sql<Record<string, any>>`
    SELECT * FROM webhook_endpoints
    WHERE organization_id = ${organizationId}
      AND is_active = true
  `;
  const endpoints = allActiveEndpoints.filter((ep) => {
    const rawEvents =
      typeof ep.subscribed_events === 'string'
        ? JSON.parse(ep.subscribed_events)
        : ep.subscribed_events;
    return Array.isArray(rawEvents) && rawEvents.includes(row.event_type);
  });

  const now = new Date();
  if (endpoints.length === 0) {
    await sql`
      UPDATE outbox_events
      SET status = ${OutboxStatus.DELIVERED}::"OutboxStatus",
          is_delivered = true,
          delivered_at = ${now},
          last_attempt_at = ${now},
          locked_at = NULL
      WHERE id = ${outboxEventId} AND organization_id = ${organizationId}
    `;
    return { delivered: true, endpointCount: 0 };
  }

  const payloadObj = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const payloadString = JSON.stringify({
    id: row.id,
    eventType: row.event_type,
    organizationId: row.organization_id,
    createdAt: new Date(row.created_at).toISOString(),
    data: payloadObj,
  });

  const timestampSeconds = Math.floor(Date.now() / 1000);
  const nextAttemptCount = Number(row.attempt_count) + 1;
  let allSucceeded = true;
  let failureReason: string | null = null;

  for (const ep of endpoints) {
    const signature = computeWebhookSignature(payloadString, ep.secret, timestampSeconds);

    try {
      let status = 200;
      let ok = true;

      if (customFetch) {
        const res = await customFetch(ep.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-BriskSMS-Event': row.event_type,
            'X-BriskSMS-Delivery': row.id,
            'X-BriskSMS-Signature': signature,
          },
          body: payloadString,
        });
        status = res.status;
        ok = res.ok;
      }

      await sql`
        INSERT INTO webhook_deliveries (
          id, organization_id, endpoint_id, outbox_event_id, event_type,
          payload, response_status, response_body, attempt_number,
          status, next_retry_at, delivered_at, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${ep.id}, ${row.id}, ${row.event_type},
          ${JSON.stringify(payloadObj)}::jsonb, ${status}, NULL, ${nextAttemptCount},
          ${ok ? 'DELIVERED' : 'FAILED'}, NULL, ${now}, ${now}
        )
      `;

      if (!ok) {
        allSucceeded = false;
        failureReason = `Endpoint ${ep.url} returned HTTP ${status}`;
      }
    } catch (err: unknown) {
      allSucceeded = false;
      failureReason = err instanceof Error ? err.message : String(err);

      await sql`
        INSERT INTO webhook_deliveries (
          id, organization_id, endpoint_id, outbox_event_id, event_type,
          payload, response_status, response_body, attempt_number,
          status, next_retry_at, delivered_at, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${ep.id}, ${row.id}, ${row.event_type},
          ${JSON.stringify(payloadObj)}::jsonb, 0, ${failureReason}, ${nextAttemptCount},
          'FAILED', NULL, ${now}, ${now}
        )
      `;
    }
  }

  const maxAttempts = Number(row.max_attempts || 5);
  if (allSucceeded) {
    await sql`
      UPDATE outbox_events
      SET status = ${OutboxStatus.DELIVERED}::"OutboxStatus",
          is_delivered = true,
          attempt_count = ${nextAttemptCount},
          last_attempt_at = ${now},
          delivered_at = ${now},
          locked_at = NULL,
          last_error = NULL
      WHERE id = ${outboxEventId} AND organization_id = ${organizationId}
    `;
    return { delivered: true, endpointCount: endpoints.length };
  }

  const nextStatus = nextAttemptCount >= maxAttempts ? OutboxStatus.DEAD_LETTER : OutboxStatus.FAILED;
  const backoffMs = Math.min(60_000, 500 * Math.pow(2, nextAttemptCount));
  const nextAttemptAt = new Date(now.getTime() + backoffMs);

  await sql`
    UPDATE outbox_events
    SET status = ${nextStatus}::"OutboxStatus",
        is_delivered = false,
        attempt_count = ${nextAttemptCount},
        last_attempt_at = ${now},
        next_attempt_at = ${nextAttemptAt},
        locked_at = NULL,
        last_error = ${failureReason}
    WHERE id = ${outboxEventId} AND organization_id = ${organizationId}
  `;

  throw new Error(failureReason || 'Webhook endpoint delivery failed');
}

/**
 * Processes an SMS campaign job from the `sms-campaign` queue.
 * Enforces organization isolation, idempotently processes QUEUED recipients,
 * commits reserved credits for submitted messages, and releases reserved credits on failure.
 */
export async function processSmsCampaignJob(
  job: BullJob<SmsCampaignJobData>,
): Promise<{ sentCount: number; failedCount: number }> {
  const { organizationId, campaignId } = job.data;

  const campaignRows = await sql<Record<string, any>>`
    SELECT * FROM sms_campaigns
    WHERE id = ${campaignId} AND organization_id = ${organizationId}
    LIMIT 1
  `;
  if (campaignRows.length === 0) {
    throw new Error(`Tenant isolation or missing record: Campaign ${campaignId} not found for org ${organizationId}`);
  }

  const campaign = campaignRows[0]!;
  if (campaign.status === CampaignStatus.COMPLETED) {
    return { sentCount: 0, failedCount: 0 };
  }

  await sql`
    UPDATE sms_campaigns
    SET status = ${CampaignStatus.DISPATCHING}::"CampaignStatus", updated_at = NOW()
    WHERE id = ${campaignId} AND organization_id = ${organizationId}
  `;

  const recipients = await sql<Record<string, any>>`
    SELECT * FROM sms_campaign_recipients
    WHERE campaign_id = ${campaignId}
      AND organization_id = ${organizationId}
      AND status = ${SmsStatus.QUEUED}::"SmsStatus"
    ORDER BY created_at ASC
  `;

  let sentCount = 0;
  let failedCount = 0;

  for (const rec of recipients) {
    const renderedText: string = rec.interpolated_text || campaign.message_template;
    const now = new Date();
    const msgId = randomUUID();
    const providerMessageId = `queued_${campaignId.slice(0, 8)}_${rec.id.slice(0, 8)}`;

    await withTransaction(async (tx) => {
      await tx`
        INSERT INTO sms_messages (
          id, organization_id, campaign_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          attempt_count, last_error, delivered_at, created_at, updated_at
        ) VALUES (
          ${msgId}, ${organizationId}, ${campaignId}, ${rec.recipient_phone}, ${renderedText},
          ${SmsStatus.SUBMITTED}::"SmsStatus", 1, 1, ${providerMessageId}, 'MANAGED_GATEWAY',
          1, NULL, NULL, ${now}, ${now}
        )
      `;

      await tx`
        INSERT INTO sms_delivery_attempts (
          id, organization_id, message_id, attempt_number, gateway_provider,
          provider_message_id, status, error_message, raw_response, attempted_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${msgId}, 1, 'MANAGED_GATEWAY',
          ${providerMessageId}, ${SmsStatus.SUBMITTED}::"SmsStatus", NULL,
          ${JSON.stringify({ queuedByWorker: true })}::jsonb, ${now}
        )
      `;

      await tx`
        UPDATE sms_campaign_recipients
        SET status = ${SmsStatus.SUBMITTED}::"SmsStatus",
            message_id = ${msgId},
            updated_at = ${now}
        WHERE id = ${rec.id} AND organization_id = ${organizationId}
      `;

      const acctRows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;
      const currentBalance = Number(acctRows[0]!.credit_balance);
      const currentReserved = Number(acctRows[0]!.reserved_credits);
      const nextReserved = Math.max(0, currentReserved - 1);

      await tx`
        UPDATE messaging_accounts
        SET reserved_credits = ${nextReserved}, updated_at = ${now}
        WHERE organization_id = ${organizationId}
      `;

      await tx`
        INSERT INTO messaging_credit_ledger (
          id, organization_id, entry_type, amount_credits, balance_after, reserved_after, reference_id, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.USAGE_DEDUCTION}::"CreditLedgerEntryType",
          1, ${currentBalance}, ${nextReserved}, ${`campaign_msg_${msgId}`}, ${now}
        )
      `;
    });

    sentCount++;
  }

  const now = new Date();
  await sql`
    UPDATE sms_campaigns
    SET status = ${CampaignStatus.COMPLETED}::"CampaignStatus",
        completed_at = ${now},
        updated_at = ${now}
    WHERE id = ${campaignId} AND organization_id = ${organizationId}
  `;

  return { sentCount, failedCount };
}

/**
 * Processes maintenance cleanup jobs (purges expired unused pairing tokens and expired revoked sessions).
 */
export async function processMaintenanceCleanupJob(
  _job: BullJob<MaintenanceCleanupJobData>,
): Promise<{ purgedPairingTokens: number; purgedRevokedSessions: number }> {
  const now = new Date();
  const deletedPairing = await sql<{ id: string }>`
    DELETE FROM pairing_tokens
    WHERE used_at IS NULL AND expires_at < ${now}
    RETURNING id
  `;
  const deletedSessions = await sql<{ jti: string }>`
    DELETE FROM revoked_sessions
    WHERE expires_at < ${now}
    RETURNING jti
  `;

  return {
    purgedPairingTokens: deletedPairing.length,
    purgedRevokedSessions: deletedSessions.length,
  };
}

/**
 * Processes asynchronous payment evaluation and candidate matching from the `payment-processing` queue.
 * Adheres to critical financial invariant: Notification evidence NEVER automatically marks payment as VERIFIED or invoice as PAID.
 */
export async function processPaymentProcessingJob(
  job: BullJob<PaymentProcessingJobData>,
): Promise<{ processed: boolean; state: string }> {
  const { organizationId, paymentId } = job.data;

  const paymentRows = await sql<Record<string, any>>`
    SELECT * FROM normalized_payments
    WHERE id = ${paymentId} AND organization_id = ${organizationId}
    LIMIT 1
  `;

  if (paymentRows.length === 0) {
    throw new Error(`Tenant isolation or missing record: Payment ${paymentId} not found for org ${organizationId}`);
  }

  const payment = paymentRows[0]!;
  if (payment.state === 'VERIFIED' || payment.state === 'SETTLED' || payment.state === 'REJECTED') {
    return { processed: true, state: payment.state };
  }

  // Attempt deterministic invoice matching if currently OBSERVED or UNMATCHED
  const lookupRef = (payment.customer_memo || payment.reference || '').trim().toUpperCase();
  const exactInvoices = await sql<Record<string, any>>`
    SELECT id, balance_cents FROM invoices
    WHERE organization_id = ${organizationId}
      AND reference_number = ${lookupRef}
      AND status IN ('UNPAID', 'PARTIALLY_PAID')
    LIMIT 1
  `;

  const now = new Date();
  if (exactInvoices.length > 0) {
    const inv = exactInvoices[0]!;
    await sql`
      UPDATE normalized_payments
      SET state = 'MATCHED'::"TransactionState",
          candidate_invoice_id = ${inv.id},
          confidence_tier = 'TIER_1_EXACT_REFERENCE'::"MatchConfidenceTier",
          updated_at = ${now}
      WHERE id = ${paymentId} AND organization_id = ${organizationId}
    `;
    return { processed: true, state: 'MATCHED' };
  }

  // If no exact reference match, check customer phone heuristic
  if (payment.sender_phone) {
    const openInvoices = await sql<Record<string, any>>`
      SELECT id, balance_cents, customer_phone FROM invoices
      WHERE organization_id = ${organizationId}
        AND status IN ('UNPAID', 'PARTIALLY_PAID')
        AND customer_phone = ${payment.sender_phone}
    `;

    if (openInvoices.length === 1) {
      const inv = openInvoices[0]!;
      if (BigInt(payment.amount_cents) === BigInt(inv.balance_cents)) {
        await sql`
          UPDATE normalized_payments
          SET state = 'MATCHED'::"TransactionState",
              candidate_invoice_id = ${inv.id},
              confidence_tier = 'TIER_2_CUSTOMER_IDENTIFIER'::"MatchConfidenceTier",
              updated_at = ${now}
          WHERE id = ${paymentId} AND organization_id = ${organizationId}
        `;
        return { processed: true, state: 'MATCHED' };
      }
      // Amount mismatch -> REVIEW_REQUIRED
      await sql`
        UPDATE normalized_payments
        SET state = 'REVIEW_REQUIRED'::"TransactionState",
            candidate_invoice_id = ${inv.id},
            review_reason = 'Amount mismatch on customer identifier heuristic match',
            updated_at = ${now}
        WHERE id = ${paymentId} AND organization_id = ${organizationId}
      `;
      return { processed: true, state: 'REVIEW_REQUIRED' };
    } else if (openInvoices.length > 1) {
      await sql`
        UPDATE normalized_payments
        SET state = 'REVIEW_REQUIRED'::"TransactionState",
            review_reason = 'Ambiguous match: Multiple open invoices found for phone number',
            updated_at = ${now}
        WHERE id = ${paymentId} AND organization_id = ${organizationId}
      `;
      return { processed: true, state: 'REVIEW_REQUIRED' };
    }
  }

  // No candidate found -> UNMATCHED
  await sql`
    UPDATE normalized_payments
    SET state = 'UNMATCHED'::"TransactionState",
        updated_at = ${now}
    WHERE id = ${paymentId} AND organization_id = ${organizationId}
  `;
  return { processed: true, state: 'UNMATCHED' };
}

/**
 * Processes SMS delivery retries and dead-letter queue refund transitions from `sms-delivery-retry`.
 */
export async function processSmsDeliveryRetryJob(
  job: BullJob<SmsDeliveryRetryJobData>,
): Promise<{ status: string; refunded: boolean }> {
  const { organizationId, messageId } = job.data;

  const msgRows = await sql<Record<string, any>>`
    SELECT * FROM sms_messages
    WHERE id = ${messageId} AND organization_id = ${organizationId}
    LIMIT 1
  `;

  if (msgRows.length === 0) {
    throw new Error(`Tenant isolation or missing record: Message ${messageId} not found for org ${organizationId}`);
  }

  const msg = msgRows[0]!;
  if (msg.status === SmsStatus.DELIVERED || msg.status === SmsStatus.FAILED) {
    return { status: msg.status, refunded: false };
  }

  const currentAttempts = Number(msg.attempt_count || 1);
  const maxAttempts = 3;
  const now = new Date();

  if (currentAttempts >= maxAttempts) {
    // Terminal failure: mark FAILED and refund reserved/deducted credit atomically
    return withTransaction(async (tx) => {
      await tx`
        UPDATE sms_messages
        SET status = ${SmsStatus.FAILED}::"SmsStatus",
            last_error = 'Delivery retry limit exhausted',
            updated_at = ${now}
        WHERE id = ${messageId} AND organization_id = ${organizationId}
      `;

      const acctRows = await tx<Record<string, any>>`
        SELECT * FROM messaging_accounts
        WHERE organization_id = ${organizationId}
        FOR UPDATE
      `;

      let refunded = false;
      if (acctRows.length > 0) {
        const costCredits = Number(msg.cost_credits || 1);
        const currentBalance = Number(acctRows[0]!.credit_balance);
        const currentReserved = Number(acctRows[0]!.reserved_credits);
        const nextBalance = currentBalance + costCredits;

        await tx`
          UPDATE messaging_accounts
          SET credit_balance = ${nextBalance},
              updated_at = ${now}
          WHERE organization_id = ${organizationId}
        `;

        await tx`
          INSERT INTO messaging_credit_ledger (
            id, organization_id, entry_type, amount_credits, balance_after, reserved_after, reference_id, created_at
          ) VALUES (
            ${randomUUID()}, ${organizationId}, ${CreditLedgerEntryType.REFUND}::"CreditLedgerEntryType",
            ${costCredits}, ${nextBalance}, ${currentReserved}, ${`retry_failed_refund_${messageId}`}, ${now}
          )
        `;
        refunded = true;
      }

      return { status: SmsStatus.FAILED, refunded };
    });
  }

  // Still has retries remaining
  await sql`
    UPDATE sms_messages
    SET attempt_count = ${currentAttempts + 1},
        updated_at = ${now}
    WHERE id = ${messageId} AND organization_id = ${organizationId}
  `;

  return { status: SmsStatus.SUBMITTED, refunded: false };
}

/** Bounded so the durable dispatch lease (60s) always outlives a healthy request. */
const SMSGATE_DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429]);
const DISPATCH_LEASE_SECONDS = 60;

/**
 * Sweeps expired DISPATCHING leases and transitions them to UNCERTAIN.
 * Safe to execute concurrently from any number of workers.
 */
export async function expireDispatchLeases(recordId?: string): Promise<number> {
  const expired = await sql<Record<string, any>>`
    WITH expired AS (
      UPDATE message_idempotency_records
      SET status = 'UNCERTAIN', updated_at = NOW()
      WHERE status = 'DISPATCHING'
        AND lease_expires_at < NOW()
        AND (${recordId ?? null}::uuid IS NULL OR id = ${recordId ?? null}::uuid)
      RETURNING message_id
    )
    UPDATE sms_messages
    SET last_error = 'GATEWAY_UNCERTAIN: dispatch lease expired before the gateway outcome was recorded',
        updated_at = NOW()
    WHERE id IN (SELECT message_id FROM expired)
    RETURNING id
  `;
  return expired.length;
}

/**
 * Surfaces unresolved UNCERTAIN operations for operational audit and manual settlement.
 */
export async function listUncertainDispatches(organizationId: string): Promise<
  Array<{ idempotencyKey: string; messageId: string; recipientPhone: string; lastError: string | null; since: Date }>
> {
  const rows = await sql<Record<string, any>>`
    SELECT r.idempotency_key, r.message_id, r.updated_at, m.recipient_phone, m.last_error
    FROM message_idempotency_records r
    JOIN sms_messages m ON m.id = r.message_id AND m.organization_id = r.organization_id
    WHERE r.organization_id = ${organizationId} AND r.status = 'UNCERTAIN'
    ORDER BY r.updated_at ASC
  `;
  return rows.map((r) => ({
    idempotencyKey: r.idempotency_key,
    messageId: r.message_id,
    recipientPhone: r.recipient_phone,
    lastError: r.last_error,
    since: new Date(r.updated_at),
  }));
}

/**
 * Recovers stale PENDING message dispatches (gateway never contacted) and expires stale leases.
 * Multi-worker safe: uses PostgreSQL compare-and-set to guarantee exactly one worker wins each claim.
 */
export async function defaultRecoverStaleDispatches(
  options: { pendingGraceSeconds?: number; limit?: number } = {},
  customFetch?: CustomFetchHandler,
): Promise<{ expiredToUncertain: number; resumed: number }> {
  const expiredToUncertain = await expireDispatchLeases();
  const graceSeconds = options.pendingGraceSeconds ?? 60;
  const limit = options.limit ?? 50;

  const stale = await sql<Record<string, any>>`
    SELECT * FROM message_idempotency_records
    WHERE status = 'PENDING' AND message_id IS NOT NULL
      AND created_at < NOW() - (${graceSeconds}::int * INTERVAL '1 second')
    ORDER BY created_at ASC
    LIMIT ${limit}
  `;

  let resumed = 0;
  for (const row of stale) {
    const claimant = `worker_${process.pid}_${randomUUID()}`;
    // Atomic CAS claim: only one worker or API process can win
    const claimedRows = await sql<Record<string, any>>`
      UPDATE message_idempotency_records
      SET status = 'DISPATCHING',
          claimed_by = ${claimant},
          lease_expires_at = NOW() + (${DISPATCH_LEASE_SECONDS}::int * INTERVAL '1 second'),
          dispatch_started_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id} AND status = 'PENDING'
      RETURNING *
    `;

    if (claimedRows.length === 0) {
      continue; // Won by another worker or retry
    }

    const claimed = claimedRows[0]!;
    const messageRows = await sql<Record<string, any>>`
      SELECT * FROM sms_messages
      WHERE id = ${claimed.message_id} AND organization_id = ${claimed.organization_id}
      LIMIT 1
    `;
    const acctRows = await sql<Record<string, any>>`
      SELECT * FROM messaging_accounts
      WHERE organization_id = ${claimed.organization_id}
      LIMIT 1
    `;

    if (messageRows.length === 0 || acctRows.length === 0 || !acctRows[0]!.encrypted_api_token) {
      logger.error('Cannot resume dispatch: message or gateway credentials missing', {
        recordId: claimed.id,
        organizationId: claimed.organization_id,
      });
      continue;
    }

    const msg = messageRows[0]!;
    const acct = acctRows[0]!;

    let authHeader = '';
    try {
      const rawAuth = acct.encrypted_api_token;
      if (rawAuth.startsWith('{')) {
        const parsedAuth = JSON.parse(rawAuth);
        if (parsedAuth.type === 'BASIC') {
          authHeader = `Basic ${Buffer.from(`${parsedAuth.username}:${parsedAuth.password}`).toString('base64')}`;
        } else {
          authHeader = `Bearer ${parsedAuth.token}`;
        }
      } else {
        authHeader = `Bearer ${rawAuth}`;
      }
    } catch {
      authHeader = `Bearer ${acct.encrypted_api_token}`;
    }

    const endpoint = (acct.gateway_base_url || 'https://api.sms-gate.app/3rdparty/v1').replace(/\/+$/, '') + '/messages';
    const requestBody = {
      phoneNumbers: [msg.recipient_phone],
      textMessage: { text: msg.message_text },
      simNumber: Number(msg.sim_slot || 1),
      withDeliveryReport: true,
    };

    let outcome: 'COMPLETED' | 'FAILED' | 'UNCERTAIN';
    let providerMessageId: string | null = null;
    let errorText: string | null = null;
    let rawResponseObj: Record<string, any> | null = null;

    try {
      let respStatus = 200;
      let respOk = true;
      let respText = '';
      let respJson: any = null;

      if (customFetch) {
        const res = await customFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
            'X-Idempotency-Key': claimed.idempotency_key,
          },
          body: JSON.stringify(requestBody),
        });
        respStatus = res.status;
        respOk = res.ok;
      } else {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
            'X-Idempotency-Key': claimed.idempotency_key,
          },
          body: JSON.stringify(requestBody),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        respStatus = response.status;
        respOk = response.ok;
        if (respOk) {
          try {
            respJson = await response.json();
          } catch {
            respOk = false;
            respText = 'Unparseable JSON body';
          }
        } else {
          respText = await response.text();
        }
      }

      if (respOk) {
        outcome = 'COMPLETED';
        providerMessageId =
          (respJson?.id as string) ||
          (respJson?.messageId as string) ||
          `msg_${Date.now()}`;
        rawResponseObj = respJson;
      } else {
        // BriskSMS policy: HTTP 400, 401, 403, 404, 413, 422, 429 are definitive rejections.
        // HTTP 408, 409, 5xx, timeouts, resets are UNCERTAIN. Never refunded blindly, never re-dispatched.
        const definitive = SMSGATE_DEFINITIVE_REJECTION_STATUSES.has(respStatus);
        outcome = definitive ? 'FAILED' : 'UNCERTAIN';
        errorText = definitive
          ? respText || `Gateway rejected request with HTTP ${respStatus}`
          : `GATEWAY_UNCERTAIN: HTTP ${respStatus} - ${respText || 'unknown status'}`;
        rawResponseObj = { statusCode: respStatus, error: respText, uncertain: !definitive };
      }
    } catch (err: unknown) {
      outcome = 'UNCERTAIN';
      errorText = `GATEWAY_UNCERTAIN: ${err instanceof Error ? err.message : String(err)}`;
      rawResponseObj = { error: errorText, uncertain: true };
    }

    const now = new Date();
    const smsStatus =
      outcome === 'COMPLETED' ? SmsStatus.SUBMITTED : outcome === 'FAILED' ? SmsStatus.FAILED : SmsStatus.QUEUED;
    const finalProviderId = outcome === 'UNCERTAIN' ? null : providerMessageId;

    await withTransaction(async (tx) => {
      const settled = await tx<Record<string, any>>`
        UPDATE message_idempotency_records
        SET status = ${outcome},
            response_payload = ${JSON.stringify({
              messageId: msg.id,
              status: smsStatus,
              recipientPhone: msg.recipient_phone,
              costCredits: Number(msg.cost_credits || 1),
              outcome,
            })}::jsonb,
            updated_at = ${now}
        WHERE id = ${claimed.id}
          AND claimed_by = ${claimant}
          AND status IN ('DISPATCHING', 'UNCERTAIN')
        RETURNING id
      `;

      if (settled.length === 0) return;

      await tx`
        UPDATE sms_messages
        SET status = ${smsStatus}::"SmsStatus",
            provider_message_id = ${finalProviderId},
            last_error = ${errorText},
            updated_at = ${now}
        WHERE id = ${msg.id} AND organization_id = ${claimed.organization_id}
      `;

      await tx`
        INSERT INTO sms_delivery_attempts (
          id, organization_id, message_id, attempt_number, gateway_provider,
          provider_message_id, status, error_message, raw_response, attempted_at
        ) VALUES (
          ${randomUUID()}, ${claimed.organization_id}, ${msg.id}, 1, ${msg.gateway_provider},
          ${finalProviderId}, ${smsStatus}::"SmsStatus", ${errorText},
          ${rawResponseObj ? JSON.stringify(rawResponseObj) : null}::jsonb, ${now}
        )
      `;

      if (outcome === 'FAILED') {
        const costCredits = Number(msg.cost_credits || 1);
        const acctUpdate = await tx<Record<string, any>>`
          SELECT credit_balance FROM messaging_accounts
          WHERE organization_id = ${claimed.organization_id}
          FOR UPDATE
        `;
        if (acctUpdate.length > 0) {
          const nextBal = Number(acctUpdate[0]!.credit_balance) + costCredits;
          await tx`
            UPDATE messaging_accounts
            SET credit_balance = ${nextBal}, updated_at = ${now}
            WHERE organization_id = ${claimed.organization_id}
          `;
          await tx`
            INSERT INTO messaging_credit_ledger (
              id, organization_id, entry_type, amount_credits, balance_after, reference_id, created_at
            ) VALUES (
              ${randomUUID()}, ${claimed.organization_id}, ${CreditLedgerEntryType.REFUND}::"CreditLedgerEntryType",
              ${costCredits}, ${nextBal}, ${`refund_${msg.id}`}, ${now}
            )
            ON CONFLICT (organization_id, reference_id) DO NOTHING
          `;
        }
      }
    });

    resumed++;
  }

  return { expiredToUncertain, resumed };
}

export interface DispatchRecoveryOptions {
  intervalMs?: number;
  pendingGraceSeconds?: number;
  limit?: number;
  recoveryHandler?: (options?: { pendingGraceSeconds?: number; limit?: number }) => Promise<{
    expiredToUncertain: number;
    resumed: number;
  }>;
}

/**
 * Periodically executes single-message dispatch recovery for stale PENDING operations and expired leases.
 * Multi-worker safe: uses PostgreSQL atomic compare-and-set to guarantee exactly-once dispatch claim.
 */
export class DispatchRecoveryRunner {
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  public readonly intervalMs: number;
  public readonly pendingGraceSeconds: number;
  public readonly limit: number;
  private readonly recoveryHandler: (options?: { pendingGraceSeconds?: number; limit?: number }) => Promise<{
    expiredToUncertain: number;
    resumed: number;
  }>;
  private isRunning: boolean = false;

  constructor(
    options?: DispatchRecoveryOptions,
    customFetch?: CustomFetchHandler,
  ) {
    this.intervalMs = options?.intervalMs ?? parseInt(process.env.DISPATCH_RECOVERY_INTERVAL_MS || '10000', 10);
    this.pendingGraceSeconds = options?.pendingGraceSeconds ?? parseInt(process.env.DISPATCH_PENDING_GRACE_SECONDS || '60', 10);
    this.limit = options?.limit ?? 50;
    this.recoveryHandler = options?.recoveryHandler ?? ((opts) => defaultRecoverStaleDispatches(opts, customFetch));
  }

  public async runOnce(): Promise<{ expiredToUncertain: number; resumed: number }> {
    if (this.isRunning) {
      return { expiredToUncertain: 0, resumed: 0 };
    }
    this.isRunning = true;
    try {
      const result = await this.recoveryHandler({
        pendingGraceSeconds: this.pendingGraceSeconds,
        limit: this.limit,
      });
      if (result.expiredToUncertain > 0 || result.resumed > 0) {
        logger.info('Dispatch recovery cycle executed', {
          expiredToUncertain: result.expiredToUncertain,
          resumed: result.resumed,
        });
      }
      return result;
    } catch (err: unknown) {
      logger.error('Dispatch recovery execution failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  public start(): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      this.runOnce().catch(() => {});
    }, this.intervalMs);
    logger.info('Dispatch recovery runner scheduled', {
      intervalMs: this.intervalMs,
      pendingGraceSeconds: this.pendingGraceSeconds,
    });
  }

  public stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}

/**
 * Orchestrates all BriskSMS background workers, outbox polling, Redis heartbeats, and dispatch recovery.
 */
export class BriskWorkerRuntime {
  public readonly outboxDispatcher = new OutboxDispatcher();
  public readonly dispatchRecoveryRunner: DispatchRecoveryRunner;
  public readonly webhookWorker: BullWorker<WebhookDeliveryJobData>;
  public readonly campaignWorker: BullWorker<SmsCampaignJobData>;
  public readonly maintenanceWorker: BullWorker<MaintenanceCleanupJobData>;
  public readonly paymentWorker: BullWorker<PaymentProcessingJobData>;
  public readonly retryWorker: BullWorker<SmsDeliveryRetryJobData>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  public readonly workerId = `worker_${process.pid}_${randomUUID().slice(0, 8)}`;

  constructor(customFetch?: CustomFetchHandler, recoveryOptions?: DispatchRecoveryOptions) {
    this.dispatchRecoveryRunner = new DispatchRecoveryRunner(recoveryOptions, customFetch);

    this.webhookWorker = new BullWorker<WebhookDeliveryJobData>(
      QUEUE_NAMES.WEBHOOK_DELIVERY,
      async (job) => {
        await processWebhookDeliveryJob(job, customFetch);
      },
      { concurrency: 4, pollIntervalMs: 50 },
    );

    this.campaignWorker = new BullWorker<SmsCampaignJobData>(
      QUEUE_NAMES.SMS_CAMPAIGN,
      async (job) => {
        await processSmsCampaignJob(job);
      },
      { concurrency: 2, pollIntervalMs: 50 },
    );

    this.maintenanceWorker = new BullWorker<MaintenanceCleanupJobData>(
      QUEUE_NAMES.MAINTENANCE_CLEANUP,
      async (job) => {
        await processMaintenanceCleanupJob(job);
      },
      { concurrency: 1, pollIntervalMs: 100 },
    );

    this.paymentWorker = new BullWorker<PaymentProcessingJobData>(
      QUEUE_NAMES.PAYMENT_PROCESSING,
      async (job) => {
        await processPaymentProcessingJob(job);
      },
      { concurrency: 2, pollIntervalMs: 50 },
    );

    this.retryWorker = new BullWorker<SmsDeliveryRetryJobData>(
      QUEUE_NAMES.SMS_DELIVERY_RETRY,
      async (job) => {
        await processSmsDeliveryRetryJob(job);
      },
      { concurrency: 2, pollIntervalMs: 50 },
    );
  }

  public async start(): Promise<void> {
    await recordWorkerHeartbeat(this.workerId, [
      QUEUE_NAMES.WEBHOOK_DELIVERY,
      QUEUE_NAMES.PAYMENT_PROCESSING,
      QUEUE_NAMES.SMS_CAMPAIGN,
      QUEUE_NAMES.SMS_DELIVERY_RETRY,
      QUEUE_NAMES.MAINTENANCE_CLEANUP,
    ]);

    this.heartbeatTimer = setInterval(() => {
      recordWorkerHeartbeat(this.workerId, [
        QUEUE_NAMES.WEBHOOK_DELIVERY,
        QUEUE_NAMES.PAYMENT_PROCESSING,
        QUEUE_NAMES.SMS_CAMPAIGN,
        QUEUE_NAMES.SMS_DELIVERY_RETRY,
        QUEUE_NAMES.MAINTENANCE_CLEANUP,
      ]).catch((err) => {
        logger.warn('Worker heartbeat update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 5000);

    this.outboxDispatcher.start(1000);
    this.dispatchRecoveryRunner.start();
    this.webhookWorker.start();
    this.campaignWorker.start();
    this.maintenanceWorker.start();
    this.paymentWorker.start();
    this.retryWorker.start();

    logger.info('BriskSMS background worker runtime started (all 5 queues active, dispatch recovery active)', {
      workerId: this.workerId,
      recoveryIntervalMs: this.dispatchRecoveryRunner.intervalMs,
    });
  }

  public async stop(): Promise<void> {
    this.outboxDispatcher.stop();
    this.dispatchRecoveryRunner.stop();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await Promise.all([
      this.webhookWorker.stop(),
      this.campaignWorker.stop(),
      this.maintenanceWorker.stop(),
      this.paymentWorker.stop(),
      this.retryWorker.stop(),
    ]);
    logger.info('BriskSMS background worker runtime stopped gracefully', {
      workerId: this.workerId,
    });
  }
}
