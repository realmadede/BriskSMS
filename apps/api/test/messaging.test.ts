import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import {
  GatewayMode,
  SmsStatus,
  FeatureKey,
  InsufficientCreditsError,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { messagingService } from '../src/modules/messaging/messaging.service.js';
import { recipientParserService } from '../src/modules/messaging/recipient-parser.service.js';
import { SmsGateProvider } from '../src/modules/messaging/providers/smsgate.provider.js';

describe('Product B: BriskSMS Cellular Gateway & Messaging Engine', () => {
  const orgId = randomUUID();

  beforeEach(() => {
    dbStore.reset();

    // Enable bulk messaging entitlement for test organization
    const feat = dbStore.featureDefinitions.get(FeatureKey.BULK_MESSAGING_ENABLED);
    if (feat) feat.defaultValue = 'true';
  });

  describe('1. Phone Number Sanitization & Recipient Parser', () => {
    it('should correctly normalize Tanzanian carrier phone numbers to E.164 format', () => {
      // Vodacom (074, 075, 076)
      assert.equal(recipientParserService.normalizePhoneNumber('0754123456'), '+255754123456');
      assert.equal(recipientParserService.normalizePhoneNumber('255742998877'), '+255742998877');
      assert.equal(recipientParserService.normalizePhoneNumber('+255 765 112 233'), '+255765112233');

      // Mixx by Yas / Tigo (071, 065, 067)
      assert.equal(recipientParserService.normalizePhoneNumber('0712345678'), '+255712345678');
      assert.equal(recipientParserService.normalizePhoneNumber('0655123456'), '+255655123456');

      // Airtel (078, 068, 069)
      assert.equal(recipientParserService.normalizePhoneNumber('0784990011'), '+255784990011');
      assert.equal(recipientParserService.normalizePhoneNumber('0682112233'), '+255682112233');

      // Halotel (062)
      assert.equal(recipientParserService.normalizePhoneNumber('0624556677'), '+255624556677');
    });

    it('should reject invalid or non-Tanzanian numbers', () => {
      assert.equal(recipientParserService.normalizePhoneNumber('0700123456'), null); // Invalid carrier
      assert.equal(recipientParserService.normalizePhoneNumber('12345'), null);
      assert.equal(recipientParserService.normalizePhoneNumber('+18005550199'), null); // US number
    });

    it('should deduplicate recipients and extract template variables', () => {
      const rawRows = [
        { phone: '0754111222', name: 'Baraka', amount: '50,000' },
        { phone: '0754111222', name: 'Baraka Duplicate', amount: '50,000' }, // Duplicate
        { phone: '0712333444', name: 'Neema', amount: '120,000' },
        { phone: 'invalid-num', name: 'Bad Row', amount: '0' }, // Invalid
      ];

      const result = recipientParserService.processRecipientBatch(rawRows);
      assert.equal(result.totalParsed, 4);
      assert.equal(result.validRecipients.length, 2);
      assert.equal(result.duplicateCount, 1);
      assert.equal(result.invalidCount, 1);

      // Verify variables
      assert.equal(result.validRecipients[0]!.variables.name, 'Baraka');
      assert.equal(result.validRecipients[0]!.variables.amount, '50,000');
    });

    it('should interpolate dynamic template variables accurately', () => {
      const template = 'Habari {{name}}, ankara yako ya TZS {{amount}} imethibitishwa.';
      const variables = { name: 'Juma', amount: '150,000' };
      const merged = recipientParserService.interpolateTemplate(template, variables);
      assert.equal(merged, 'Habari Juma, ankara yako ya TZS 150,000 imethibitishwa.');
    });
  });

  describe('2. Dual-Mode Gateway Configuration (Mode A Cloud & Mode B Private VPS)', () => {
    it('should configure Mode B (Managed BriskSMS Gateway) with default SIM 1', () => {
      const config = messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        gatewayBaseUrl: 'https://gateway.brisksms.com/api/v1',
        apiToken: 'bsk_priv_token_9999',
        defaultSimSlot: 1,
      });

      assert.equal(config.gatewayMode, GatewayMode.MANAGED_GATEWAY);
      assert.equal(config.gatewayBaseUrl, 'https://gateway.brisksms.com/api/v1');
      assert.equal(config.defaultSimSlot, 1);
    });

    it('should configure Mode A (External Relay) with multi-SIM slot 2', () => {
      const config = messagingService.updateGatewayConfig(orgId, {
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
    it('should record credit purchase and accurately track ledger balance', () => {
      assert.equal(messagingService.getCreditBalance(orgId), 0);

      const newBalance = messagingService.purchaseCredits(orgId, 500, 'PAY-INV-1001');
      assert.equal(newBalance, 500);
      assert.equal(messagingService.getCreditBalance(orgId), 500);

      const ledgers = dbStore.messagingLedgers.filter((l) => l.organizationId === orgId);
      assert.equal(ledgers.length, 1);
      assert.equal(ledgers[0]!.amountCredits, 500);
      assert.equal(ledgers[0]!.balanceAfter, 500);
      assert.equal(ledgers[0]!.referenceId, 'PAY-INV-1001');
    });

    it('should reject dispatch when credit balance is insufficient', async () => {
      messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        apiToken: 'test_token',
      });

      assert.throws(
        () => {
          messagingService.deductCredits(orgId, 1);
        },
        InsufficientCreditsError,
      );
    });

    it('should atomically deduct credits on dispatch and refund upon failure', async () => {
      // 1. Purchase 10 credits
      messagingService.purchaseCredits(orgId, 10);
      assert.equal(messagingService.getCreditBalance(orgId), 10);

      // 2. Mock provider failure
      const mockFailingProvider = {
        sendMessage: async () => ({
          providerMessageId: 'fail_msg_1',
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

      const failingService = new (class extends Object {
        srv = messagingService;
      })().srv;
      (failingService as any).provider = mockFailingProvider;

      messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        apiToken: 'test_token',
      });

      // 3. Dispatch message
      const msg = await failingService.sendSingleMessage(orgId, {
        to: '0754123456',
        content: 'Test message',
      });

      assert.equal(msg.status, SmsStatus.FAILED);
      // Balance must remain 10 because the 1 credit was auto-refunded!
      assert.equal(messagingService.getCreditBalance(orgId), 10);

      const ledgers = dbStore.messagingLedgers.filter((l) => l.organizationId === orgId);
      assert.equal(ledgers.length, 3); // 1. Purchase, 2. Usage deduction, 3. Refund
      assert.equal(ledgers[2]!.balanceAfter, 10);
    });
  });

  describe('4. TCRA Anti-Spam Curfew Compliance', () => {
    it('should enforce promotional curfew between 20:00 and 07:00 EAT', () => {
      // EAT is UTC+3
      // 18:00 UTC = 21:00 EAT (in curfew)
      const lateNightUtc = new Date('2026-11-06T18:00:00Z');
      assert.equal(messagingService.isCurfewRestricted(lateNightUtc), true);

      // 03:00 UTC = 06:00 EAT (in curfew)
      const earlyMorningUtc = new Date('2026-11-06T03:00:00Z');
      assert.equal(messagingService.isCurfewRestricted(earlyMorningUtc), true);

      // 09:00 UTC = 12:00 EAT (outside curfew - allowed)
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
      // Setup successful message
      const msgId = randomUUID();
      const provId = 'prov_msg_4455';
      messagingService.purchaseCredits(orgId, 5);

      dbStore.smsMessages.set(msgId, {
        id: msgId,
        organizationId: orgId,
        campaignId: null,
        recipientPhone: '+255754123456',
        messageText: 'Delivery test',
        status: SmsStatus.SUBMITTED,
        costCredits: 1,
        simSlot: 1,
        providerMessageId: provId,
        gatewayProvider: GatewayMode.MANAGED_GATEWAY,
        deliveredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = messagingService.handleDeliveryEvent({
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
