import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
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
      const secret = 'mock_webhook_hmac_test_key';
      const timestamp = 1793912000;
      const payload = JSON.stringify({ event: 'payment.matched', amount: 150000 });

      const signature = webhookService.computeSignature(payload, secret, timestamp);
      assert.equal(signature.startsWith(`t=${timestamp},v1=`), true);
    });

    it('registers endpoint and delivers outbox events with HMAC signature', async () => {
      const endpoint = await webhookService.registerEndpoint(orgId, {
        url: 'https://hooks.example.com/catch/mock_hook_123/',
        subscribedEvents: [BusinessEventType.PAYMENT_MATCHED],
        secret: 'mock_zapier_endpoint_secret',
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

  describe('HTTP Route Integration: POST /v1/messages/send & /v1/developer/messages/send', () => {
    const router = createApp();

    async function makeRequest(
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: any,
    ): Promise<{ statusCode: number; json: any }> {
      const socket = new Socket();
      const req = new IncomingMessage(socket);
      req.method = method;
      req.url = path;
      req.headers = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      );

      let statusCode = 200;
      let capturedBody = '';
      const res = new ServerResponse(req);
      res.writeHead = (code: number, ..._rest: any[]) => {
        statusCode = code;
        return res;
      };
      res.end = (chunk?: any, ..._rest: any[]) => {
        if (chunk) capturedBody += chunk.toString();
        return res;
      };

      if (body !== undefined) {
        req.push(JSON.stringify(body));
      }
      req.push(null);

      await router.handle(req, res);
      let parsed: any = null;
      try {
        parsed = capturedBody ? JSON.parse(capturedBody) : null;
      } catch {
        parsed = capturedBody;
      }
      return { statusCode, json: parsed };
    }

    it('authenticates POST /v1/messages/send using x-api-key header', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Zapier Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': keyResult.plainTextSecret, 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Order ready' },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.data?.success, true);
      assert.ok(res.json?.data?.messageId);
    });

    it('authenticates POST /v1/messages/send using Authorization: Bearer <key>', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Bearer Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { Authorization: `Bearer ${keyResult.plainTextSecret}`, 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Order ready' },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.data?.success, true);
    });

    it('supports alias POST /v1/developer/messages/send with recipient property', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Alias Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const res = await makeRequest(
        'POST',
        '/v1/developer/messages/send',
        { 'x-api-key': keyResult.plainTextSecret, 'Content-Type': 'application/json' },
        { recipient: '+255754000111', message: 'Order ready via alias' },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.data?.success, true);
    });

    it('rejects dispatch with 401 when authentication header is missing', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Unauthenticated' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.success, false);
      assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects dispatch with 403 when API key lacks sms:send scope', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Wrong Scope Key',
        scopes: [ApiKeyScope.PAYMENTS_READ],
      });

      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': keyResult.plainTextSecret, 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Forbidden' },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.success, false);
      assert.equal(res.json?.error?.code, 'INSUFFICIENT_SCOPE');
    });
  });
});
