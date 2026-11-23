import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  CreditLedgerEntryType,
  GatewayMode,
  OutboxStatus,
  SmsStatus,
  encryptSecret,
} from '@brisksms/shared';
import { sql, withTransaction, resetTestDatabaseState, QUEUE_NAMES } from '@brisksms/db';
import {
  computeWebhookSignature,
  defaultRecoverStaleDispatches,
  processSmsCampaignJob,
  processSmsDeliveryRetryJob,
  processWebhookDeliveryJob,
  purgeOldRelayHistory,
  resolveHistoryRetentionDays,
} from '../src/workers.js';

describe('Standalone Worker Security & Concurrency Suite', () => {
  let orgId: string;

  beforeEach(async () => {
    await resetTestDatabaseState();
    orgId = randomUUID();
    await sql`
      INSERT INTO organizations (id, name, slug, country_code, timezone, plan_tier, is_active)
      VALUES (${orgId}, 'Worker Test Org', ${`worker-org-${orgId.slice(0, 8)}`}, 'TZA', 'Africa/Dar_es_Salaam', 'ENTERPRISE', true)
    `;
    await sql`
      INSERT INTO messaging_accounts (
        id, organization_id, credit_balance, reserved_credits,
        gateway_mode, gateway_base_url, encrypted_api_token, default_sim_slot, is_active, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${orgId}, 20, 0,
        ${GatewayMode.MANAGED_GATEWAY}, 'https://gateway.example.com/api/v1', NULL, 1, true, NOW(), NOW()
      )
    `;
  });

  it('blocks SSRF metadata webhook destinations in processWebhookDeliveryJob and signs with decrypted AES-256-GCM secret', async () => {
    const ssrfEndpointId = randomUUID();
    const safeEndpointId = randomUUID();
    const eventId = randomUUID();
    const plainSecret = 'whsec_worker_decrypted_secret_987654321';
    const encryptedSecret = encryptSecret(plainSecret);

    await sql`
      INSERT INTO webhook_endpoints (
        id, organization_id, url, secret, subscribed_events, is_active, created_at, updated_at
      ) VALUES
        (${ssrfEndpointId}, ${orgId}, 'http://169.254.169.254/latest/meta-data', ${encryptedSecret}, ${JSON.stringify([BusinessEventType.PAYMENT_MATCHED])}::jsonb, true, NOW(), NOW()),
        (${safeEndpointId}, ${orgId}, 'https://hooks.example.com/brisksms', ${encryptedSecret}, ${JSON.stringify([BusinessEventType.PAYMENT_MATCHED])}::jsonb, true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO outbox_events (
        id, organization_id, event_type, payload, status, is_delivered, attempt_count, max_attempts, next_attempt_at, created_at
      ) VALUES (
        ${eventId}, ${orgId}, ${BusinessEventType.PAYMENT_MATCHED},
        ${JSON.stringify({ amountCents: '50000' })}::jsonb, ${OutboxStatus.PENDING}::"OutboxStatus", false, 0, 5, NOW(), NOW()
      )
    `;

    let seenSignature = '';
    let seenBody = '';
    await assert.rejects(
      () =>
        processWebhookDeliveryJob(
          {
            id: 'job_wh_1',
            name: 'deliver-webhook',
            queueName: QUEUE_NAMES.WEBHOOK_DELIVERY,
            data: { organizationId: orgId, outboxEventId: eventId, eventType: BusinessEventType.PAYMENT_MATCHED },
            opts: {} as any,
            status: 'active' as any,
            attemptsMade: 0,
            timestamp: Date.now(),
          },
          async (_url, init) => {
            const headers = init.headers as Record<string, string>;
            seenSignature = headers['X-BriskSMS-Signature'] || '';
            seenBody = String(init.body || '');
            return { status: 200, ok: true };
          },
        ),
      /prohibited internal or private network destination/,
    );

    // Ensure safe endpoint got signed with decrypted plainSecret, NOT raw aes-256-gcm ciphertext
    assert.ok(seenSignature.includes('v1='));
    const [tPart, v1Part] = seenSignature.split(',');
    const ts = Number(tPart!.replace('t=', ''));
    const expectedSig = computeWebhookSignature(seenBody, plainSecret, ts);
    assert.equal(`t=${ts},${v1Part}`, expectedSig);
  });

  it('prevents double-refund under concurrent retry exhaustion via FOR UPDATE transaction locking', async () => {
    const messageId = randomUUID();
    await sql`
      INSERT INTO sms_messages (
        id, organization_id, campaign_id, recipient_phone, message_text,
        status, cost_credits, sim_slot, gateway_provider, attempt_count, created_at, updated_at
      ) VALUES (
        ${messageId}, ${orgId}, NULL, '+255754000999', 'Concurrent Retry Test',
        ${SmsStatus.QUEUED}::"SmsStatus", 1, 1, 'MANAGED_GATEWAY', 3, NOW(), NOW()
      )
    `;

    const makeRetryJob = () =>
      processSmsDeliveryRetryJob({
        id: `retry_${randomUUID()}`,
        name: 'sms-retry',
        queueName: QUEUE_NAMES.SMS_DELIVERY_RETRY,
        data: { organizationId: orgId, messageId },
        opts: {} as any,
        status: 'active' as any,
        attemptsMade: 2,
        timestamp: Date.now(),
      });

    const [r1, r2] = await Promise.all([makeRetryJob(), makeRetryJob()]);
    const refundCount = [r1.refunded, r2.refunded].filter(Boolean).length;
    assert.equal(refundCount, 1);

    const acct = await sql<{ credit_balance: number }>`
      SELECT credit_balance FROM messaging_accounts WHERE organization_id = ${orgId}
    `;
    assert.equal(Number(acct[0]!.credit_balance), 21);

    const ledger = await sql<{ entry_type: string }>`
      SELECT entry_type FROM messaging_credit_ledger
      WHERE organization_id = ${orgId} AND entry_type = ${CreditLedgerEntryType.REFUND}::"CreditLedgerEntryType"
    `;
    assert.equal(ledger.length, 1);
  });

  it('releases missing-credentials stale DISPATCHING claim and treats HTTP 429 as UNCERTAIN with decrypted credentials', async () => {
    const msgMissingId = randomUUID();
    const recMissingId = randomUUID();
    await sql`
      INSERT INTO sms_messages (
        id, organization_id, campaign_id, recipient_phone, message_text,
        status, cost_credits, sim_slot, gateway_provider, created_at, updated_at
      ) VALUES (
        ${msgMissingId}, ${orgId}, NULL, '+255754000111', 'Missing cred message',
        ${SmsStatus.QUEUED}::"SmsStatus", 1, 1, 'MANAGED_GATEWAY', NOW() - INTERVAL '5 minutes', NOW()
      )
    `;
    await sql`
      INSERT INTO message_idempotency_records (
        id, organization_id, idempotency_key, request_fingerprint, message_id, status, created_at, updated_at
      ) VALUES (
        ${recMissingId}, ${orgId}, 'idem_missing_cred_1', 'fp_1', ${msgMissingId}, 'PENDING', NOW() - INTERVAL '5 minutes', NOW()
      )
    `;

    await defaultRecoverStaleDispatches({ pendingGraceSeconds: 60 });
    const recAfterMissing = await sql<{ status: string }>`
      SELECT status FROM message_idempotency_records WHERE id = ${recMissingId}
    `;
    assert.equal(recAfterMissing[0]!.status, 'UNCERTAIN');

    // Now configure encrypted credentials and test HTTP 429 -> UNCERTAIN
    const encryptedCred = encryptSecret(JSON.stringify({ type: 'BEARER', token: 'live_gw_tok_abc' }));
    await sql`
      UPDATE messaging_accounts SET encrypted_api_token = ${encryptedCred}
      WHERE organization_id = ${orgId}
    `;
    const msg429Id = randomUUID();
    const rec429Id = randomUUID();
    await sql`
      INSERT INTO sms_messages (
        id, organization_id, campaign_id, recipient_phone, message_text,
        status, cost_credits, sim_slot, gateway_provider, created_at, updated_at
      ) VALUES (
        ${msg429Id}, ${orgId}, NULL, '+255754000222', 'Rate limit message',
        ${SmsStatus.QUEUED}::"SmsStatus", 1, 1, 'MANAGED_GATEWAY', NOW() - INTERVAL '5 minutes', NOW()
      )
    `;
    await sql`
      INSERT INTO message_idempotency_records (
        id, organization_id, idempotency_key, request_fingerprint, message_id, status, created_at, updated_at
      ) VALUES (
        ${rec429Id}, ${orgId}, 'idem_429_worker', 'fp_2', ${msg429Id}, 'PENDING', NOW() - INTERVAL '5 minutes', NOW()
      )
    `;

    let seenAuth = '';
    await defaultRecoverStaleDispatches({ pendingGraceSeconds: 60 }, async (_url, init) => {
      seenAuth = (init.headers as Record<string, string>).Authorization || '';
      return { status: 429, ok: false };
    });

    assert.equal(seenAuth, 'Bearer live_gw_tok_abc');
    const rec429After = await sql<{ status: string }>`
      SELECT status FROM message_idempotency_records WHERE id = ${rec429Id}
    `;
    assert.equal(rec429After[0]!.status, 'UNCERTAIN');
  });

  it('dispatches campaign via gateway when credentials configured and refunds definitively rejected recipients', async () => {
    const encryptedCred = encryptSecret(JSON.stringify({ type: 'BEARER', token: 'campaign_tok_123' }));
    await sql`
      UPDATE messaging_accounts SET encrypted_api_token = ${encryptedCred}, credit_balance = 18, reserved_credits = 2
      WHERE organization_id = ${orgId}
    `;
    const campaignId = randomUUID();
    await sql`
      INSERT INTO sms_campaigns (
        id, organization_id, sender_id_id, name, message_template, status, recipient_count, created_at, updated_at
      ) VALUES (
        ${campaignId}, ${orgId}, NULL, 'Worker Campaign', 'Hello', 'DRAFT'::"CampaignStatus", 2, NOW(), NOW()
      )
    `;
    await sql`
      INSERT INTO sms_campaign_recipients (
        id, organization_id, campaign_id, recipient_phone, variables, interpolated_text, status, created_at, updated_at
      ) VALUES
        (${randomUUID()}, ${orgId}, ${campaignId}, '+255754100001', NULL, 'Hello 1', ${SmsStatus.QUEUED}::"SmsStatus", NOW(), NOW()),
        (${randomUUID()}, ${orgId}, ${campaignId}, '+255754100002', NULL, 'Hello 2', ${SmsStatus.QUEUED}::"SmsStatus", NOW(), NOW())
    `;

    let callNum = 0;
    const result = await processSmsCampaignJob(
      {
        id: 'job_camp_real',
        name: 'dispatch-campaign',
        queueName: QUEUE_NAMES.SMS_CAMPAIGN,
        data: { organizationId: orgId, campaignId },
        opts: {} as any,
        status: 'active' as any,
        attemptsMade: 0,
        timestamp: Date.now(),
      },
      async () => {
        callNum++;
        return callNum === 1 ? { status: 200, ok: true } : { status: 422, ok: false };
      },
    );

    assert.equal(result.sentCount, 1);
    assert.equal(result.failedCount, 1);

    const acct = await sql<{ credit_balance: number; reserved_credits: number }>`
      SELECT credit_balance, reserved_credits FROM messaging_accounts WHERE organization_id = ${orgId}
    `;
    assert.equal(Number(acct[0]!.credit_balance), 19); // 18 + 1 released for 422 failure
    assert.equal(Number(acct[0]!.reserved_credits), 0);
  });
  describe('relay history retention', () => {
    let deviceId: string;

    async function addJob(status: string, daysOld: number): Promise<string> {
      const messageId = randomUUID();
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, campaign_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, gateway_provider, created_at, updated_at
        ) VALUES (
          ${messageId}, ${orgId}, NULL, '+255754000222', 'History test',
          ${SmsStatus.QUEUED}::"SmsStatus", 1, 1, 'MANAGED_GATEWAY', NOW(), NOW()
        )
      `;
      const jobId = randomUUID();
      await sql`
        INSERT INTO outbound_sms_jobs (
          id, organization_id, message_id, request_fingerprint, recipient_phone, message_text,
          status, expires_at, created_at, updated_at
        ) VALUES (
          ${jobId}, ${orgId}, ${messageId}, 'fp', '+255754000222', 'History test',
          ${status}::"OutboundSmsJobStatus",
          NOW() - ${daysOld} * INTERVAL '1 day' + INTERVAL '1 hour',
          NOW() - ${daysOld} * INTERVAL '1 day', NOW() - ${daysOld} * INTERVAL '1 day'
        )
      `;
      return jobId;
    }

    async function addCommand(status: string, daysOld: number): Promise<string> {
      const commandId = randomUUID();
      await sql`
        INSERT INTO device_commands (
          id, organization_id, device_id, command_type, status, expires_at, created_at, updated_at
        ) VALUES (
          ${commandId}, ${orgId}, ${deviceId}, 'PAUSE_RELAY'::"DeviceCommandType", ${status}::"DeviceCommandStatus",
          NOW() - ${daysOld} * INTERVAL '1 day' + INTERVAL '1 hour',
          NOW() - ${daysOld} * INTERVAL '1 day', NOW() - ${daysOld} * INTERVAL '1 day'
        )
      `;
      return commandId;
    }

    beforeEach(async () => {
      deviceId = randomUUID();
      await sql`
        INSERT INTO devices (
          id, organization_id, label, device_model, manufacturer, android_version, app_version,
          public_key_pem, device_token_hash, status, created_at, updated_at
        ) VALUES (
          ${deviceId}, ${orgId}, 'History phone', 'Pixel', 'Google', '14', '1.0.0',
          'pem', ${`hash-${deviceId}`}, 'ACTIVE'::"DeviceStatus", NOW(), NOW()
        )
      `;
    });

    it('removes only finished rows older than the retention period and leaves messages alone', async () => {
      const oldDelivered = await addJob('DELIVERED', 100);
      const oldFailed = await addJob('FAILED', 100);
      const keptUncertain = await addJob('UNCERTAIN', 100);
      const keptQueued = await addJob('QUEUED', 100);
      const keptRecent = await addJob('DELIVERED', 10);

      const oldAcked = await addCommand('ACKNOWLEDGED', 100);
      const oldCancelled = await addCommand('CANCELLED', 100);
      const keptPending = await addCommand('PENDING', 100);
      const keptDelivered = await addCommand('DELIVERED', 100);
      const keptRecentFailed = await addCommand('FAILED', 10);

      const result = await purgeOldRelayHistory(90, { pauseMs: 0 });
      assert.deepEqual(result, { purgedOutboundSmsJobs: 2, purgedDeviceCommands: 2 });

      const jobs = await sql<{ id: string }>`SELECT id FROM outbound_sms_jobs WHERE organization_id = ${orgId}`;
      assert.deepEqual(new Set(jobs.map((r) => r.id)), new Set([keptUncertain, keptQueued, keptRecent]));
      assert.ok(!jobs.some((r) => r.id === oldDelivered || r.id === oldFailed));

      const commands = await sql<{ id: string }>`SELECT id FROM device_commands WHERE organization_id = ${orgId}`;
      assert.deepEqual(new Set(commands.map((r) => r.id)), new Set([keptPending, keptDelivered, keptRecentFailed]));
      assert.ok(!commands.some((r) => r.id === oldAcked || r.id === oldCancelled));

      const messages = await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM sms_messages WHERE organization_id = ${orgId}`;
      assert.equal(Number(messages[0]!.n), 5);
    });

    it('works in small batches and a later run continues where the last one stopped', async () => {
      for (let i = 0; i < 5; i++) await addJob('EXPIRED', 120);

      const first = await purgeOldRelayHistory(90, { batchSize: 2, maxBatches: 2, pauseMs: 0 });
      assert.equal(first.purgedOutboundSmsJobs, 4);

      const second = await purgeOldRelayHistory(90, { batchSize: 2, maxBatches: 2, pauseMs: 0 });
      assert.equal(second.purgedOutboundSmsJobs, 1);

      const left = await sql<{ n: string }>`SELECT COUNT(*)::text AS n FROM outbound_sms_jobs WHERE organization_id = ${orgId}`;
      assert.equal(Number(left[0]!.n), 0);
    });

    it('skips rows another session is holding instead of waiting for them', async () => {
      const held = await addJob('FAILED', 100);
      const free = await addJob('FAILED', 100);

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let locked: () => void = () => {};
      const isLocked = new Promise<void>((resolve) => { locked = resolve; });
      const holder = withTransaction(async (tx) => {
        await tx`SELECT id FROM outbound_sms_jobs WHERE id = ${held} FOR UPDATE`;
        locked();
        await gate;
      });
      await isLocked;

      const result = await purgeOldRelayHistory(90, { pauseMs: 0 });
      release();
      await holder;

      assert.equal(result.purgedOutboundSmsJobs, 1);
      const left = await sql<{ id: string }>`SELECT id FROM outbound_sms_jobs WHERE organization_id = ${orgId}`;
      assert.deepEqual(left.map((r) => r.id), [held]);
      assert.ok(free);
    });

    it('never keeps history for less than 30 days, whatever the setting says', () => {
      assert.equal(resolveHistoryRetentionDays(undefined), 90);
      assert.equal(resolveHistoryRetentionDays('not a number'), 90);
      assert.equal(resolveHistoryRetentionDays('120'), 120);
      assert.equal(resolveHistoryRetentionDays('3'), 30);
      assert.equal(resolveHistoryRetentionDays('0'), 30);
    });
  });
});
