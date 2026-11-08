import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { sql, resetTestDatabaseState } from '@brisksms/db';
import { createApp } from '../src/app.js';
import { smsGateKeyService } from '../src/modules/messaging/services/smsgate-key.service.js';
import { messagingService } from '../src/modules/messaging/messaging.service.js';
import { smsGateProvider } from '../src/modules/messaging/providers/smsgate.provider.js';
import { isEncryptedSecret, validateProductionEncryptionConfig, INSECURE_DEFAULT_KEYS } from '../src/core/crypto.js';
import { SmsStatus, GatewayMode } from '@brisksms/shared';

describe('Milestone 2.6: Webhook Identity, Tenant Binding and Key-Rotation Security Review', () => {
  const router = createApp();
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const deviceId = 'android_dev_relay_001';
  const otherDeviceId = 'android_dev_relay_other_999';
  const signingSecret = 'very_secure_device_webhook_signing_secret_12345';
  const otherSigningSecret = 'other_tenant_device_signing_secret_67890';
  const masterKey = 'brisksms_dev_encryption_master_key_32_bytes_min!';

  before(async () => {
    process.env.ENCRYPTION_MASTER_KEY = masterKey;
    await resetTestDatabaseState();

    // Create test organizations
    await sql`
      INSERT INTO organizations (id, name, slug, country_code, timezone, plan_tier, is_active)
      VALUES (${orgId}, 'Test Org 2.6', ${`org-26-${Date.now()}`}, 'TZA', 'Africa/Dar_es_Salaam', 'ENTERPRISE', true),
             (${otherOrgId}, 'Other Org 2.6', ${`other-26-${Date.now()}`}, 'TZA', 'Africa/Dar_es_Salaam', 'ENTERPRISE', true)
    `;

    // Fund messaging accounts
    await messagingService.purchaseCredits(orgId, 100, 'initial_funding_org_a');
    await messagingService.purchaseCredits(otherOrgId, 100, 'initial_funding_org_b');
  });

  beforeEach(async () => {
    smsGateKeyService.clearAll();
    smsGateProvider.clearReplayCache();
  });

  // =========================================================================
  // SECTION 1 & 4: Signing-Key Storage, Encryption at Rest & Key Rotation
  // =========================================================================
  describe('1 & 4. SMSGate Key Management, Encryption at Rest & Verified Rotation', () => {
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

    it('should accept signatures from both currentKey and previousKey during grace period', async () => {
      const devId = 'rotation_grace_device_01';
      const key1 = 'signing_secret_old_generation_12345';
      const key2 = 'signing_secret_new_generation_67890';

      // Provision initial key
      await smsGateKeyService.setDeviceSigningKey(orgId, devId, key1);

      // Rotate to new key
      await smsGateKeyService.rotateDeviceSigningKey(orgId, devId, key2);

      // Candidate keys must return [currentKey, previousKey]
      const candidates = await smsGateKeyService.resolveCandidateKeys(orgId, devId);
      assert.deepEqual(candidates, [key2, key1]);

      // Verify that signatures computed with either key pass verification
      const rawBody = JSON.stringify({ event: 'sms:delivered', deviceId: devId, payload: { messageId: 'rot_msg_1' } });
      const ts = String(Math.floor(Date.now() / 1000));

      const sigOld = createHmac('sha256', key1).update(rawBody + ts).digest('hex');
      const sigNew = createHmac('sha256', key2).update(rawBody + ts).digest('hex');

      assert.equal(smsGateProvider.verifyWebhookSignature(rawBody, sigOld, ts, candidates), true);
      assert.equal(smsGateProvider.verifyWebhookSignature(rawBody, sigNew, ts, candidates), true);

      // Random third key must fail
      const sigBogus = createHmac('sha256', 'bogus_unauthorized_key_99999').update(rawBody + ts).digest('hex');
      assert.equal(smsGateProvider.verifyWebhookSignature(rawBody, sigBogus, ts, candidates), false);
    });

    it('should persist keys and grace periods across API restart (cache reset)', async () => {
      const devId = 'restart_test_device_02';
      const key1 = 'restart_secret_old_generation_11111';
      const key2 = 'restart_secret_new_generation_22222';

      await smsGateKeyService.setDeviceSigningKey(orgId, devId, key1);
      await smsGateKeyService.rotateDeviceSigningKey(orgId, devId, key2);

      // Simulate complete API process restart by purging memory cache
      smsGateKeyService.clearAll();

      // Read from database
      const candidates = await smsGateKeyService.resolveCandidateKeys(orgId, devId);
      assert.deepEqual(candidates, [key2, key1]);
    });

    it('should fail closed when encrypted key records are tampered or corrupted', async () => {
      const devId = 'corrupt_key_device_03';
      await smsGateKeyService.setDeviceSigningKey(orgId, devId, signingSecret);

      // Tamper with the encrypted ciphertext in PostgreSQL
      await sql`
        UPDATE smsgate_signing_keys
        SET encrypted_key = 'aes-256-gcm:000000000000000000000000:ffffffffffffffffffffffffffffffff:deadbeef'
        WHERE organization_id = ${orgId} AND device_id = ${devId}
      `;

      smsGateKeyService.clearAll();

      await assert.rejects(
        async () => {
          await smsGateKeyService.resolveCandidateKeys(orgId, devId);
        },
        (err: Error) => {
          return err.message.includes('Failed to decrypt active SMSGate signing key');
        },
      );
    });

    it('should fail closed if ENCRYPTION_MASTER_KEY is missing or invalid', async () => {
      const savedKey = process.env.ENCRYPTION_MASTER_KEY;
      try {
        delete process.env.ENCRYPTION_MASTER_KEY;
        smsGateKeyService.clearAll();

        await assert.rejects(
          async () => {
            await smsGateKeyService.resolveCandidateKeys(orgId, deviceId);
          },
          (err: Error) => {
            return (
              err.message.includes('ENCRYPTION_MASTER_KEY is not configured or empty') ||
              err.message.includes('Failed to decrypt')
            );
          },
        );
      } finally {
        process.env.ENCRYPTION_MASTER_KEY = savedKey;
      }
    });

    it('should enforce strict tenant isolation after rotation', async () => {
      const devId = 'isolation_rot_dev_04';
      await smsGateKeyService.setDeviceSigningKey(orgId, devId, signingSecret);
      await smsGateKeyService.rotateDeviceSigningKey(orgId, devId, 'rotated_secret_9999999999');

      // Attempt lookup from other organization
      const otherKeys = await smsGateKeyService.resolveCandidateKeys(otherOrgId, devId);
      assert.deepEqual(otherKeys, [], 'Other tenant must not resolve keys for another org device');
    });
  });

  // =========================================================================
  // SECTION 3: Authoritative Tenant and Device Identity Resolution
  // =========================================================================
  describe('3. Authoritative Tenant & Device Identity Resolution', () => {
    let testMsgA: string;
    let testMsgB: string;

    beforeEach(async () => {
      testMsgA = `msg_tenant_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      testMsgB = `msg_tenant_b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          delivered_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754112233', 'Message Tenant A',
          ${SmsStatus.SUBMITTED}, 1, 1, ${testMsgA}, ${GatewayMode.MANAGED_GATEWAY},
          NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ), (
          ${randomUUID()}, ${otherOrgId}, '+255754998877', 'Message Tenant B',
          ${SmsStatus.SUBMITTED}, 1, 1, ${testMsgB}, ${GatewayMode.MANAGED_GATEWAY},
          NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);
      await smsGateKeyService.setDeviceSigningKey(otherOrgId, otherDeviceId, otherSigningSecret);
    });

    it('should accept webhook when device is authoritatively registered to the organization', async () => {
      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: { messageId: testMsgA },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const response = await route.handler(req);
      assert.equal(response.success, true);
      assert.equal(response.data.duplicate, false);
      assert.equal(response.data.status, 'DELIVERED');
    });

    it('should reject forged organization query parameter (?org=forgedOrg) with 403 TENANT_DEVICE_MISMATCH', async () => {
      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: { messageId: testMsgA },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate?org=${otherOrgId}`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: { org: otherOrgId }, // Forged org query parameter
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      await assert.rejects(
        async () => {
          await route.handler(req);
        },
        (err: any) => {
          return err.statusCode === 403 && err.code === 'TENANT_DEVICE_MISMATCH';
        },
      );
    });

    it('should reject wrong organization header (x-organization-id) with 403 TENANT_DEVICE_MISMATCH', async () => {
      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: { messageId: testMsgA },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'x-organization-id': otherOrgId, // Conflicting header
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      await assert.rejects(
        async () => {
          await route.handler(req);
        },
        (err: any) => {
          return err.statusCode === 403 && err.code === 'TENANT_DEVICE_MISMATCH';
        },
      );
    });

    it('should reject unknown device with 404 UNKNOWN_DEVICE', async () => {
      const payload = {
        event: 'sms:delivered',
        deviceId: 'completely_unknown_device_99999',
        payload: { messageId: testMsgA },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      await assert.rejects(
        async () => {
          await route.handler(req);
        },
        (err: any) => {
          return err.statusCode === 404 && err.code === 'UNKNOWN_DEVICE';
        },
      );
    });

    it('should reject revoked device with 403 DEVICE_REVOKED', async () => {
      const revokedDevId = randomUUID();
      // Insert revoked device record in devices table
      await sql`
        INSERT INTO devices (
          id, organization_id, label, device_model, manufacturer,
          android_version, app_version, public_key_pem, device_token_hash,
          status, ingestion_mode, revoked_at, revocation_reason, created_at, updated_at
        ) VALUES (
          ${revokedDevId}, ${orgId}, 'Revoked Device', 'Pixel 7', 'Google',
          '14', '1.0.0', 'pem', ${`token_${Date.now()}`},
          'REVOKED', 'NOTIFICATION_LISTENER', CURRENT_TIMESTAMP, 'Stolen device decommission',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, revokedDevId, signingSecret);

      const payload = {
        event: 'sms:delivered',
        deviceId: revokedDevId,
        payload: { messageId: testMsgA },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      await assert.rejects(
        async () => {
          await route.handler(req);
        },
        (err: any) => {
          return err.statusCode === 403 && err.code === 'DEVICE_REVOKED';
        },
      );
    });

    it('should reject valid message ID associated with another organization with 403 TENANT_MESSAGE_MISMATCH', async () => {
      // Attacker uses Org A's valid device and signing key to send delivery report for Org B's message
      const payload = {
        event: 'sms:delivered',
        deviceId, // Belongs to Org A
        payload: { messageId: testMsgB }, // Belongs to Org B!
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      await assert.rejects(
        async () => {
          await route.handler(req);
        },
        (err: any) => {
          return err.statusCode === 403 && (err.code === 'TENANT_MESSAGE_MISMATCH' || err.code === 'CROSS_TENANT_FORBIDDEN');
        },
      );
    });

    it('should reject ambiguous device identity registered across multiple organizations with 409 AMBIGUOUS_DEVICE_IDENTITY', async () => {
      const sharedDevId = 'ambiguous_shared_device_conflict';
      // Deliberately register the same deviceId under both Org A and Org B in PostgreSQL
      await sql`
        INSERT INTO smsgate_signing_keys (
          id, organization_id, device_id, encrypted_key, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, ${sharedDevId}, 'aes-256-gcm:fake1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ), (
          ${randomUUID()}, ${otherOrgId}, ${sharedDevId}, 'aes-256-gcm:fake2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await assert.rejects(
        async () => {
          await smsGateKeyService.resolveAuthoritativeDeviceOrganization(sharedDevId);
        },
        (err: any) => {
          return err.statusCode === 409 && err.code === 'AMBIGUOUS_DEVICE_IDENTITY';
        },
      );
    });
  });

  // =========================================================================
  // SECTION 5: Exact Raw-Body Byte Handling & Signature Verification
  // =========================================================================
  describe('5. Exact Raw-Body Byte Handling & Cryptographic Verification', () => {
    let testMsgRaw: string;

    beforeEach(async () => {
      testMsgRaw = `msg_raw_${Date.now()}`;
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          delivered_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754112233', 'Raw body test',
          ${SmsStatus.SUBMITTED}, 1, 1, ${testMsgRaw}, ${GatewayMode.MANAGED_GATEWAY},
          NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);
    });

    it('should verify raw body with extra JSON whitespace without reserialization distortion', async () => {
      // Body has intentional spacing, indentation, and newlines
      const rawBodyWithSpaces = `{\n  "event": "sms:delivered",\n  "deviceId": "${deviceId}",\n  "payload": {\n    "messageId": "${testMsgRaw}"\n  }\n}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBodyWithSpaces + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: JSON.parse(rawBodyWithSpaces),
        rawBody: rawBodyWithSpaces,
        rawBodyBuffer: Buffer.from(rawBodyWithSpaces, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const response = await route.handler(req);
      assert.equal(response.success, true);
      assert.equal(response.data.status, 'DELIVERED');
    });

    it('should verify raw body with alternative property ordering without reserialization normalization', async () => {
      // Reverse property order: payload first, then event, then deviceId
      const reverseJson = `{"payload":{"messageId":"${testMsgRaw}"},"event":"sms:delivered","deviceId":"${deviceId}"}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(reverseJson + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: JSON.parse(reverseJson),
        rawBody: reverseJson,
        rawBodyBuffer: Buffer.from(reverseJson, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const response = await route.handler(req);
      assert.equal(response.success, true);
    });

    it('should verify raw body containing non-ASCII Unicode and Swahili diacritics byte-for-byte', async () => {
      const unicodePayload = {
        event: 'sms:delivered',
        deviceId,
        payload: {
          messageId: testMsgRaw,
          note: 'Malipo ya TZS 50,000 yamepokelewa vizuri! 🎉 Karibu tena ndugu mteja.',
        },
      };
      const rawBody = JSON.stringify(unicodePayload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: unicodePayload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const response = await route.handler(req);
      assert.equal(response.success, true);
    });

    it('should verify raw body with escaped characters (\\n, \\", \\/)', async () => {
      const escapedJson = `{"event":"sms:delivered","deviceId":"${deviceId}","payload":{"messageId":"${testMsgRaw}","memo":"Line 1\\nLine 2 with \\"quotes\\" and http:\\/\\/example.com"}}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(escapedJson + timestamp, 'utf8').digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: JSON.parse(escapedJson),
        rawBody: escapedJson,
        rawBodyBuffer: Buffer.from(escapedJson, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const response = await route.handler(req);
      assert.equal(response.success, true);
    });

    it('should reject malformed JSON with 400 INVALID_JSON', async () => {
      const malformedRaw = '{"event": "sms:delivered", "deviceId": "dev", payload: unquoted}';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(malformedRaw + timestamp, 'utf8').digest('hex');

      // Test HTTP router handling of malformed JSON
      const mockReq: any = {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          'content-type': 'application/json',
          'x-signature': signature,
          'x-timestamp': timestamp,
        },
        url: '/v1/messaging/webhooks/smsgate',
        on(event: string, cb: any) {
          if (event === 'data') cb(Buffer.from(malformedRaw));
          if (event === 'end') cb();
        },
      };

      let writtenStatus = 0;
      let writtenBody = '';
      const mockRes: any = {
        setHeader() {},
        writeHead(status: number) {
          writtenStatus = status;
        },
        end(data?: string) {
          writtenBody = data || '';
        },
      };

      await router.handle(mockReq, mockRes);
      assert.equal(writtenStatus, 400);
      assert.ok(writtenBody.includes('INVALID_JSON'));
    });

    it('should reject modified timestamp without re-signing with 401 INVALID_SIGNATURE', async () => {
      const payload = { event: 'sms:delivered', deviceId, payload: { messageId: testMsgRaw } };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', signingSecret).update(rawBody + timestamp, 'utf8').digest('hex');

      // Tampered timestamp in header (changed by +1 second)
      const tamperedTimestamp = String(parseInt(timestamp, 10) + 1);

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': tamperedTimestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
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

    it('should verify official SMSGate Python/Go/Rust HMAC-SHA256 test vector accurately', () => {
      const testSecret = 'official_smsgate_signing_key_32c';
      const testBody = '{"event":"sms:delivered","payload":{"messageId":"msg_test_vector"}}';
      const testTs = String(Math.floor(Date.now() / 1000));

      // Computed reference hash
      const expectedHash = createHmac('sha256', testSecret).update(testBody + testTs).digest('hex');

      const result = smsGateProvider.verifyWebhookSignatureDetailed(
        Buffer.from(testBody, 'utf8'),
        expectedHash,
        testTs,
        testSecret,
      );
      assert.equal(result.isValid, true);
    });
  });

  // =========================================================================
  // SECTION 2 & 6: Durable Event Identity, Idempotency & Transaction Boundaries
  // =========================================================================
  describe('2 & 6. Durable Event Identity, Idempotency & Transaction Boundaries', () => {
    it('should recognize retried webhook as duplicate even when timestamp and signature change', async () => {
      const msgId = `msg_retry_ts_diff_${Date.now()}`;
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754998877', 'Retry with different timestamp',
          ${SmsStatus.SUBMITTED}, 1, 1, ${msgId}, ${GatewayMode.MANAGED_GATEWAY},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);

      const payload = {
        event: 'sms:delivered',
        deviceId,
        payload: {
          messageId: msgId,
          deliveredAt: '2024-06-22T15:46:11.000+07:00',
        },
      };
      const rawBody = JSON.stringify(payload);

      // Attempt 1: Delivered at T0
      const ts1 = String(Math.floor(Date.now() / 1000) - 10);
      const sig1 = createHmac('sha256', signingSecret).update(rawBody + ts1, 'utf8').digest('hex');

      const req1: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': sig1,
          'x-timestamp': ts1,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      // First delivery attempt
      const res1 = await route.handler(req1);
      assert.equal(res1.success, true);
      assert.equal(res1.data.duplicate, false);

      // Attempt 2: SMSGate gateway retries 5 seconds later with NEW timestamp and NEW signature!
      const ts2 = String(Math.floor(Date.now() / 1000));
      const sig2 = createHmac('sha256', signingSecret).update(rawBody + ts2, 'utf8').digest('hex');

      // Verify that sig2 is indeed different from sig1
      assert.notEqual(sig1, sig2, 'Signature must differ due to updated timestamp');

      const req2: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': sig2,
          'x-timestamp': ts2,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      // Second delivery attempt: MUST recognize as duplicate despite different signature and timestamp
      const res2 = await route.handler(req2);
      assert.equal(res2.success, true);
      assert.equal(res2.data.duplicate, true);

      // Verify exact count in PostgreSQL: Exactly 1 record
      const eventRows = await sql<Record<string, any>>`
        SELECT * FROM smsgate_webhook_events WHERE provider_message_id = ${msgId}
      `;
      assert.equal(eventRows.length, 1);
    });

    it('should process two distinct events for the same provider message ID (sms:sent followed by sms:delivered)', async () => {
      const msgId = `msg_lifecycle_${Date.now()}`;
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754998877', 'Lifecycle test message',
          ${SmsStatus.QUEUED}, 1, 1, ${msgId}, ${GatewayMode.MANAGED_GATEWAY},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      // Event 1: sms:sent
      const sentPayload = { event: 'sms:sent', deviceId, payload: { messageId: msgId, sentAt: '2024-06-22T15:40:00Z' } };
      const sentRaw = JSON.stringify(sentPayload);
      const tsSent = String(Math.floor(Date.now() / 1000));
      const sigSent = createHmac('sha256', signingSecret).update(sentRaw + tsSent).digest('hex');

      const resSent = await route.handler({
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: { 'x-signature': sigSent, 'x-timestamp': tsSent, 'content-type': 'application/json' },
        body: sentPayload,
        rawBody: sentRaw,
        rawBodyBuffer: Buffer.from(sentRaw, 'utf8'),
        context: {},
      });
      assert.equal(resSent.success, true);
      assert.equal(resSent.data.status, 'SENT');
      assert.equal(resSent.data.duplicate, false);

      // Verify message updated to SUBMITTED
      const check1 = await sql<Record<string, any>>`SELECT status FROM sms_messages WHERE provider_message_id = ${msgId}`;
      assert.equal(check1[0]!.status, SmsStatus.SUBMITTED);

      // Event 2: sms:delivered for the SAME message ID
      const delivPayload = { event: 'sms:delivered', deviceId, payload: { messageId: msgId, deliveredAt: '2024-06-22T15:45:00Z' } };
      const delivRaw = JSON.stringify(delivPayload);
      const tsDeliv = String(Math.floor(Date.now() / 1000));
      const sigDeliv = createHmac('sha256', signingSecret).update(delivRaw + tsDeliv).digest('hex');

      const resDeliv = await route.handler({
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: { 'x-signature': sigDeliv, 'x-timestamp': tsDeliv, 'content-type': 'application/json' },
        body: delivPayload,
        rawBody: delivRaw,
        rawBodyBuffer: Buffer.from(delivRaw, 'utf8'),
        context: {},
      });
      assert.equal(resDeliv.success, true);
      assert.equal(resDeliv.data.status, 'DELIVERED');
      assert.equal(resDeliv.data.duplicate, false);

      // Verify message updated to DELIVERED
      const check2 = await sql<Record<string, any>>`SELECT status FROM sms_messages WHERE provider_message_id = ${msgId}`;
      assert.equal(check2[0]!.status, SmsStatus.DELIVERED);

      // Exactly 2 distinct events persisted in smsgate_webhook_events
      const eventRows = await sql<Record<string, any>>`
        SELECT event_type FROM smsgate_webhook_events WHERE provider_message_id = ${msgId} ORDER BY first_seen_at ASC
      `;
      assert.equal(eventRows.length, 2);
      assert.equal(eventRows[0]!.event_type, 'SENT');
      assert.equal(eventRows[1]!.event_type, 'DELIVERED');
    });

    it('should stably deduplicate events containing official upstream event ID (id: Ey6ECgOkVVFjz3CL48B8C)', async () => {
      const msgId = `msg_upstream_id_${Date.now()}`;
      const upstreamId = 'Ey6ECgOkVVFjz3CL48B8C';

      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754998877', 'Upstream event ID test',
          ${SmsStatus.SUBMITTED}, 1, 1, ${msgId}, ${GatewayMode.MANAGED_GATEWAY},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);

      const payload = {
        id: upstreamId, // Authoritative upstream event ID
        event: 'sms:delivered',
        deviceId,
        payload: { messageId: msgId },
      };
      const rawBody = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', signingSecret).update(rawBody + ts).digest('hex');

      const req: any = {
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: { 'x-signature': sig, 'x-timestamp': ts, 'content-type': 'application/json' },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      };

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const res1 = await route.handler(req);
      assert.equal(res1.success, true);
      assert.equal(res1.data.duplicate, false);

      // Retry with new timestamp and signature
      const tsRetry = String(Math.floor(Date.now() / 1000) + 1);
      const sigRetry = createHmac('sha256', signingSecret).update(rawBody + tsRetry).digest('hex');

      const res2 = await route.handler({
        ...req,
        headers: { 'x-signature': sigRetry, 'x-timestamp': tsRetry, 'content-type': 'application/json' },
      });
      assert.equal(res2.success, true);
      assert.equal(res2.data.duplicate, true);
    });

    it('should atomically roll back entire transaction if processing throws', async () => {
      const msgId = `msg_tx_fail_${Date.now()}`;
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754998877', 'Transaction rollback test',
          ${SmsStatus.SUBMITTED}, 1, 1, ${msgId}, ${GatewayMode.MANAGED_GATEWAY},
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;

      await smsGateKeyService.setDeviceSigningKey(orgId, deviceId, signingSecret);

      const payload = {
        event: 'sms:failed',
        deviceId,
        payload: { messageId: msgId, error: 'Network failure' },
      };
      const rawBody = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', signingSecret).update(rawBody + ts).digest('hex');

      const eventFingerprint = 'test_tx_rollback_fingerprint_001';

      // Simulate a failure inside the transaction by temporarily altering a database constraint or passing invalid params
      await assert.rejects(
        async () => {
          await messagingService.processSmsGateWebhookDelivery({
            organizationId: orgId,
            deviceId,
            eventFingerprint,
            event: {
              providerMessageId: msgId,
              eventType: 'FAILED',
              carrierTimestamp: new Date(),
            },
            signature: sig,
            timestamp: 'INVALID_NON_NUMERIC_TIMESTAMP', // Causes BigInt(timestamp) to throw SyntaxError!
          });
        },
      );

      // Verify transaction rollback: No event record must exist in smsgate_webhook_events
      const eventRows = await sql<Record<string, any>>`
        SELECT * FROM smsgate_webhook_events WHERE event_fingerprint = ${eventFingerprint}
      `;
      assert.equal(eventRows.length, 0, 'Rolled-back transaction must leave no event record');

      // Verify message status remains SUBMITTED (not FAILED)
      const msgCheck = await sql<Record<string, any>>`
        SELECT status FROM sms_messages WHERE provider_message_id = ${msgId}
      `;
      assert.equal(msgCheck[0]!.status, SmsStatus.SUBMITTED);
    });

    it('should safely handle concurrent identical requests without duplicate mutations', async () => {
      const msgId = `msg_concurrent_${Date.now()}`;
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${orgId}, '+255754998877', 'Concurrent webhook test',
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

      const routes = (router as any).routes;
      const route = routes.find((r: any) => r.method === 'POST' && r.pattern.test('/v1/messaging/webhooks/smsgate'));

      const makeReq = () => ({
        method: 'POST',
        url: new URL(`http://localhost:3000/v1/messaging/webhooks/smsgate`),
        path: '/v1/messaging/webhooks/smsgate',
        params: {},
        query: {},
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        body: payload,
        rawBody,
        rawBodyBuffer: Buffer.from(rawBody, 'utf8'),
        context: {},
      });

      // Fire 3 simultaneous concurrent requests
      const [res1, res2, res3] = await Promise.all([
        route.handler(makeReq()),
        route.handler(makeReq()),
        route.handler(makeReq()),
      ]);

      assert.equal(res1.success, true);
      assert.equal(res2.success, true);
      assert.equal(res3.success, true);

      // Exactly one must be duplicate: false, and the other two must be duplicate: true
      const duplicates = [res1.data.duplicate, res2.data.duplicate, res3.data.duplicate];
      const nonDuplicateCount = duplicates.filter((d) => d === false).length;
      const duplicateCount = duplicates.filter((d) => d === true).length;

      assert.equal(nonDuplicateCount, 1, 'Exactly one concurrent request must process the event');
      assert.equal(duplicateCount, 2, 'Remaining concurrent requests must be identified as duplicates');

      // Database record count must be exactly 1
      const countRows = await sql<Record<string, any>>`
        SELECT COUNT(*)::int as count FROM smsgate_webhook_events WHERE provider_message_id = ${msgId}
      `;
      assert.equal(countRows[0]!.count, 1);
    });
  });

  // =========================================================================
  // SECTION 7: CI & Production Encryption Configuration Security Audit
  // =========================================================================
  describe('7. CI & Production Encryption Configuration Security Audit', () => {
    it('should fail closed in production if ENCRYPTION_MASTER_KEY is missing', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevKey = process.env.ENCRYPTION_MASTER_KEY;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.ENCRYPTION_MASTER_KEY;

        assert.throws(
          () => {
            validateProductionEncryptionConfig();
          },
          /FATAL: ENCRYPTION_MASTER_KEY is not configured in production environment/,
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
        process.env.ENCRYPTION_MASTER_KEY = prevKey;
      }
    });

    it('should refuse to start in production if ENCRYPTION_MASTER_KEY matches CI or dev test defaults', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevKey = process.env.ENCRYPTION_MASTER_KEY;
      try {
        process.env.NODE_ENV = 'production';

        for (const testKey of INSECURE_DEFAULT_KEYS) {
          process.env.ENCRYPTION_MASTER_KEY = testKey;
          assert.throws(
            () => {
              validateProductionEncryptionConfig();
            },
            /FATAL: Insecure or test ENCRYPTION_MASTER_KEY detected in production environment/,
          );
        }
      } finally {
        process.env.NODE_ENV = prevEnv;
        process.env.ENCRYPTION_MASTER_KEY = prevKey;
      }
    });

    it('should refuse to start in production if ENCRYPTION_MASTER_KEY is less than 32 characters', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevKey = process.env.ENCRYPTION_MASTER_KEY;
      try {
        process.env.NODE_ENV = 'production';
        process.env.ENCRYPTION_MASTER_KEY = 'short_key_under_32_characters';

        assert.throws(
          () => {
            validateProductionEncryptionConfig();
          },
          /FATAL: ENCRYPTION_MASTER_KEY must be at least 32 characters in production/,
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
        process.env.ENCRYPTION_MASTER_KEY = prevKey;
      }
    });

    it('should pass validation in production when a secure, high-entropy 32+ character key is provided', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevKey = process.env.ENCRYPTION_MASTER_KEY;
      try {
        process.env.NODE_ENV = 'production';
        process.env.ENCRYPTION_MASTER_KEY = 'c8b9d3e5f2a10748b6c4e2d091837562a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2';

        assert.doesNotThrow(() => {
          validateProductionEncryptionConfig();
        });
      } finally {
        process.env.NODE_ENV = prevEnv;
        process.env.ENCRYPTION_MASTER_KEY = prevKey;
      }
    });
  });
});
