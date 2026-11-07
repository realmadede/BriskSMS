import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { GatewayMode } from '@brisksms/shared';
import { SmsGateProvider } from '../src/modules/messaging/providers/smsgate.provider.js';

describe('Milestone 2.3: Official SMSGate API Contract, Schema & Webhook Verification', () => {
  const provider = new SmsGateProvider();
  const orgId = randomUUID();

  describe('1. Endpoint Path Resolution & URL Normalization', () => {
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

    it('should resolve custom reverse-proxy /api/v1 paths cleanly', () => {
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
  });

  describe('2. Authorization Header Building (Basic & Bearer)', () => {
    it('should format Bearer header for JWT / API tokens', () => {
      assert.equal(provider.buildAuthHeader('bsk_cloud_tok_8899'), 'Bearer bsk_cloud_tok_8899');
      assert.equal(
        provider.buildAuthHeader('Bearer preformatted_jwt_bearer'),
        'Bearer preformatted_jwt_bearer',
      );
    });

    it('should format HTTP Basic header for colon-delimited credentials', () => {
      const basic = provider.buildAuthHeader('admin:smsgate_secret_pass');
      assert.equal(basic, 'Basic YWRtaW46c21zZ2F0ZV9zZWNyZXRfcGFzcw==');
      assert.equal(
        provider.buildAuthHeader('Basic YWRtaW46c21zZ2F0ZV9zZWNyZXRfcGFzcw=='),
        'Basic YWRtaW46c21zZ2F0ZV9zZWNyZXRfcGFzcw==',
      );
    });
  });

  describe('3. Strict Schema Serialization (textMessage vs legacy message)', () => {
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
            baseUrl: 'https://gateway.brisksms.com/api/3rdparty/v1',
            apiToken: 'test_token',
            defaultSimSlot: 1,
          },
          {
            organizationId: orgId,
            to: '+255754123456',
            content: 'Your verification code is 492011',
            idempotencyKey: 'idem_m23_01',
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
        apiToken: 'test_token',
      };

      const emptyRecipient = await provider.sendMessage(creds, {
        organizationId: orgId,
        to: '  ',
        content: 'Hello world',
        idempotencyKey: 'idem_blank_phone',
      });
      assert.equal(emptyRecipient.status, 'FAILED');
      assert.match(String(emptyRecipient.rawResponse.error), /Recipient phone number is required/);

      const emptyContent = await provider.sendMessage(creds, {
        organizationId: orgId,
        to: '+255754111222',
        content: '',
        idempotencyKey: 'idem_blank_content',
      });
      assert.equal(emptyContent.status, 'FAILED');
      assert.match(String(emptyContent.rawResponse.error), /Message content cannot be empty/);
    });
  });

  describe('4. Official Webhook Schema & HMAC Signature Verification', () => {
    it('should unwrap official nested webhook payload structure', () => {
      const nestedWebhook = {
        deviceId: 'device_01',
        event: 'sms:delivered',
        payload: {
          messageId: 'msg_dlr_9988',
          recipient: '+255754123456',
          simNumber: 1,
          receivedAt: '2026-11-06T18:30:00.000Z',
        },
      };

      const normalized = provider.normalizeWebhookPayload(nestedWebhook);
      assert.equal(normalized.providerMessageId, 'msg_dlr_9988');
      assert.equal(normalized.eventType, 'DELIVERED');
      assert.equal(normalized.carrierTimestamp.toISOString(), '2026-11-06T18:30:00.000Z');
    });

    it('should unwrap sms:failed webhook with error reason', () => {
      const failedWebhook = {
        deviceId: 'device_01',
        event: 'sms:failed',
        payload: {
          messageId: 'msg_fail_7766',
          error: 'Radio network timeout during PDU dispatch',
          receivedAt: '2026-11-06T18:35:00.000Z',
        },
      };

      const normalized = provider.normalizeWebhookPayload(failedWebhook);
      assert.equal(normalized.providerMessageId, 'msg_fail_7766');
      assert.equal(normalized.eventType, 'FAILED');
      assert.equal(normalized.failureReason, 'Radio network timeout during PDU dispatch');
    });

    it('should cryptographically verify webhook HMAC-SHA256 signatures', () => {
      const secret = 'whsec_enterprise_signing_secret_9999';
      const rawPayload = JSON.stringify({
        deviceId: 'device_01',
        event: 'sms:delivered',
        payload: { messageId: 'msg_sec_01' },
      });

      const validSig = createHmac('sha256', secret).update(rawPayload, 'utf8').digest('hex');

      // Valid signature must return true
      assert.equal(provider.verifyWebhookSignature(rawPayload, validSig, secret), true);

      // Tampered payload must return false
      assert.equal(
        provider.verifyWebhookSignature(rawPayload + 'tampered', validSig, secret),
        false,
      );

      // Invalid signature must return false
      assert.equal(
        provider.verifyWebhookSignature(rawPayload, 'invalid_sig_hex_123', secret),
        false,
      );

      // Missing signature or secret must return false
      assert.equal(provider.verifyWebhookSignature(rawPayload, '', secret), false);
      assert.equal(provider.verifyWebhookSignature(rawPayload, validSig, ''), false);
    });
  });
});
