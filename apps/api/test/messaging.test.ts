import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import {
  GatewayMode,
  SmsStatus,
  FeatureKey,
  InsufficientCreditsError,
} from '@brisksms/shared';
import { sql } from '@brisksms/db';
import { dbStore } from '../src/core/store.js';
import { messagingService, MessagingService } from '../src/modules/messaging/messaging.service.js';
import { recipientParserService } from '../src/modules/messaging/recipient-parser.service.js';
import { SmsGateProvider } from '../src/modules/messaging/providers/smsgate.provider.js';

describe('Product B: BriskSMS Cellular Gateway & Messaging Engine', () => {
  const orgId = randomUUID();

  describe('1. Phone Number Sanitization & Recipient Parser (Unit)', () => {
    it('should correctly normalize Tanzanian carrier phone numbers to E.164 format', () => {
      assert.equal(recipientParserService.normalizePhoneNumber('0754123456'), '+255754123456');
      assert.equal(recipientParserService.normalizePhoneNumber('255742998877'), '+255742998877');
      assert.equal(recipientParserService.normalizePhoneNumber('+255 765 112 233'), '+255765112233');

      assert.equal(recipientParserService.normalizePhoneNumber('0712345678'), '+255712345678');
      assert.equal(recipientParserService.normalizePhoneNumber('0655123456'), '+255655123456');

      assert.equal(recipientParserService.normalizePhoneNumber('0784990011'), '+255784990011');
      assert.equal(recipientParserService.normalizePhoneNumber('0682112233'), '+255682112233');

      assert.equal(recipientParserService.normalizePhoneNumber('0624556677'), '+255624556677');
    });

    it('should reject invalid or non-Tanzanian numbers', () => {
      assert.equal(recipientParserService.normalizePhoneNumber('0700123456'), null);
      assert.equal(recipientParserService.normalizePhoneNumber('12345'), null);
      assert.equal(recipientParserService.normalizePhoneNumber('+18005550199'), null);
    });

    it('should deduplicate recipients and extract template variables', () => {
      const rawRows = [
        { phone: '0754111222', name: 'Baraka', amount: '50,000' },
        { phone: '0754111222', name: 'Baraka Duplicate', amount: '50,000' },
        { phone: '0712333444', name: 'Neema', amount: '120,000' },
        { phone: 'invalid-num', name: 'Bad Row', amount: '0' },
      ];

      const result = recipientParserService.processRecipientBatch(rawRows);
      assert.equal(result.totalParsed, 4);
      assert.equal(result.validRecipients.length, 2);
      assert.equal(result.duplicateCount, 1);
      assert.equal(result.invalidCount, 1);

      assert.equal(result.validRecipients[0]!.variables.name, 'Baraka');
      assert.equal(result.validRecipients[0]!.variables.amount, '50,000');
    });

    it('should interpolate dynamic template variables accurately', () => {
      const template = 'Habari {{name}}, ankara yako ya TZS {{amount}} imethibitishwa.';
      const variables = { name: 'Juma', amount: '150,000' };
      const merged = recipientParserService.interpolateTemplate(template, variables);
      assert.equal(merged, 'Habari Juma, ankara yako ya TZS 150,000 imethibitishwa.');
    });

    it('should interpolate user-friendly human tags like [Jina la Mteja], [Kiasi], [Namba ya Ankara]', () => {
      const templateSwahili = 'Habari [Jina la Mteja], tumepokea malipo yako ya TZS [Kiasi] kwa ankara [Namba ya Ankara].';
      const variables = { name: 'Amani Mwamba', amount: '45,000', invoice: 'INV-2026-001' };
      const mergedSwahili = recipientParserService.interpolateTemplate(templateSwahili, variables);
      assert.equal(mergedSwahili, 'Habari Amani Mwamba, tumepokea malipo yako ya TZS 45,000 kwa ankara INV-2026-001.');

      const templateEnglish = 'Dear [Customer Name], received TZS [Amount] for invoice [Invoice Number].';
      const mergedEnglish = recipientParserService.interpolateTemplate(templateEnglish, variables);
      assert.equal(mergedEnglish, 'Dear Amani Mwamba, received TZS [Amount] for invoice INV-2026-001.'.replace('[Amount]', '45,000'));
    });
  });

  describe('2. Official SMSGate Contract, Schema & Endpoint Resolution (Unit)', () => {
    const provider = new SmsGateProvider();

    it('should resolve and normalize endpoint URLs safely', () => {
      assert.equal(
        provider.resolveEndpoint('https://gateway.brisksms.com/api/v1'),
        'https://gateway.brisksms.com/api/v1/messages',
      );
      assert.equal(
        provider.resolveEndpoint('https://api.sms-gate.app/3rdparty/v1/'),
        'https://api.sms-gate.app/3rdparty/v1/messages',
      );
      assert.equal(
        provider.resolveEndpoint('https://gateway.brisksms.com/api/3rdparty/v1/messages'),
        'https://gateway.brisksms.com/api/3rdparty/v1/messages',
      );
      assert.throws(() => provider.resolveEndpoint('javascript:alert(1)'), /Invalid gateway URL scheme/);
      assert.throws(() => provider.resolveEndpoint('ftp://insecure.gateway/'), /Invalid gateway URL scheme/);
    });

    it('should format Authorization header for Bearer tokens and Basic auth', () => {
      assert.equal(provider.buildAuthHeader('bsk_token_123'), 'Bearer bsk_token_123');
      assert.equal(provider.buildAuthHeader('Bearer custom_jwt_token'), 'Bearer custom_jwt_token');
      assert.equal(provider.buildAuthHeader('admin:secret123'), 'Basic YWRtaW46c2VjcmV0MTIz');
      assert.equal(provider.buildAuthHeader('Basic YWRtaW46c2VjcmV0MTIz'), 'Basic YWRtaW46c2VjcmV0MTIz');
    });

    it('should serialize HTTP request body with textMessage.text and ZERO legacy message field', async () => {
      let interceptedUrl = '';
      let interceptedHeaders: Record<string, string> = {};
      let interceptedBody: any = null;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: any, init: any) => {
        interceptedUrl = String(url);
        interceptedHeaders = init.headers;
        interceptedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 'msg_smsgate_verified_01' }), { status: 200 });
      }) as any;

      try {
        const result = await provider.sendMessage(
          {
            mode: GatewayMode.MANAGED_GATEWAY,
            baseUrl: 'https://gateway.brisksms.com/api/v1',
            apiToken: 'smsgate_secret_key',
            defaultSimSlot: 2,
          },
          {
            organizationId: orgId,
            to: '+255754123456',
            content: 'Invoice INV-2026-99 has been generated.',
            idempotencyKey: 'idem_test_998811',
            simSlot: 2,
          },
        );

        assert.equal(result.status, 'DISPATCHED');
        assert.equal(result.providerMessageId, 'msg_smsgate_verified_01');
        assert.equal(interceptedUrl, 'https://gateway.brisksms.com/api/v1/messages');
        assert.equal(interceptedHeaders['Authorization'], 'Bearer smsgate_secret_key');
        assert.equal(interceptedHeaders['X-Idempotency-Key'], 'idem_test_998811');

        // CRITICAL SCHEMA INVARIANT: Must contain textMessage.text
        assert.ok(interceptedBody.textMessage, 'Must contain textMessage object');
        assert.equal(interceptedBody.textMessage.text, 'Invoice INV-2026-99 has been generated.');

        // CRITICAL SCHEMA INVARIANT: Must NOT contain conflicting deprecated 'message' field
        assert.equal('message' in interceptedBody, false, 'Must NOT contain deprecated message field');

        // Recipient, SIM slot, and delivery report flag
        assert.deepEqual(interceptedBody.phoneNumbers, ['+255754123456']);
        assert.equal(interceptedBody.simNumber, 2);
        assert.equal(interceptedBody.withDeliveryReport, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should pre-validate and reject empty recipients and empty message content', async () => {
      const creds = {
        mode: GatewayMode.EXTERNAL_RELAY,
        baseUrl: 'https://api.sms-gate.app/3rdparty/v1',
        apiToken: 'test_token',
      };

      const emptyToResult = await provider.sendMessage(creds, {
        organizationId: orgId,
        to: '',
        content: 'Test content',
        idempotencyKey: 'idem_1',
      });
      assert.equal(emptyToResult.status, 'FAILED');
      assert.match(String(emptyToResult.rawResponse.error), /Recipient phone number is required/);

      const emptyContentResult = await provider.sendMessage(creds, {
        organizationId: orgId,
        to: '+255754111222',
        content: '    ',
        idempotencyKey: 'idem_2',
      });
      assert.equal(emptyContentResult.status, 'FAILED');
      assert.match(String(emptyContentResult.rawResponse.error), /Message content cannot be empty/);
    });

    it('should normalize official nested SMSGate webhook payload structure', () => {
      const nestedWebhook = {
        deviceId: 'device_huawei_001',
        event: 'sms:delivered',
        payload: {
          messageId: 'msg_nest_9911',
          recipient: '+255754000111',
          simNumber: 1,
          receivedAt: '2026-11-06T15:00:00Z',
        },
      };

      const normalized = provider.normalizeWebhookPayload(nestedWebhook);
      assert.equal(normalized.providerMessageId, 'msg_nest_9911');
      assert.equal(normalized.eventType, 'DELIVERED');
      assert.equal(normalized.carrierTimestamp.toISOString(), '2026-11-06T15:00:00.000Z');
    });
  });

  describe('3. Database-backed Gateway, Ledger, Dispatch & Terminal States', () => {
    beforeEach(async () => {
      await dbStore.reset();

      await dbStore.seedOrganizationDirect({
        id: orgId,
        name: 'Messaging Test Org',
        slug: `msg-org-${orgId.slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'ENTERPRISE',
        isActive: true,
      });

      // Enable bulk messaging entitlement default for test organization
      await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.BULK_MESSAGING_ENABLED, 'true');
    });

    describe('Dual-Mode Gateway Configuration (Mode A Cloud & Mode B Private VPS)', () => {
    it('should configure Mode B (Managed BriskSMS Gateway) with default SIM 1', async () => {
      const config = await messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        gatewayBaseUrl: 'https://gateway.brisksms.com/api/v1',
        apiToken: 'bsk_priv_token_9999',
        defaultSimSlot: 1,
      });

      assert.equal(config.gatewayMode, GatewayMode.MANAGED_GATEWAY);
      assert.equal(config.gatewayBaseUrl, 'https://gateway.brisksms.com/api/v1');
      assert.equal(config.defaultSimSlot, 1);
    });

    it('should configure Mode A (External Relay) with multi-SIM slot 2', async () => {
      const config = await messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.EXTERNAL_RELAY,
        gatewayBaseUrl: 'https://api.sms-gate.app/3rdparty/v1',
        apiToken: 'ext_token_1234',
        defaultSimSlot: 2,
      });

      assert.equal(config.gatewayMode, GatewayMode.EXTERNAL_RELAY);
      assert.equal(config.gatewayBaseUrl, 'https://api.sms-gate.app/3rdparty/v1');
      assert.equal(config.defaultSimSlot, 2);
    });
  });

  describe('3. Double-Entry Prepaid Credit Ledger & Accounting', () => {
    it('should record credit purchase and accurately track ledger balance', async () => {
      assert.equal(await messagingService.getCreditBalance(orgId), 0);

      const newBalance = await messagingService.purchaseCredits(orgId, 500, 'PAY-INV-1001');
      assert.equal(newBalance, 500);
      assert.equal(await messagingService.getCreditBalance(orgId), 500);

      const ledgers = await messagingService.listLedgerEntries(orgId);
      assert.equal(ledgers.length, 1);
      assert.equal(ledgers[0]!.amountCredits, 500);
      assert.equal(ledgers[0]!.balanceAfter, 500);
      assert.equal(ledgers[0]!.referenceId, 'PAY-INV-1001');
    });

    it('should reject dispatch when credit balance is insufficient', async () => {
      await messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        apiToken: 'test_token',
      });

      await assert.rejects(
        () => messagingService.deductCredits(orgId, 1),
        InsufficientCreditsError,
      );
    });

    it('should atomically deduct credits on dispatch and refund upon failure', async () => {
      await messagingService.purchaseCredits(orgId, 10);
      assert.equal(await messagingService.getCreditBalance(orgId), 10);

      const mockFailingProvider = {
        sendMessage: async () => ({
          providerMessageId: `fail_msg_${randomUUID()}`,
          status: 'FAILED' as const,
          rawResponse: { error: 'SIM radio unavailable' },
        }),
        verifyWebhookSignature: () => true,
        normalizeWebhookPayload: () => ({
          providerMessageId: 'fail_msg_1',
          eventType: 'FAILED' as const,
          carrierTimestamp: new Date(),
        }),
      };

      const failingService = new MessagingService(mockFailingProvider);

      await messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        apiToken: 'test_token',
      });

      const msg = await failingService.sendSingleMessage(orgId, {
        to: '0754123456',
        content: 'Test message',
      });

      assert.equal(msg.status, SmsStatus.FAILED);
      assert.equal(await messagingService.getCreditBalance(orgId), 10);

      const ledgers = await messagingService.listLedgerEntries(orgId);
      assert.equal(ledgers.length, 3); // 1. Purchase, 2. Usage deduction, 3. Refund
      assert.equal(ledgers[2]!.balanceAfter, 10);
    });
  });

  describe('4. TCRA Anti-Spam Curfew Compliance', () => {
    it('should enforce promotional curfew between 20:00 and 07:00 EAT', () => {
      const lateNightUtc = new Date('2026-11-06T18:00:00Z');
      assert.equal(messagingService.isCurfewRestricted(lateNightUtc), true);

      const earlyMorningUtc = new Date('2026-11-06T03:00:00Z');
      assert.equal(messagingService.isCurfewRestricted(earlyMorningUtc), true);

      const afternoonUtc = new Date('2026-11-06T09:00:00Z');
      assert.equal(messagingService.isCurfewRestricted(afternoonUtc), false);
    });
  });

  describe('5. Provider Signature Verification & Webhook Handling', () => {
    const provider = new SmsGateProvider();

    it('should verify valid HMAC-SHA256 webhook signatures and reject invalid ones', () => {
      const rawBody = JSON.stringify({ id: 'msg_9988', status: 'Delivered' });
      const secret = 'super_secret_signing_key_1234';

      const validSig = createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('hex');

      assert.equal(provider.verifyWebhookSignature(rawBody, validSig, secret), true);
      assert.equal(provider.verifyWebhookSignature(rawBody, 'invalid_sig', secret), false);
      assert.equal(provider.verifyWebhookSignature(rawBody, validSig, 'wrong_secret'), false);
    });

    it('should process delivery webhook and update message status', async () => {
      const msgId = randomUUID();
      const provId = `prov_msg_${randomUUID().slice(0, 8)}`;
      await messagingService.purchaseCredits(orgId, 5);

      const now = new Date();
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, campaign_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          delivered_at, created_at, updated_at
        ) VALUES (
          ${msgId}, ${orgId}, NULL, '+255754123456', 'Delivery test',
          ${SmsStatus.SUBMITTED}, 1, 1, ${provId}, ${GatewayMode.MANAGED_GATEWAY},
          NULL, ${now}, ${now}
        )
      `;

      const updated = await messagingService.handleDeliveryEvent({
        providerMessageId: provId,
        eventType: 'DELIVERED',
        carrierTimestamp: new Date(),
      });

      assert.ok(updated);
      assert.equal(updated.status, SmsStatus.DELIVERED);
      assert.ok(updated.deliveredAt);
    });
  });

  describe('Terminal States, Out-of-Order Webhooks & Deduplication (DB)', () => {
    it('should return null when webhook references an unknown providerMessageId', async () => {
      const result = await messagingService.handleDeliveryEvent({
        providerMessageId: 'non_existent_prov_id_404',
        eventType: 'DELIVERED',
        carrierTimestamp: new Date(),
      });
      assert.equal(result, null);
    });

    it('should prevent out-of-order FAILED event from reverting a DELIVERED message or double-refunding', async () => {
      const msgId = randomUUID();
      const provId = `prov_term_${randomUUID().slice(0, 8)}`;
      await messagingService.purchaseCredits(orgId, 10);
      const initialBalance = await messagingService.getCreditBalance(orgId);

      const now = new Date();
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, campaign_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          delivered_at, created_at, updated_at
        ) VALUES (
          ${msgId}, ${orgId}, NULL, '+255754123456', 'Terminal state test',
          ${SmsStatus.DELIVERED}, 1, 1, ${provId}, ${GatewayMode.MANAGED_GATEWAY},
          ${now}, ${now}, ${now}
        )
      `;

      // Out-of-order FAILED event arrives AFTER message was already DELIVERED
      const result = await messagingService.handleDeliveryEvent({
        providerMessageId: provId,
        eventType: 'FAILED',
        failureReason: 'Late radio timeout',
        carrierTimestamp: new Date(),
      });

      assert.ok(result);
      // Status MUST remain DELIVERED
      assert.equal(result.status, SmsStatus.DELIVERED);

      // Ledger balance MUST NOT be refunded
      const balanceAfter = await messagingService.getCreditBalance(orgId);
      assert.equal(balanceAfter, initialBalance, 'Credits must NOT be refunded on delivered messages');
    });

    it('should update QUEUED status to SUBMITTED upon SENT event without marking DELIVERED', async () => {
      const msgId = randomUUID();
      const provId = `prov_sent_${randomUUID().slice(0, 8)}`;
      const now = new Date();
      await sql`
        INSERT INTO sms_messages (
          id, organization_id, campaign_id, recipient_phone, message_text,
          status, cost_credits, sim_slot, provider_message_id, gateway_provider,
          delivered_at, created_at, updated_at
        ) VALUES (
          ${msgId}, ${orgId}, NULL, '+255754123456', 'Sent event test',
          ${SmsStatus.QUEUED}, 1, 1, ${provId}, ${GatewayMode.MANAGED_GATEWAY},
          NULL, ${now}, ${now}
        )
      `;

      const result = await messagingService.handleDeliveryEvent({
        providerMessageId: provId,
        eventType: 'SENT',
        carrierTimestamp: new Date(),
      });

      assert.ok(result);
      assert.equal(result.status, SmsStatus.SUBMITTED);
      assert.equal(result.deliveredAt, null, 'SENT event must NOT mark message as delivered');
    });
  });
  }); // end of describe('3. Database-backed Gateway, Ledger, Dispatch & Terminal States')
}); // end of describe('Product B: BriskSMS Cellular Gateway & Messaging Engine')
