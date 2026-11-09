import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { GatewayMode } from '@brisksms/shared';
import { SmsGateProvider } from '../src/modules/messaging/providers/smsgate.provider.js';
import { smsGateKeyService } from '../src/modules/messaging/services/smsgate-key.service.js';

describe('Milestone 2.4: SMSGate Protocol Verification, Webhook Security & Credential Hardening', () => {
  const provider = new SmsGateProvider();
  const orgAId = randomUUID();
  const orgBId = randomUUID();

  beforeEach(() => {
    provider.clearReplayCache();
    smsGateKeyService.clearAll();
  });

  describe('1. Endpoint Path Resolution, Normalization & SSRF Defense', () => {
    it('should resolve standard managed server base URL with or without trailing slash', () => {
      assert.equal(
        provider.resolveEndpoint('https://sms.example.com/api/3rdparty/v1'),
        'https://sms.example.com/api/3rdparty/v1/messages',
      );
      assert.equal(
        provider.resolveEndpoint('https://sms.example.com/api/3rdparty/v1/'),
        'https://sms.example.com/api/3rdparty/v1/messages',
      );
    });

    it('should resolve official Cloud Relay endpoint correctly', () => {
      assert.equal(
        provider.resolveEndpoint('https://api.sms-gate.app/3rdparty/v1'),
        'https://api.sms-gate.app/3rdparty/v1/messages',
      );
      assert.equal(
        provider.resolveEndpoint('https://api.sms-gate.app/3rdparty/v1/'),
        'https://api.sms-gate.app/3rdparty/v1/messages',
      );
    });

    it('should resolve custom reverse-proxy /api/v1 paths cleanly without double-appending', () => {
      assert.equal(
        provider.resolveEndpoint('https://gateway.brisksms.com/api/v1'),
        'https://gateway.brisksms.com/api/v1/messages',
      );
      assert.equal(
        provider.resolveEndpoint('https://gateway.brisksms.com/api/v1/'),
        'https://gateway.brisksms.com/api/v1/messages',
      );
    });

    it('should preserve endpoints that already contain /messages or /message', () => {
      assert.equal(
        provider.resolveEndpoint('https://sms.example.com/api/3rdparty/v1/messages'),
        'https://sms.example.com/api/3rdparty/v1/messages',
      );
      assert.equal(
        provider.resolveEndpoint('https://sms.example.com/api/3rdparty/v1/message'),
        'https://sms.example.com/api/3rdparty/v1/message',
      );
    });

    it('should reject invalid or malicious URL schemes', () => {
      assert.throws(
        () => provider.resolveEndpoint('javascript:alert("pwned")'),
        /Invalid gateway URL scheme/,
      );
      assert.throws(
        () => provider.resolveEndpoint('ftp://insecure.gateway/'),
        /Invalid gateway URL scheme/,
      );
      assert.throws(
        () => provider.resolveEndpoint('file:///etc/passwd'),
        /Invalid gateway URL scheme/,
      );
    });

    it('should prevent SSRF by rejecting loopback, link-local, cloud metadata, and private IP ranges', () => {
      const prevEnv = process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS;
      delete process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS;

      try {
        // Loopback destinations
        assert.throws(
          () => provider.resolveEndpoint('http://localhost:8080/api/v1'),
          /prohibited internal or private network destination/,
        );
        assert.throws(
          () => provider.resolveEndpoint('http://127.0.0.1:8080/api/v1'),
          /prohibited internal or private network destination/,
        );
        assert.throws(
          () => provider.resolveEndpoint('http://127.0.0.2:8080/api/v1'),
          /prohibited internal or private network destination/,
        );

        // Cloud metadata & Link-local addresses
        assert.throws(
          () => provider.resolveEndpoint('http://169.254.169.254/latest/meta-data'),
          /prohibited internal or private network destination/,
        );
        assert.throws(
          () => provider.resolveEndpoint('http://metadata.google.internal/computeMetadata/v1'),
          /prohibited internal or private network destination/,
        );

        // RFC 1918 Private IP spaces
        assert.throws(
          () => provider.resolveEndpoint('http://10.0.0.5:8080/api/v1'),
          /prohibited internal or private network destination/,
        );
        assert.throws(
          () => provider.resolveEndpoint('http://192.168.1.100:8080/api/v1'),
          /prohibited internal or private network destination/,
        );
        assert.throws(
          () => provider.resolveEndpoint('http://172.20.0.5:8080/api/v1'),
          /prohibited internal or private network destination/,
        );
      } finally {
        if (prevEnv !== undefined) {
          process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS = prevEnv;
        }
      }
    });

    it('should permit private/local gateways when ALLOW_PRIVATE_GATEWAY_NETWORKS is explicitly enabled', () => {
      const prevEnv = process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS;
      process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS = 'true';

      try {
        const local = provider.resolveEndpoint('http://192.168.1.150:8080/api/3rdparty/v1');
        assert.equal(local, 'http://192.168.1.150:8080/api/3rdparty/v1/messages');
      } finally {
        if (prevEnv !== undefined) {
          process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS = prevEnv;
        } else {
          delete process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS;
        }
      }
    });
  });

  describe('2. Explicit Credential Configuration & Authentication Hardening', () => {
    it('should format HTTP Basic header for valid explicit Basic credentials', () => {
      const username = 'test_gateway_admin';
      const password = 'test_mock_password_fixture';
      const expectedEncoded = Buffer.from(`${username}:${password}`).toString('base64');
      const header = provider.buildAuthHeader({
        type: 'BASIC',
        username,
        password,
      });
      assert.equal(header, `Basic ${expectedEncoded}`);
    });

    it('should reject invalid or missing Basic credentials without guessing', () => {
      assert.throws(
        () => provider.buildAuthHeader({ type: 'BASIC', username: '', password: 'pwd' }),
        /Invalid Basic credentials/,
      );
      assert.throws(
        () => provider.buildAuthHeader({ type: 'BASIC', username: 'admin', password: '   ' }),
        /Invalid Basic credentials/,
      );
      assert.throws(
        () => provider.buildAuthHeader({ type: 'BASIC' } as any),
        /Invalid Basic credentials/,
      );
    });

    it('should format Bearer header for valid explicit Bearer credentials', () => {
      const header = provider.buildAuthHeader({
        type: 'BEARER',
        token: 'bsk_gateway_token_12345678',
      });
      assert.equal(header, 'Bearer bsk_gateway_token_12345678');
    });

    it('should reject invalid Bearer credentials', () => {
      assert.throws(
        () => provider.buildAuthHeader({ type: 'BEARER', token: '   ' }),
        /Invalid Bearer credentials/,
      );
      assert.throws(
        () => provider.buildAuthHeader({ type: 'BEARER' } as any),
        /Invalid Bearer credentials/,
      );
    });

    it('should accept valid non-expired JWT Bearer access token', () => {
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
      const payloadB64 = Buffer.from(JSON.stringify({ sub: 'user_1', exp: futureExp })).toString('base64url');
      const validJwt = `${headerB64}.${payloadB64}.mock_signature_hash`;

      const header = provider.buildAuthHeader({ type: 'BEARER', token: validJwt });
      assert.equal(header, `Bearer ${validJwt}`);
    });

    it('should reject expired JWT Bearer access token', () => {
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const pastExp = Math.floor(Date.now() / 1000) - 300; // 5 minutes in past
      const payloadB64 = Buffer.from(JSON.stringify({ sub: 'user_1', exp: pastExp })).toString('base64url');
      const expiredJwt = `${headerB64}.${payloadB64}.mock_signature_hash`;

      assert.throws(
        () => provider.buildAuthHeader({ type: 'BEARER', token: expiredJwt }),
        /Bearer JWT access token is expired/,
      );
    });

    it('should reject ambiguous raw strings and unknown credential types', () => {
      assert.throws(
        () => provider.buildAuthHeader('admin:password123'),
        /Ambiguous credential string: Explicit credential type \(BASIC or BEARER\) is required/,
      );
      assert.throws(
        () => provider.buildAuthHeader('random_token_string'),
        /Ambiguous credential string: Explicit credential type \(BASIC or BEARER\) is required/,
      );
      assert.throws(
        () => provider.buildAuthHeader({ type: 'OAUTH2' } as any),
        /Unsupported or missing credential type: "OAUTH2"/,
      );
      assert.throws(
        () => provider.buildAuthHeader(null as any),
        /Authentication credentials must be provided/,
      );
    });
  });

  describe('3. Strict Schema Serialization (Single-Field Invariant)', () => {
    it('should serialize payload strictly matching docs.sms-gate.app specification', async () => {
      let capturedBody: any = null;
      let rawJson = '';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: any, init: any) => {
        rawJson = init.body;
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 'msg_res_official_001' }), { status: 200 });
      }) as any;

      try {
        const result = await provider.sendMessage(
          {
            mode: GatewayMode.MANAGED_GATEWAY,
            baseUrl: 'https://sms.example.com/api/3rdparty/v1',
            auth: { type: 'BEARER', token: 'valid_token_123' },
            defaultSimSlot: 1,
          },
          {
            organizationId: orgAId,
            to: '+255754123456',
            content: 'Your verification code is 492011',
            idempotencyKey: 'idem_m24_01',
            simSlot: 1,
          },
        );

        assert.equal(result.status, 'DISPATCHED');
        assert.equal(result.providerMessageId, 'msg_res_official_001');

        // Verify JSON string contains textMessage and no undefined properties
        assert.ok(rawJson.includes('"textMessage":{"text":"Your verification code is 492011"}'));
        assert.ok(rawJson.includes('"phoneNumbers":["+255754123456"]'));
        assert.ok(rawJson.includes('"simNumber":1'));
        assert.ok(rawJson.includes('"withDeliveryReport":true'));

        // Mutual exclusivity: Must NOT contain legacy "message" field
        assert.equal('message' in capturedBody, false, 'Payload must NOT contain legacy message field');
        assert.equal(rawJson.includes('"message":'), false, 'Serialized JSON must NOT contain "message":');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should pre-validate and reject empty phone numbers or blank content before network dispatch', async () => {
      const creds = {
        mode: GatewayMode.EXTERNAL_RELAY,
        baseUrl: 'https://api.sms-gate.app/3rdparty/v1',
        auth: { type: 'BEARER', token: 'valid_token' } as const,
      };

      const emptyRecipient = await provider.sendMessage(creds, {
        organizationId: orgAId,
        to: '  ',
        content: 'Hello world',
        idempotencyKey: 'idem_blank_phone',
      });
      assert.equal(emptyRecipient.status, 'FAILED');
      assert.match(String(emptyRecipient.rawResponse.error), /Recipient phone number is required/);

      const emptyContent = await provider.sendMessage(creds, {
        organizationId: orgAId,
        to: '+255754111222',
        content: '',
        idempotencyKey: 'idem_blank_content',
      });
      assert.equal(emptyContent.status, 'FAILED');
      assert.match(String(emptyContent.rawResponse.error), /Message content cannot be empty/);
    });
  });

  describe('4. Official SMSGate Webhook Signing, Timestamp Verification & Replay Protection', () => {
    const signingKey = 'enterprise_gateway_webhook_secret_key_998811';
    const rawPayload = JSON.stringify({
      deviceId: 'hw_gateway_device_01',
      event: 'sms:delivered',
      payload: {
        messageId: 'msg_smsgate_dlr_001',
        recipient: '+255754123456',
        simNumber: 1,
        receivedAt: '2026-11-07T12:00:00Z',
      },
    });

    it('should verify valid official SMSGate signature computed as HMAC-SHA256 of rawBody + timestamp', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signingInput = rawPayload + timestamp;
      const validSig = createHmac('sha256', signingKey).update(signingInput, 'utf8').digest('hex');

      const result = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        validSig,
        timestamp,
        signingKey,
      );
      assert.equal(result.isValid, true);
      assert.equal(result.error, undefined);

      provider.clearReplayCache();
      assert.equal(provider.verifyWebhookSignature(rawPayload, validSig, timestamp, signingKey), true);
    });

    it('should reject invalid signature string', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const invalidSig = 'a'.repeat(64);

      const result = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        invalidSig,
        timestamp,
        signingKey,
      );
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'INVALID_SIGNATURE');
    });

    it('should reject signature computed with wrong secret key', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const wrongKey = 'different_wrong_signing_key_000000000';
      const sigFromWrongKey = createHmac('sha256', wrongKey)
        .update(rawPayload + timestamp, 'utf8')
        .digest('hex');

      const result = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        sigFromWrongKey,
        timestamp,
        signingKey,
      );
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'INVALID_SIGNATURE');
    });

    it('should reject missing or malformed signature header', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      assert.equal(
        provider.verifyWebhookSignatureDetailed(rawPayload, '', timestamp, signingKey).error,
        'MISSING_SIGNATURE',
      );
      assert.equal(
        provider.verifyWebhookSignatureDetailed(rawPayload, 'not_hex', timestamp, signingKey).error,
        'MALFORMED_SIGNATURE',
      );
      assert.equal(
        provider.verifyWebhookSignatureDetailed(rawPayload, '12345', timestamp, signingKey).error,
        'MALFORMED_SIGNATURE',
      );
    });

    it('should reject missing or malformed timestamp header', () => {
      const sig = 'b'.repeat(64);
      assert.equal(
        provider.verifyWebhookSignatureDetailed(rawPayload, sig, '', signingKey).error,
        'MISSING_TIMESTAMP',
      );
      assert.equal(
        provider.verifyWebhookSignatureDetailed(rawPayload, sig, 'not_a_number', signingKey).error,
        'MALFORMED_TIMESTAMP',
      );
      assert.equal(
        provider.verifyWebhookSignatureDetailed(rawPayload, sig, '1712345.678', signingKey).error,
        'MALFORMED_TIMESTAMP',
      );
      assert.equal(
        provider.verifyWebhookSignatureDetailed(rawPayload, sig, '-50', signingKey).error,
        'MALFORMED_TIMESTAMP',
      );
    });

    it('should reject expired timestamp older than tolerance window (300 seconds)', () => {
      const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 301); // 301s ago
      const signingInput = rawPayload + expiredTimestamp;
      const sig = createHmac('sha256', signingKey).update(signingInput, 'utf8').digest('hex');

      const result = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        sig,
        expiredTimestamp,
        signingKey,
        { toleranceSeconds: 300 },
      );
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'EXPIRED_TIMESTAMP');
    });

    it('should reject future timestamp outside permitted clock-skew window (60 seconds)', () => {
      const futureTimestamp = String(Math.floor(Date.now() / 1000) + 70); // 70s in future
      const signingInput = rawPayload + futureTimestamp;
      const sig = createHmac('sha256', signingKey).update(signingInput, 'utf8').digest('hex');

      const result = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        sig,
        futureTimestamp,
        signingKey,
        { clockSkewTolerance: 60 },
      );
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'FUTURE_TIMESTAMP');
    });

    it('should reject modified raw body (tampered payload verification)', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', signingKey)
        .update(rawPayload + timestamp, 'utf8')
        .digest('hex');

      const tamperedBody = rawPayload.replace('hw_gateway_device_01', 'hw_gateway_device_02');
      const result = provider.verifyWebhookSignatureDetailed(
        tamperedBody,
        sig,
        timestamp,
        signingKey,
      );
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'INVALID_SIGNATURE');
    });

    it('should reject if signed raw body is re-serialized changing byte sequence', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      // Original raw body with whitespace
      const formattedRawBody = JSON.stringify(JSON.parse(rawPayload), null, 2);
      const sig = createHmac('sha256', signingKey)
        .update(formattedRawBody + timestamp, 'utf8')
        .digest('hex');

      // Attempting to verify with minified body must fail because signed bytes differ
      const minifiedBody = JSON.stringify(JSON.parse(rawPayload));
      assert.notEqual(formattedRawBody, minifiedBody);

      const result = provider.verifyWebhookSignatureDetailed(
        minifiedBody,
        sig,
        timestamp,
        signingKey,
      );
      assert.equal(result.isValid, false);
      assert.equal(result.error, 'INVALID_SIGNATURE');
    });

    it('should detect and prevent replay attack of an identical signature within validity window', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', signingKey)
        .update(rawPayload + timestamp, 'utf8')
        .digest('hex');

      // First delivery: Accepted
      const firstResult = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        sig,
        timestamp,
        signingKey,
      );
      assert.equal(firstResult.isValid, true);

      // Replay attack with same signature and timestamp: Rejected
      const replayResult = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        sig,
        timestamp,
        signingKey,
      );
      assert.equal(replayResult.isValid, false);
      assert.equal(replayResult.error, 'REPLAY_ATTACK');
    });

    it('should support key rotation allowing verification against previousKey during transition', () => {
      const oldKey = 'previous_webhook_signing_secret_key_1111';
      const newKey = 'new_active_webhook_signing_secret_key_2222';
      const timestamp = String(Math.floor(Date.now() / 1000));

      // Gateway still signs with old key during transition
      const sigWithOldKey = createHmac('sha256', oldKey)
        .update(rawPayload + timestamp, 'utf8')
        .digest('hex');

      // Provider configured with [newKey, oldKey] candidates accepts the transition
      const rotationCandidates = [newKey, oldKey];
      const result = provider.verifyWebhookSignatureDetailed(
        rawPayload,
        sigWithOldKey,
        timestamp,
        rotationCandidates,
      );
      assert.equal(result.isValid, true);
    });
  });

  describe('5. Per-Device Key Management & Tenant Isolation', () => {
    const devAId = 'device_huawei_p40_01';
    const devBId = 'device_samsung_a14_02';
    const devAKey = 'secret_key_for_device_a_org_a_99999';
    const devBKey = 'secret_key_for_device_b_org_b_88888';

    it('should provision, rotate, and resolve device-scoped signing keys', async () => {
      await smsGateKeyService.setDeviceSigningKey(orgAId, devAId, devAKey);
      const resolved = await smsGateKeyService.resolveCandidateKeys(orgAId, devAId);
      assert.deepEqual(resolved, [devAKey]);

      // Rotate device key
      const newDevAKey = 'new_rotated_key_device_a_77777777777';
      await smsGateKeyService.rotateDeviceSigningKey(orgAId, devAId, newDevAKey);
      const afterRotation = await smsGateKeyService.resolveCandidateKeys(orgAId, devAId);
      assert.deepEqual(afterRotation, [newDevAKey, devAKey]);
    });

    it('should strictly isolate device keys across tenants (Org A cannot access Org B keys)', async () => {
      await smsGateKeyService.setDeviceSigningKey(orgAId, devAId, devAKey);
      await smsGateKeyService.setDeviceSigningKey(orgBId, devBId, devBKey);

      // Org B querying Dev A's ID gets empty candidates
      assert.deepEqual(await smsGateKeyService.resolveCandidateKeys(orgBId, devAId), []);

      // Org A querying Dev B's ID gets empty candidates
      assert.deepEqual(await smsGateKeyService.resolveCandidateKeys(orgAId, devBId), []);

      // Cross-organization signature verification fails
      const raw = JSON.stringify({ deviceId: devAId, event: 'sms:delivered' });
      const ts = String(Math.floor(Date.now() / 1000));
      const sigFromDevA = createHmac('sha256', devAKey).update(raw + ts, 'utf8').digest('hex');

      // Org B attempting to verify signature from Org A's device key fails
      const orgBCandidates = await smsGateKeyService.resolveCandidateKeys(orgBId, devAId);
      const verifyResult = provider.verifyWebhookSignatureDetailed(raw, sigFromDevA, ts, orgBCandidates);
      assert.equal(verifyResult.isValid, false);
      assert.equal(verifyResult.error, 'MISSING_SIGNING_KEY');
    });

    it('should fallback to organization gateway key when device-specific key is not set', async () => {
      const orgGatewayKey = 'org_vps_gateway_master_secret_55555';
      await smsGateKeyService.setGatewaySigningKey(orgAId, orgGatewayKey);

      // Device without dedicated key falls back to organization gateway key
      const candidates = await smsGateKeyService.resolveCandidateKeys(orgAId, 'unregistered_device_99');
      assert.deepEqual(candidates, [orgGatewayKey]);
    });
  });
});
