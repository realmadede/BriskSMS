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

  describe('1. Phone Number Sanitization & Recipient Parser', () => {
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

  describe('2. Dual-Mode Gateway Configuration (Mode A Cloud & Mode B Private VPS)', () => {
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
});
