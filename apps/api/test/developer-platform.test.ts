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
        /Forbidden/,
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

    it('rejects dispatch with 401 INVALID_CREDENTIALS when device token (bsk_dev_...) is provided', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': 'bsk_dev_fake_device_token_123', 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Hello from device' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.success, false);
      assert.equal(res.json?.error?.code, 'INVALID_CREDENTIALS');
      assert.match(res.json?.error?.message, /Device tokens cannot be used/);
    });

    it('rejects dispatch with 401 when invalid API key is provided', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': 'bsk_live_nonexistentkey123456789012345678', 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Hello' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.success, false);
      assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects dispatch with 401 when revoked API key is provided', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Revoked Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });
      await apiKeyService.revokeApiKey(orgId, keyResult.apiKey.id);

      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': keyResult.plainTextSecret, 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Hello' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.success, false);
      assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects dispatch with 401 when only browser session cookie is provided without key', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { Cookie: 'bsk_session=valid_or_invalid_jwt_cookie', 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111', message: 'Cookie attempt' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.success, false);
      assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects dispatch with 400 VALIDATION_ERROR when recipient or message is missing', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Valid Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const missingRecipient = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': keyResult.plainTextSecret, 'Content-Type': 'application/json' },
        { message: 'Hello' },
      );
      assert.equal(missingRecipient.statusCode, 400);
      assert.equal(missingRecipient.json?.error?.code, 'VALIDATION_ERROR');

      const missingMessage = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': keyResult.plainTextSecret, 'Content-Type': 'application/json' },
        { recipientPhone: '+255754000111' },
      );
      assert.equal(missingMessage.statusCode, 400);
      assert.equal(missingMessage.json?.error?.code, 'VALIDATION_ERROR');
    });

    it('enforces tenant isolation and deducts credits strictly on the key owning organization', async () => {
      const otherOrgId = randomUUID();
      await dbStore.seedOrganizationDirect({
        id: otherOrgId,
        name: 'Serengeti Tours',
        slug: `serengeti-${otherOrgId.slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'BUSINESS',
        isActive: true,
      });
      await messagingService.purchaseCredits(otherOrgId, 50, 'SEED_OTHER');

      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Tenant Isolation Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      // Attempt to spoof organizationId in request body to otherOrgId
      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        { 'x-api-key': keyResult.plainTextSecret, 'Content-Type': 'application/json' },
        {
          recipientPhone: '+255754000111',
          message: 'Tenant check message',
          organizationId: otherOrgId,
        },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.success, true);

      // Verify dispatch was recorded for orgId and NOT otherOrgId
      const orgEntries = await messagingService.listLedgerEntries(orgId);
      const otherEntries = await messagingService.listLedgerEntries(otherOrgId);

      const deduction = orgEntries.find((e) => e.entryType === 'USAGE_DEDUCTION');
      assert.ok(deduction, 'Credit deduction must be recorded for key owning organization');
      assert.equal(otherEntries.length, 1, 'Other organization ledger must remain untouched');
      assert.equal(otherEntries[0]?.referenceId, 'SEED_OTHER');
    });

    it('validates Idempotency-Key format and rejects invalid formats with 400 VALIDATION_ERROR', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Idempotency Validation Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const res = await makeRequest(
        'POST',
        '/v1/messages/send',
        {
          'x-api-key': keyResult.plainTextSecret,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'invalid key with spaces and special chars @#$%',
        },
        { recipientPhone: '+255754000111', message: 'Test invalid key' },
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.json?.error?.code, 'VALIDATION_ERROR');
      assert.match(res.json?.error?.message, /Idempotency key must be between 1 and 80 characters/);
    });

    it('prevents duplicate SMS dispatch and credit deduction on repeated requests with same Idempotency-Key header', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Idempotency Test Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const idempotencyKey = `idem_test_${Date.now()}_991`;

      // 1. Initial request
      const res1 = await makeRequest(
        'POST',
        '/v1/messages/send',
        {
          'x-api-key': keyResult.plainTextSecret,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        { recipientPhone: '+255754000111', message: 'Order #101 confirmed' },
      );

      assert.equal(res1.statusCode, 200);
      assert.equal(res1.json?.success, true);
      const messageId1 = res1.json?.data?.messageId;
      assert.ok(messageId1);

      const initialLedger = await messagingService.listLedgerEntries(orgId);
      const deductions1 = initialLedger.filter((l) => l.referenceId === idempotencyKey);
      assert.equal(deductions1.length, 1);

      // 2. Duplicate retry with same idempotency key and identical body
      const res2 = await makeRequest(
        'POST',
        '/v1/messages/send',
        {
          'x-api-key': keyResult.plainTextSecret,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        { recipientPhone: '+255754000111', message: 'Order #101 confirmed' },
      );

      assert.equal(res2.statusCode, 200);
      assert.equal(res2.json?.success, true);
      assert.equal(res2.json?.data?.messageId, messageId1, 'Must return identical messageId');

      // Verify no duplicate deduction was created
      const finalLedger = await messagingService.listLedgerEntries(orgId);
      const deductions2 = finalLedger.filter((l) => l.referenceId === idempotencyKey);
      assert.equal(deductions2.length, 1, 'Must not create duplicate deduction in ledger');
    });

    it('rejects duplicate request with 409 DUPLICATE_IDEMPOTENCY when same key is reused with different parameters', async () => {
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Idempotency Conflict Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const idempotencyKey = `idem_conflict_${Date.now()}`;

      // 1. Initial request
      const res1 = await makeRequest(
        'POST',
        '/v1/messages/send',
        {
          'x-api-key': keyResult.plainTextSecret,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        { recipientPhone: '+255754000111', message: 'Initial message' },
      );
      assert.equal(res1.statusCode, 200);

      // 2. Conflicting request with same idempotency key but different content
      const res2 = await makeRequest(
        'POST',
        '/v1/messages/send',
        {
          'x-api-key': keyResult.plainTextSecret,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        { recipientPhone: '+255754000111', message: 'Completely different content!' },
      );

      assert.equal(res2.statusCode, 409);
      assert.equal(res2.json?.success, false);
      assert.equal(res2.json?.error?.code, 'DUPLICATE_IDEMPOTENCY');
      assert.match(res2.json?.error?.message, /different request parameters/);
    });

    it('isolates idempotency keys across organizations', async () => {
      const otherOrgId = randomUUID();
      await dbStore.seedOrganizationDirect({
        id: otherOrgId,
        name: 'Ngorongoro Safaris',
        slug: `ngorongoro-${otherOrgId.slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'BUSINESS',
        isActive: true,
      });
      await messagingService.purchaseCredits(otherOrgId, 20, 'SEED_NGORONGORO');
      await messagingService.updateGatewayConfig(otherOrgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        apiToken: 'enc_token_ngo_123',
      });

      const keyOrg1 = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Org1 Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });
      const keyOrg2 = await apiKeyService.createApiKey(otherOrgId, {
        organizationId: otherOrgId,
        name: 'Org2 Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      const sharedKey = `shared_idem_${Date.now()}`;

      // Org 1 sends with sharedKey
      const res1 = await makeRequest(
        'POST',
        '/v1/messages/send',
        {
          'x-api-key': keyOrg1.plainTextSecret,
          'Content-Type': 'application/json',
          'Idempotency-Key': sharedKey,
        },
        { recipientPhone: '+255754000111', message: 'Org 1 message' },
      );
      assert.equal(res1.statusCode, 200);

      // Org 2 sends with the same sharedKey
      const res2 = await makeRequest(
        'POST',
        '/v1/messages/send',
        {
          'x-api-key': keyOrg2.plainTextSecret,
          'Content-Type': 'application/json',
          'Idempotency-Key': sharedKey,
        },
        { recipientPhone: '+255754000222', message: 'Org 2 message' },
      );
      assert.equal(res2.statusCode, 200);
      assert.notEqual(res1.json?.data?.messageId, res2.json?.data?.messageId, 'Must be distinct messages for distinct tenants');
    });
  });
});
