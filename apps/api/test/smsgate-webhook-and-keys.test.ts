import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { sql, resetTestDatabaseState } from '@brisksms/db';
import { createApp } from '../src/app.js';
import { smsGateKeyService } from '../src/modules/messaging/services/smsgate-key.service.js';
import { messagingService } from '../src/modules/messaging/messaging.service.js';
import { isEncryptedSecret } from '../src/core/crypto.js';
import { SmsStatus, GatewayMode } from '@brisksms/shared';

describe('Milestone 2.5: SMSGate Persistent Key Management, Webhook Reliability & Replay Protection', () => {
  const router = createApp();
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const deviceId = 'android_dev_relay_001';
  const signingSecret = 'very_secure_device_webhook_signing_secret_12345';
  const masterKey = 'brisksms_dev_encryption_master_key_32_bytes_min!';

  before(async () => {
    process.env.ENCRYPTION_MASTER_KEY = masterKey;
    await resetTestDatabaseState();

    // Create test organizations
    await sql`
      INSERT INTO organizations (id, name, slug, country_code, timezone, plan_tier, is_active)
      VALUES (${orgId}, 'Test Org 2.5', ${`org-25-${Date.now()}`}, 'TZA', 'Africa/Dar_es_Salaam', 'ENTERPRISE', true),
             (${otherOrgId}, 'Other Org 2.5', ${`other-25-${Date.now()}`}, 'TZA', 'Africa/Dar_es_Salaam', 'ENTERPRISE', true)
    `;

    // Fund messaging account
    await messagingService.purchaseCredits(orgId, 50, 'initial_funding');
  });

  beforeEach(() => {
    smsGateKeyService.clearAll();
  });

  describe('1. Persistent Signing-Key Storage, Encryption at Rest & Audit Logging', () => {
    it('should store signing keys encrypted at rest using AES-256-GCM', async () => {
      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);

      const dbRows = await sql<Record<string, any>>`
        SELECT * FROM smsgate_signing_keys
        WHERE organization_id = ${orgId} AND device_id = ${deviceId}
      `;

      assert.equal(dbRows.length, 1);
      const row = dbRows[0]!;

      // Enforce: Plaintext secret MUST NOT be stored in database
      assert.notEqual(row.encrypted_key, signingSecret);

      // Enforce: Must be formatted as AES-256-GCM authenticated ciphertext
      assert.equal(isEncryptedSecret(row.encrypted_key), true);
      assert.ok(row.encrypted_key.startsWith('aes-256-gcm:'));

      // Resolves decrypted plaintext cleanly
      const resolved = await smsGateKeyService.resolveCandidateKeys(orgId, deviceId);
      assert.deepEqual(resolved, [signingSecret]);
    });

    it('should record immutable audit logs upon key provisioning, rotation, and revocation', async () => {
      const devId = 'audit_test_device_99';
      const key1 = 'secret_key_audit_version_one_123456';
      const key2 = 'secret_key_audit_version_two_654321';

      // 1. Provision
      await smsGateKeyService.setDeviceSigningKey(orgId, devId, key1);

      // 2. Rotate
      await smsGateKeyService.rotateDeviceSigningKey(orgId, devId, key2);

      // 3. Revoke
      await smsGateKeyService.revokeDeviceKey(orgId, devId);

      const auditRows = await sql<Record<string, any>>`
        SELECT action, resource_type, metadata
        FROM audit_logs
        WHERE organization_id = ${orgId} AND resource_type = 'smsgate_signing_key'
        ORDER BY created_at ASC
      `;

      const actions = auditRows.map((r) => r.action);
      assert.ok(actions.includes('SMSGATE_KEY_PROVISIONED'), 'Must log provisioned event');
      assert.ok(actions.includes('SMSGATE_KEY_ROTATED'), 'Must log rotated event');
      assert.ok(actions.includes('SMSGATE_KEY_REVOKED'), 'Must log revoked event');
    });

    it('should fail closed if ENCRYPTION_MASTER_KEY is missing or invalid', async () => {
      const savedKey = process.env.ENCRYPTION_MASTER_KEY;
      try {
        delete process.env.ENCRYPTION_MASTER_KEY;

        // Decrypting without master key must fail closed
        await assert.rejects(
          async () => {
            await smsGateKeyService.resolveCandidateKeys(orgId, deviceId);
          },
          (err: Error) => {
            return err.message.includes('ENCRYPTION_MASTER_KEY is not configured or empty') ||
                   err.message.includes('Failed to decrypt');
          },
        );
      } finally {
        process.env.ENCRYPTION_MASTER_KEY = savedKey;
      }
    });
  });

  describe('2. HTTP Webhook Endpoint (POST /v1/messaging/webhooks/smsgate)', () => {
    let testProviderMessageId: string;

    beforeEach(async () => {
      testProviderMessageId = `smsgate_live_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      // Insert a submitted message to track delivery status transitions
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          delivered_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754112233', 'Test message delivery report',
          ${SmsStatus.SUBMITTED}, 1, 1, ${testProviderMessageId}, ${GatewayMode.MANAGED_GATEWAY},
          NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);
    });

    it('should verify exact raw body signature and transition message to DELIVERED', async () => {
      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: {
          messageId: testProviderMessageId,
          simNumber: 1,
        },
      };

      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret)
        .update(rawBody + timestamp, 'utf8')
        .digest('hex');

      // Dispatch simulated HTTP request
      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate?org=${orgId}`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: { org: orgId },
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        context: {},
      };

      // Find route handler
      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));
      assert.ok(route, 'Webhook route must be registered');

      const response = await route.handler(req);
      assert.equal(response.success, true);
      assert.equal(response.data.duplicate, false);
      assert.equal(response.data.status, 'DELIVERED');

      // Check database message state
      const rows = await sql<Record<string, any>>`
        SELECT status, delivered_at FROM sms_messages WHERE provider_message_id = ${testProviderMessageId}
      `;
      assert.equal(rows[0]!.status, SmsStatus.DELIVERED);
      assert.ok(rows[0]!.delivered_at, 'delivered_at must be populated');
    });

    it('should reject tampered raw body bytes with 401 INVALID_SIGNATURE', async () => {
      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: { messageId: testProviderMessageId },
      };

      const originalRawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret)
        .update(originalRawBody + timestamp, 'utf8')
        .digest('hex');

      // Tamper with body bytes (e.g. inject an extra space)
      const tamperedRawBody = JSON.stringify(payload) + ' ';

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate?org=${orgId}`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: { org: orgId },
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody: tamperedRawBody,
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      await assert.rejects(
        async () => {
          await route.handler(req);
        },
        (err: any) => {
          return err.statusCode === 401 && err.code === 'INVALID_SIGNATURE';
        },
      );
    });

    it('should reject expired timestamp older than tolerance with 400 TIMESTAMP_EXPIRED', async () => {
      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: { messageId: testProviderMessageId },
      };

      const rawBody = JSON.stringify(payload);
      // Expired: 400 seconds in the past
      const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 400);
      const signature = createHmac('sha256', signingSecret)
        .update(rawBody + expiredTimestamp, 'utf8')
        .digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate?org=${orgId}`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: { org: orgId },
        headers: {
          'x-signature': signature,
          'x-timestamp': expiredTimestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      await assert.rejects(
        async () => {
          await route.handler(req);
        },
        (err: any) => {
          return err.statusCode === 400 && err.code === 'TIMESTAMP_EXPIRED';
        },
      );
    });
  });

  describe('3. Durable Replay Protection & Idempotent Retry Handling', () => {
    it('should handle legitimate webhook retries idempotently returning HTTP 200 { duplicate: true }', async () => {
      const msgId = `msg_retry_test_${Date.now()}`;
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754998877', 'Retry test message',
          ${SmsStatus.SUBMITTED}, 1, 1, ${msgId}, ${GatewayMode.MANAGED_GATEWAY},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);

      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: { messageId: msgId },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate?org=${orgId}`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: { org: orgId },
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      // First attempt: Processes cleanly
      const firstRes = await route.handler(req);
      assert.equal(firstRes.success, true);
      assert.equal(firstRes.data.duplicate, false);

      // Verify recorded in durable smsgate_webhook_events table
      const eventRows = await sql<Record<string, any>>`
        SELECT * FROM smsgate_webhook_events WHERE provider_message_id = ${msgId}
      `;
      assert.equal(eventRows.length, 1);

      // Second attempt (identical retry from SMSGate): Returns duplicate: true without error
      const secondRes = await route.handler(req);
      assert.equal(secondRes.success, true);
      assert.equal(secondRes.data.duplicate, true);
      assert.ok(secondRes.data.message.includes('duplicate'));

      // Event count remains exactly 1 (no duplicate insertion)
      const eventRowsAfter = await sql<Record<string, any>>`
        SELECT * FROM smsgate_webhook_events WHERE provider_message_id = ${msgId}
      `;
      assert.equal(eventRowsAfter.length, 1);
    });

    it('should preserve terminal DELIVERED status and never trigger duplicate refunds on out-of-order FAILED retry', async () => {
      const msgId = `msg_terminal_${Date.now()}`;
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          delivered_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754998877', 'Terminal state message',
          ${SmsStatus.DELIVERED}, 1, 1, ${msgId}, ${GatewayMode.MANAGED_GATEWAY},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);

      const initialBalance = await messagingService.getBalance(orgId);

      // Late out-of-order FAILED event arrives for an already DELIVERED message
      const failedPayload = {
        event: 'sms:failed',
        deviceId,
        payload: { messageId: msgId, error: 'Carrier late failure report' },
      };
      const rawBody = JSON.stringify(failedPayload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate?org=${orgId}`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: { org: orgId },
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: failedPayload,
        rawBody,
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const response = await route.handler(req);
      assert.equal(response.success, true);

      // CRITICAL FINANCIAL INVARIANT: Status must remain DELIVERED
      const msgCheck = await sql<Record<string, any>>`
        SELECT status FROM sms_messages WHERE provider_message_id = ${msgId}
      `;
      assert.equal(msgCheck[0]!.status, SmsStatus.DELIVERED);

      // CRITICAL FINANCIAL INVARIANT: Balance must NOT change (no illegal refund for delivered message)
      const finalBalance = await messagingService.getBalance(orgId);
      assert.equal(finalBalance, initialBalance);
    });
  });
});
