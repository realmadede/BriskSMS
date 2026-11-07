import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ApiKeyScope,
  BusinessEventType,
  FeatureKey,
  GatewayMode,
  NormalizedDeliveryEvent,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { WebhookService } from '../src/modules/developer/webhook.service.js';
import { DeveloperActionService } from '../src/modules/developer/developer-action.service.js';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';
import { MessagingProvider } from '../src/modules/messaging/interfaces/messaging-provider.interface.js';

describe('Developer Platform & Zapier Webhook Automation', () => {
  let apiKeyService: ApiKeyService;
  let webhookService: WebhookService;
  let messagingService: MessagingService;
  let developerActionService: DeveloperActionService;
  const orgId = randomUUID();

  const mockProvider: MessagingProvider = {
    async sendMessage(_creds, payload) {
      return {
        providerMessageId: `mock_gw_${payload.idempotencyKey}`,
        status: 'DISPATCHED',
        rawResponse: { status: 'sent' },
      };
    },
    verifyWebhookSignature() {
      return true;
    },
    normalizeWebhookPayload(rawPayload): NormalizedDeliveryEvent {
      return {
        providerMessageId: String(rawPayload.id),
        eventType: 'DELIVERED',
        carrierTimestamp: new Date(),
      };
    },
  };

  beforeEach(async () => {
    await dbStore.reset();
    apiKeyService = new ApiKeyService();
    webhookService = new WebhookService();
    messagingService = new MessagingService(mockProvider);
    developerActionService = new DeveloperActionService(apiKeyService, messagingService);

    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Kilimanjaro Logistics',
      slug: `kili-logistics-${orgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'BUSINESS',
      isActive: true,
    });

    await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.BULK_MESSAGING_ENABLED, 'true');

    await messagingService.purchaseCredits(orgId, 100, 'SEED_CREDITS');
    await messagingService.updateGatewayConfig(orgId, {
      gatewayMode: GatewayMode.MANAGED_GATEWAY,
      apiToken: 'enc_token_sec_9918231',
    });
  });

  describe('Scoped API Keys (ApiKeyService)', () => {
    it('creates API key starting with bsk_live_ and validates scopes', async () => {
      const result = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Zapier Inbound Webhook Trigger',
        scopes: [ApiKeyScope.SMS_SEND, ApiKeyScope.PAYMENTS_READ],
      });

      assert.equal(result.plainTextSecret.startsWith('bsk_live_'), true);
      assert.equal(result.apiKey.keyPrefix.startsWith('bsk_live_'), true);
      assert.equal(result.apiKey.name, 'Zapier Inbound Webhook Trigger');

      const validRecord = await apiKeyService.validateApiKey(result.plainTextSecret, ApiKeyScope.SMS_SEND);
      assert.notEqual(validRecord, null);
      assert.equal(validRecord?.organizationId, orgId);
      assert.notEqual(validRecord?.lastUsedAt, null);

      const invalidScope = await apiKeyService.validateApiKey(result.plainTextSecret, ApiKeyScope.INVOICES_WRITE);
      assert.equal(invalidScope, null);
    });

    it('rejects revoked API keys immediately', async () => {
      const result = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Temporary Script',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const revoked = await apiKeyService.revokeApiKey(orgId, result.apiKey.id);
      assert.equal(revoked, true);

      const validated = await apiKeyService.validateApiKey(result.plainTextSecret);
      assert.equal(validated, null);
    });
  });

  describe('Webhook Outbox Dispatcher & HMAC Signatures (WebhookService)', () => {
    it('generates verifiable HMAC-SHA256 signature for Catch Hook consumers', () => {
      const secret = 'whsec_test_secret_key_12345';
      const timestamp = 1793912000;
      const payload = JSON.stringify({ event: 'payment.matched', amount: 150000 });

      const signature = webhookService.computeSignature(payload, secret, timestamp);
      assert.equal(signature.startsWith(`t=${timestamp},v1=`), true);
    });

    it('registers endpoint and delivers outbox events with HMAC signature', async () => {
      const endpoint = await webhookService.registerEndpoint(orgId, {
        url: 'https://hooks.zapier.com/hooks/catch/123456/abcdef/',
        subscribedEvents: [BusinessEventType.PAYMENT_MATCHED],
        secret: 'whsec_zapier_secret_key',
      });

      assert.equal(endpoint.isActive, true);

      const eventId = randomUUID();
      await dbStore.insertOutboxEvent({
        id: eventId,
        organizationId: orgId,
        eventType: BusinessEventType.PAYMENT_MATCHED,
        payload: { reference: 'QA8921KL90', amountCents: '15000000' },
        maxAttempts: 5,
      });

      let dispatchedUrl = '';
      let dispatchedSignature = '';
      let dispatchedEvent = '';

      const summary = await webhookService.dispatchPendingOutboxEvents(async (url, init) => {
        dispatchedUrl = url;
        dispatchedSignature = (init.headers as Record<string, string>)['X-BriskSMS-Signature'] || '';
        dispatchedEvent = (init.headers as Record<string, string>)['X-BriskSMS-Event'] || '';
        return { status: 200, ok: true };
      });

      assert.equal(summary.processedEvents, 1);
      assert.equal(summary.deliveredDeliveries, 1);
      assert.equal(dispatchedUrl, endpoint.url);
      assert.equal(dispatchedEvent, BusinessEventType.PAYMENT_MATCHED);
      assert.equal(dispatchedSignature.includes('v1='), true);

      const outboxEvents = await dbStore.getOutboxEventsByOrg(orgId);
      assert.equal(outboxEvents[0]?.isDelivered, true);
    });
  });

  describe('Developer Send Action (DeveloperActionService)', () => {
    it('dispatches SMS using scoped API key (Google Sheets / Zapier Action)', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Zapier Cellular Action',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      messagingService.isCurfewRestricted = () => false;

      const result = await developerActionService.handleSendMessageAction(
        keyResult.plainTextSecret,
        {
          recipientPhone: '+255754000111',
          message: 'Habari! Your order is ready for collection.',
          simSlot: 1,
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.status, 'SUBMITTED');
      assert.equal(result.costCredits, 1);

      const account = await messagingService.getOrCreateAccount(orgId);
      assert.equal(account.creditBalance, 99);
    });

    it('rejects dispatch when API key lacks sms:send scope', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Read-Only Key',
        scopes: [ApiKeyScope.PAYMENTS_READ],
      });

      await assert.rejects(
        () =>
          developerActionService.handleSendMessageAction(
            keyResult.plainTextSecret,
            {
              recipientPhone: '+255754000111',
              message: 'Hello',
            },
          ),
        /Unauthorized/,
      );
    });
  });
});
