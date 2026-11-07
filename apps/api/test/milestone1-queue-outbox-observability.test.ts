import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  BullQueue,
  BullWorker,
  QUEUE_NAMES,
  getRedisClient,
  setSimulatedRedisOutage,
  setSimulatedDatabaseOutage,
  recordWorkerHeartbeat,
  StructuredLogger,
} from '@brisksms/db';
import {
  BusinessEventType,
  EvidenceSourceType,
  FeatureKey,
  OutboxStatus,
} from '@brisksms/shared';
import {
  OutboxDispatcher,
  BriskWorkerRuntime,
  SmsCampaignJobData,
} from '@brisksms/worker';
import { dbStore } from '../src/core/store.js';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { WebhookService } from '../src/modules/developer/webhook.service.js';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';

async function invokeRouter(
  router: ReturnType<typeof createApp>,
  method: string,
  path: string,
): Promise<{ statusCode: number; body: any }> {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = path;
  req.headers = { host: 'localhost:3000' };
  req.push(null);

  const res = new ServerResponse(req);
  let statusCode = 200;
  const chunks: Buffer[] = [];

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = ((code: number, ...args: any[]) => {
    statusCode = code;
    return origWriteHead(code, ...args);
  }) as any;

  const origEnd = res.end.bind(res);
  res.end = ((chunk?: any, ...args: any[]) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return origEnd(chunk, ...args);
  }) as any;

  await router.handle(req, res);
  const raw = Buffer.concat(chunks).toString('utf8');
  return {
    statusCode,
    body: raw ? JSON.parse(raw) : null,
  };
}

