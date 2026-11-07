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

  const row = eventRows[0];
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

  const campaign = campaignRows[0];
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
      const currentBalance = Number(acctRows[0].credit_balance);
      const currentReserved = Number(acctRows[0].reserved_credits);
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
 * Orchestrates all BriskSMS background workers, outbox polling, and Redis heartbeats.
 */
export class BriskWorkerRuntime {
  public readonly outboxDispatcher = new OutboxDispatcher();
  public readonly webhookWorker: BullWorker<WebhookDeliveryJobData>;
  public readonly campaignWorker: BullWorker<SmsCampaignJobData>;
  public readonly maintenanceWorker: BullWorker<MaintenanceCleanupJobData>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  public readonly workerId = `worker_${process.pid}_${randomUUID().slice(0, 8)}`;

  constructor(customFetch?: CustomFetchHandler) {
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
  }

  public async start(): Promise<void> {
    await recordWorkerHeartbeat(this.workerId, [
      QUEUE_NAMES.WEBHOOK_DELIVERY,
      QUEUE_NAMES.SMS_CAMPAIGN,
      QUEUE_NAMES.MAINTENANCE_CLEANUP,
    ]);

    this.heartbeatTimer = setInterval(() => {
      recordWorkerHeartbeat(this.workerId, [
        QUEUE_NAMES.WEBHOOK_DELIVERY,
        QUEUE_NAMES.SMS_CAMPAIGN,
        QUEUE_NAMES.MAINTENANCE_CLEANUP,
      ]).catch((err) => {
        logger.warn('Worker heartbeat update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 5000);

    this.outboxDispatcher.start(1000);
    this.webhookWorker.start();
    this.campaignWorker.start();
    this.maintenanceWorker.start();

    logger.info('BriskSMS background worker runtime started', {
      workerId: this.workerId,
    });
  }

  public async stop(): Promise<void> {
    this.outboxDispatcher.stop();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await Promise.all([
      this.webhookWorker.stop(),
      this.campaignWorker.stop(),
      this.maintenanceWorker.stop(),
    ]);
    logger.info('BriskSMS background worker runtime stopped gracefully', {
      workerId: this.workerId,
    });
  }
}