describe('Milestone 1: Redis/BullMQ Queues, Transactional Outbox & Operational Observability', () => {
  const authService = new AuthService();
  const reconService = new ReconciliationService();
  const ingestionService = new IngestionService(reconService);
  const webhookService = new WebhookService();
  const messagingService = new MessagingService();

  let orgId: string;

  beforeEach(async () => {
    setSimulatedRedisOutage(false);
    setSimulatedDatabaseOutage(false);
    await dbStore.reset();
    const redis = getRedisClient();
    await redis.flushDb();

    const reg = await authService.register({
      email: 'ops@brisksms.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Ops Engineer',
      organizationName: 'Ops Telecom',
    });
    orgId = reg.organizationId!;
  });

  it('persists jobs in Redis across worker restarts and deduplicates by deterministic jobId', async () => {
    const queue = new BullQueue<{ organizationId: string; counter: number }>(QUEUE_NAMES.PAYMENT_PROCESSING);

    // Enqueue with explicit deterministic jobId
    const job1 = await queue.add(
      'process-payment',
      { organizationId: orgId, counter: 1 },
      { jobId: 'idem_job_1001' },
    );
    // Duplicate enqueue with same jobId must return existing job without duplicating in waiting list
    const job2 = await queue.add(
      'process-payment',
      { organizationId: orgId, counter: 1 },
      { jobId: 'idem_job_1001' },
    );

    assert.equal(job1.id, job2.id);
    const countsBefore = await queue.getCounts();
    assert.equal(countsBefore.waiting, 1);

    // Start a worker AFTER the job was persisted (simulating worker restart recovery)
    const processed: string[] = [];
    const worker = new BullWorker<{ organizationId: string; counter: number }>(
      QUEUE_NAMES.PAYMENT_PROCESSING,
      async (job) => {
        processed.push(job.id);
      },
      { concurrency: 1, pollIntervalMs: 20 },
    );

    await worker.drain();
    assert.deepEqual(processed, ['idem_job_1001']);

    const countsAfter = await queue.getCounts();
    assert.equal(countsAfter.completed, 1);
    assert.equal(countsAfter.waiting, 0);
  });

  it('retries failed jobs with backoff and moves permanently failing jobs to the Dead-Letter Queue (dlq)', async () => {
    const queue = new BullQueue<{ organizationId: string; task: string }>(QUEUE_NAMES.SMS_DELIVERY_RETRY);

    await queue.add(
      'failing-delivery',
      { organizationId: orgId, task: 'retry-sms' },
      {
        jobId: 'dlq_test_job_1',
        attempts: 2,
        backoffMs: 10,
      },
    );

    let attemptCounter = 0;
    const worker = new BullWorker<{ organizationId: string; task: string }>(
      QUEUE_NAMES.SMS_DELIVERY_RETRY,
      async () => {
        attemptCounter++;
        throw new Error(`Simulated transient failure #${attemptCounter}`);
      },
      { concurrency: 1 },
    );

    // Attempt 1 fails -> schedules retry in delayed ZSET
    await worker.processNextTick();
    assert.equal(attemptCounter, 1);

    // Wait 25ms for backoff delay to mature, then Attempt 2 fails -> moves to DLQ
    await new Promise((r) => setTimeout(r, 30));
    await worker.processNextTick();
    assert.equal(attemptCounter, 2);

    const dlqJobs = await queue.getDeadLetterJobs();
    assert.equal(dlqJobs.length, 1);
    assert.equal(dlqJobs[0]?.id, 'dlq_test_job_1');
    assert.match(dlqJobs[0]?.failedReason || '', /Simulated transient failure #2/);
  });

  it('prohibits raw secrets or private keys from being enqueued in job payloads', async () => {
    const queue = new BullQueue<Record<string, unknown>>(QUEUE_NAMES.WEBHOOK_DELIVERY);

    await assert.rejects(
      () =>
        queue.add('bad-job', {
          organizationId: orgId,
          plainTextSecret: ['bsk', 'live', 'mock_secret_test'].join('_'),
        }),
      /SECURITY_VIOLATION: Sensitive credential field .* is forbidden in background job payloads/,
    );
  });

  it('preserves transactional outbox events in PostgreSQL when Redis is down and dispatches them once Redis recovers (webhook failures never roll back ingestion)', async () => {
    await webhookService.registerEndpoint(orgId, {
      url: 'https://hooks.ops-telecom.co.tz/events',
      subscribedEvents: [BusinessEventType.PAYMENT_EVIDENCE_RECEIVED, BusinessEventType.PAYMENT_MATCHED],
    });

    await reconService.createInvoice(orgId, {
      referenceNumber: 'QA55OUTBOX99',
      totalAmountCents: 4500000n,
    });

    // 1. Simulate Redis outage during payment evidence ingestion
    setSimulatedRedisOutage(true);

    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.DIRECT_PROVIDER_API,
      senderAddress: 'M-PESA',
      rawPayload: 'QA55OUTBOX99 Imethibitishwa. Umepokea Tsh45,000 kutoka kwa Neema 255754111222 tarehe 05/11/2026 saa 15:00.',
      deviceTimestamp: new Date('2026-11-05T15:00:00Z'),
    });

    // Payment ingestion and candidate matching succeed in PostgreSQL even while Redis is down!
    assert.equal(ack.acknowledged, true);
    assert.equal(ack.state, 'MATCHED');

    // Outboxdispatcher poll while Redis is down safely reverts lock and keeps events PENDING in PostgreSQL
    const dispatcher = new OutboxDispatcher();
    const enqueuedDuringOutage = await dispatcher.pollAndEnqueue();
    assert.equal(enqueuedDuringOutage, 0);

    const pendingOutbox = await dbStore.getOutboxEvents(orgId);
    assert.equal(pendingOutbox.length >= 2, true);
    assert.equal(pendingOutbox.every((e) => e.status === OutboxStatus.PENDING), true);

    // 2. Restore Redis and run worker runtime with simulated failing then succeeding webhook receiver
    setSimulatedRedisOutage(false);
    const enqueuedAfterRecovery = await dispatcher.pollAndEnqueue();
    assert.equal(enqueuedAfterRecovery, pendingOutbox.length);

    const deliveredEventIds: string[] = [];
    const runtime = new BriskWorkerRuntime(async (_url, init) => {
      const eventId = (init.headers as Record<string, string>)['X-BriskSMS-Delivery'] || '';
      deliveredEventIds.push(eventId);
      return { status: 200, ok: true };
    });

    await runtime.webhookWorker.drain();
    assert.equal(deliveredEventIds.length, pendingOutbox.length);

    const finalOutbox = await dbStore.getOutboxEvents(orgId);
    assert.equal(finalOutbox.every((e) => e.isDelivered && e.status === OutboxStatus.DELIVERED), true);
  });

  it('executes SMS campaign worker jobs idempotently and commits reserved credits', async () => {
    await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.BULK_MESSAGING_ENABLED, 'true');
    await messagingService.purchaseCredits(orgId, 10, 'CAMP-CREDITS');

    const { campaign } = await messagingService.createCampaign(orgId, {
      name: 'November Billing Notice',
      templateText: 'Hello {{name}}, your bill is due.',
      recipients: [
        { phoneNumber: '0754111222', variables: { name: 'Ali' } },
        { phoneNumber: '0712333444', variables: { name: 'Beatrice' } },
      ],
    });

    const balancesBefore = await messagingService.getAccountBalances(orgId);
    assert.equal(balancesBefore.creditBalance, 8);
    assert.equal(balancesBefore.reservedCredits, 2);

    const campaignQueue = new BullQueue<SmsCampaignJobData>(QUEUE_NAMES.SMS_CAMPAIGN);
    await campaignQueue.add(
      'execute-campaign',
      { organizationId: orgId, campaignId: campaign.id },
      { jobId: `campaign_${campaign.id}` },
    );

    const runtime = new BriskWorkerRuntime();
    await runtime.campaignWorker.drain();

    const balancesAfter = await messagingService.getAccountBalances(orgId);
    assert.equal(balancesAfter.creditBalance, 8);
    assert.equal(balancesAfter.reservedCredits, 0);
  });

  it('redacts sensitive secrets, passwords, and raw notification payloads in StructuredLogger', () => {
    StructuredLogger.clearRecentLogs();
    const log = new StructuredLogger('security-test');

    const mockToken = ['bsk', 'live', 'sample_test_token_998877'].join('_');
    const mockSecretPassword = ['Mock', 'Sample', 'Pass', '123!'].join('_');

    const entry = log.info(`Authenticated request with token ${mockToken}`, {
      organizationId: orgId,
      password: mockSecretPassword,
      apiSecret: mockToken,
      rawPayload: 'QA8921KL90 Imethibitishwa. Umepokea Tsh150,000...',
    });

    const serialized = JSON.stringify(entry);
    assert.equal(serialized.includes(mockSecretPassword), false);
    assert.equal(serialized.includes(mockToken), false);
    assert.equal(serialized.includes('Umepokea Tsh150,000'), false);
    assert.equal(serialized.includes('[REDACTED]'), true);
    assert.equal(serialized.includes('[REDACTED_SECRET]'), true);
  });

  it('reports accurate health status on /v1/health when dependencies are UP vs DOWN', async () => {
    const app = createApp();
    await recordWorkerHeartbeat('worker_test_1', [QUEUE_NAMES.WEBHOOK_DELIVERY]);

    // 1. All dependencies UP -> 200 OK
    const healthyRes = await invokeRouter(app, 'GET', '/v1/health');
    assert.equal(healthyRes.statusCode, 200);
    assert.equal(healthyRes.body.success, true);
    assert.equal(healthyRes.body.data.status, 'UP');
    assert.equal(healthyRes.body.data.dependencies.postgresql.status, 'UP');
    assert.equal(healthyRes.body.data.dependencies.redis.status, 'UP');
    assert.equal(healthyRes.body.data.dependencies.worker.status, 'UP');

    // 2. Simulate Redis outage -> 503 Service Unavailable
    setSimulatedRedisOutage(true);
    try {
      const redisDownRes = await invokeRouter(app, 'GET', '/v1/health');
      assert.equal(redisDownRes.statusCode, 503);
      assert.equal(redisDownRes.body.success, false);
      assert.equal(redisDownRes.body.data.status, 'DOWN');
      assert.equal(redisDownRes.body.data.dependencies.redis.status, 'DOWN');
    } finally {
      setSimulatedRedisOutage(false);
    }

    // 3. Simulate PostgreSQL outage -> 503 Service Unavailable
    setSimulatedDatabaseOutage(true);
    try {
      const dbDownRes = await invokeRouter(app, 'GET', '/v1/health');
      assert.equal(dbDownRes.statusCode, 503);
      assert.equal(dbDownRes.body.success, false);
      assert.equal(dbDownRes.body.data.status, 'DOWN');
      assert.equal(dbDownRes.body.data.dependencies.postgresql.status, 'DOWN');
    } finally {
      setSimulatedDatabaseOutage(false);
    }
  });
});
