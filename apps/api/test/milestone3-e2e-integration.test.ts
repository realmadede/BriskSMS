import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DeviceStatus,
  DeviceIngestionMode,
  EvidenceSourceType,
  InvoiceStatus,
  TransactionState,
  VerificationMethod,
  ApiKeyScope,
  CreditLedgerEntryType,
  SmsStatus,
  FeatureKey,
  GatewayMode,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { sql, QUEUE_NAMES, setSimulatedDatabaseOutage } from '@brisksms/db';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { OrganizationService } from '../src/modules/organization/organization.service.js';
import { DeviceService } from '../src/modules/device/device.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { WebhookService } from '../src/modules/developer/webhook.service.js';
import { DeveloperActionService } from '../src/modules/developer/developer-action.service.js';
import { createApp } from '../src/app.js';
import {
  processSmsCampaignJob,
  processSmsDeliveryRetryJob,
} from '@brisksms/worker';

describe('BriskSMS Milestone 3: End-to-End Product Integration & Commercial Readiness', () => {
  let authService: AuthService;
  let orgService: OrganizationService;
  let deviceService: DeviceService;
  let reconciliationService: ReconciliationService;
  let ingestionService: IngestionService;
  let messagingService: MessagingService;
  let apiKeyService: ApiKeyService;
  let webhookService: WebhookService;
  let developerActionService: DeveloperActionService;

  beforeEach(async () => {
    await dbStore.reset();
    await dbStore.setFeatureDefinitionDefaultValue(FeatureKey.BULK_MESSAGING_ENABLED, 'true');
    setSimulatedDatabaseOutage(false);

    authService = new AuthService();
    orgService = new OrganizationService();
    deviceService = new DeviceService();
    reconciliationService = new ReconciliationService();
    ingestionService = new IngestionService(reconciliationService);
    messagingService = new MessagingService();
    apiKeyService = new ApiKeyService();
    webhookService = new WebhookService();
    developerActionService = new DeveloperActionService(apiKeyService, messagingService);
  });

  // SCENARIO A: Merchant Onboarding & Device Pairing
  describe('Scenario A: Merchant Onboarding & Android Device Pairing Handshake', () => {
    it('executes full merchant registration, organization setup, pairing token generation, and hardware Keystore enrollment', async () => {
      // 1. Merchant registers
      const auth = await authService.register({
        email: 'merchant@alphatraders.co.tz',
        password: 'Password123!',
        fullName: 'Amani Mushi',
      });
      assert.ok(auth.user.id);
      assert.ok(auth.tokens.accessToken);

      // 2. Merchant provisions organization
      const { organization: org } = await orgService.createOrganization(auth.user.id, {
        name: 'Alpha Traders Ltd',
      });
      assert.ok(org.id);
      assert.equal(org.name, 'Alpha Traders Ltd');

      // 3. Merchant requests single-use pairing token from console
      const tokenRecord = await deviceService.createPairingToken(org.id, auth.user.id);
      assert.ok(tokenRecord.pairingToken);
      assert.ok(tokenRecord.pairingToken.startsWith('bsk_pair_'));

      // 4. Android companion app scans QR code and submits enrollment handshake
      const mockPublicKeyPem = `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+mockEcdsaKey${randomUUID().slice(0, 8)}=\n-----END PUBLIC KEY-----`;
      const pairResult = await deviceService.pairDevice({
        enrollmentToken: tokenRecord.pairingToken,
        label: 'Samsung Galaxy A15 Dual SIM',
        publicKeyPem: mockPublicKeyPem,
        deviceModel: 'SM-A155F',
        manufacturer: 'Samsung',
        androidVersion: '14.0',
        appVersion: '1.0.0',
      });

      assert.ok(pairResult.deviceId);
      assert.ok(pairResult.deviceToken);
      assert.ok(pairResult.deviceToken.startsWith('bsk_dev_'));
      assert.equal(pairResult.organizationId, org.id);

      // 5. Verify pairing token is consumed (single-use invariant)
      await assert.rejects(
        () =>
          deviceService.pairDevice({
            enrollmentToken: tokenRecord.pairingToken,
            label: 'Replay Attempt',
            publicKeyPem: mockPublicKeyPem,
            deviceModel: 'SM-A155F',
            manufacturer: 'Samsung',
            androidVersion: '14.0',
            appVersion: '1.0.0',
          }),
        /Pairing token is invalid, already used, or expired/,
      );

      // 6. Verify enrolled device appears in organization fleet list
      const devices = await deviceService.listDevices(org.id, auth.user.id);
      assert.equal(devices.length, 1);
      assert.equal(devices[0]!.id, pairResult.deviceId);
      assert.equal(devices[0]!.deviceModel, 'SM-A155F');
    });
  });

  // SCENARIO B: Payment Notification Ingestion, Candidate Matching, Review Queue, and Manual Verification Settlement
  describe('Scenario B: Payment Ingestion, Deterministic Matching & Verification Settlement', () => {
    it('ingests Swahili M-Pesa SMS, evaluates candidate invoice, isolates discrepancies to review queue, and settles balance only upon authorized verification', async () => {
      // 1. Setup tenant & enrolled device
      const org = await dbStore.seedOrganizationDirect({
        id: randomUUID(),
        name: 'Kilimanjaro Retail Ltd',
        slug: `kilimanjaro-${randomUUID().slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'ENTERPRISE',
        isActive: true,
      });

      const device = await dbStore.registerDevice({
        id: randomUUID(),
        organizationId: org.id,
        label: 'Shop Floor Relay',
        deviceModel: 'Galaxy A54',
        manufacturer: 'Samsung',
        androidVersion: '14.0',
        appVersion: '1.0.0',
        publicKeyPem: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...',
        status: DeviceStatus.ACTIVE,
        ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
        tokenHash: 'hash_test_123',
      });

      // 2. Create open invoice: INV-2026-9901 for TZS 50,000
      const invoice = await reconciliationService.createInvoice(org.id, {
        referenceNumber: 'INV-2026-9901',
        totalAmountCents: 5000000n, // 50,000 TZS
        customerPhone: '+255754123456',
        customerName: 'Zubeda Juma',
      });
      assert.equal(invoice.status, InvoiceStatus.UNPAID);
      assert.equal(invoice.balanceCents, 5000000n);

      // 3. Android phone ingests real Vodacom M-Pesa payment notification containing reference
      const mpesaSms = 'QB98XY76LK Imethibitishwa. Umepokea Tsh50,000.00 kutoka kwa 255754123456 - ZUBEDA JUMA tarehe 08/11/2026 saa 09:30. Akaunti namba: INV-2026-9901. Salio lako jipya ni Tsh150,000.00.';
      const ingestionAck = await ingestionService.ingestEvidence({
        organizationId: org.id,
        deviceId: device.id,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        senderAddress: 'M-PESA',
        rawPayload: mpesaSms,
        deviceTimestamp: new Date(),
      });

      assert.equal(ingestionAck.status, 'OBSERVED');
      assert.ok(ingestionAck.evidenceId);

      // 4. Critical Financial Invariant: Ingestion ALONE never marks invoice as PAID
      const invoiceAfterIngest = await reconciliationService.findInvoiceById(org.id, invoice.id);
      assert.equal(invoiceAfterIngest?.status, InvoiceStatus.UNPAID);
      assert.equal(invoiceAfterIngest?.balanceCents, 5000000n);

      // 5. Worker evaluates candidate match (TIER_1_EXACT_REFERENCE)
      const payments = await reconciliationService.listPayments(org.id);
      assert.equal(payments.length, 1);
      const payment = payments[0]!;
      assert.equal(payment.state, TransactionState.MATCHED);
      assert.equal(payment.candidateInvoiceId, invoice.id);

      // 6. Manual Finance Verification: Accountant reviews candidate and authorizes settlement
      const settlement = await reconciliationService.verifyPayment(org.id, {
        paymentId: payment.id,
        invoiceId: invoice.id,
        verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
        verifiedById: randomUUID(),
        notes: 'Verified via Bank & M-Pesa Merchant Portal',
      });

      assert.equal(settlement.payment.state, TransactionState.VERIFIED);
      assert.equal(settlement.invoice.status, InvoiceStatus.PAID);
      assert.equal(settlement.invoice.balanceCents, 0n);
      assert.equal(settlement.fulfillmentEligible, true);

      // 7. Test Discrepancy Flow: Underpayment routes to REVIEW_REQUIRED
      const partialInvoice = await reconciliationService.createInvoice(org.id, {
        referenceNumber: 'INV-2026-PARTIAL',
        totalAmountCents: 10000000n, // 100,000 TZS
        customerPhone: '+255712888999',
        customerName: 'Barakael Mushi',
      });
      assert.ok(partialInvoice.id);

      // Customer pays only TZS 30,000 (underpayment)
      const underpaymentSms = 'QB11223344 Imethibitishwa. Umepokea Tsh30,000.00 kutoka kwa 255712888999 - BARAKAEL MUSHI tarehe 08/11/2026 saa 10:15. Salio jipya ni Tsh180,000.00.';
      await ingestionService.ingestEvidence({
        organizationId: org.id,
        deviceId: device.id,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        senderAddress: 'M-PESA',
        rawPayload: underpaymentSms,
        deviceTimestamp: new Date(),
      });

      // Verify discrepancy is isolated in review queue
      const reviewQueue = await reconciliationService.listPayments(org.id, {
        state: TransactionState.REVIEW_REQUIRED,
      });
      assert.equal(reviewQueue.length, 1);
      assert.ok(reviewQueue[0]!.reviewReason);

      // 8. Fraudulent SMS notification is rejected by finance auditor
      const rejectedResult = await reconciliationService.rejectPayment(org.id, {
        paymentId: reviewQueue[0]!.id,
        verifiedById: randomUUID(),
        notes: 'Transaction was reversed by customer. Rejecting evidence.',
      });
      assert.equal(rejectedResult.payment.state, TransactionState.REJECTED);
    });
  });

  // SCENARIO C: Bulk SMS Campaign, Credit Reservation, Cellular Gateway Dispatch, and Failure Refund
  describe('Scenario C: Bulk SMS Campaign, Credit Reservation & Terminal Failure Refund', () => {
    it('reserves prepaid credits, executes cellular campaign, commits deduction, and refunds credits on exhausted retries', async () => {
      const orgId = randomUUID();
      await dbStore.seedOrganizationDirect({
        id: orgId,
        name: 'Bulk Merchant Ltd',
        slug: `bulk-${orgId.slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'ENTERPRISE',
        isActive: true,
      });

      // 1. Purchase 100 prepaid SMS credits
      await messagingService.purchaseCredits(orgId, 100, 'purchase_initial_100');
      const balanceBefore = await messagingService.getCreditBalance(orgId);
      assert.equal(balanceBefore, 100);

      // 2. Create campaign with 5 recipients (requires 5 credits reserved)
      const recipients = [
        { phoneNumber: '+255712000001', variables: { name: 'Customer 1' } },
        { phoneNumber: '+255712000002', variables: { name: 'Customer 2' } },
        { phoneNumber: '+255712000003', variables: { name: 'Customer 3' } },
        { phoneNumber: '+255712000004', variables: { name: 'Customer 4' } },
        { phoneNumber: '+255712000005', variables: { name: 'Customer 5' } },
      ];

      const { campaign } = await messagingService.createCampaign(orgId, {
        name: 'Holiday Discount',
        templateText: 'Habari {{name}}, pata punguzo la 10% wiki hii!',
        recipients,
      });
      assert.equal(campaign.recipientCount, 5);

      // Verify credits reserved
      const balancesAfterReserve = await messagingService.getAccountBalances(orgId);
      assert.equal(balancesAfterReserve.creditBalance, 95); // 100 - 5 = 95 available
      assert.equal(balancesAfterReserve.reservedCredits, 5);

      // 3. Worker executes campaign dispatch job
      const campaignJobResult = await processSmsCampaignJob({
        id: 'job_campaign_1',
        name: 'dispatch-campaign',
        queueName: QUEUE_NAMES.SMS_CAMPAIGN,
        data: { organizationId: orgId, campaignId: campaign.id },
        opts: {} as any,
        status: 'active' as any,
        attemptsMade: 0,
        timestamp: Date.now(),
      });
      assert.equal(campaignJobResult.sentCount, 5);

      // Verify reserved credits committed
      const balancesAfterCommit = await messagingService.getAccountBalances(orgId);
      assert.equal(balancesAfterCommit.creditBalance, 95);
      assert.equal(balancesAfterCommit.reservedCredits, 0);

      // 4. Test Failure Refund: A submitted message fails delivery repeatedly
      const messages = await sql<Record<string, any>>`
        SELECT id FROM sms_messages WHERE organization_id = ${orgId} LIMIT 1
      `;
      const failingMessageId = messages[0]!.id;

      // Simulate attempt 3 failure -> Terminal failure triggers refund
      await sql`
        UPDATE sms_messages SET attempt_count = 3 WHERE id = ${failingMessageId}
      `;

      const retryResult = await processSmsDeliveryRetryJob({
        id: 'job_retry_1',
        name: 'sms-retry',
        queueName: QUEUE_NAMES.SMS_DELIVERY_RETRY,
        data: { organizationId: orgId, messageId: failingMessageId },
        opts: {} as any,
        status: 'active' as any,
        attemptsMade: 1,
        timestamp: Date.now(),
      });

      assert.equal(retryResult.status, SmsStatus.FAILED);
      assert.equal(retryResult.refunded, true);

      // Verify credit refunded back to balance
      const balancesAfterRefund = await messagingService.getAccountBalances(orgId);
      assert.equal(balancesAfterRefund.creditBalance, 96); // 95 + 1 refunded = 96

      // Verify ledger has REFUND entry
      const ledger = await messagingService.listLedgerEntries(orgId);
      const refundEntry = ledger.find((l) => l.entryType === CreditLedgerEntryType.REFUND);
      assert.ok(refundEntry);
      assert.equal(refundEntry.amountCredits, 1);
    });
  });

  // SCENARIO D: Developer Platform Scoped API Key and Webhook HMAC Dispatch
  describe('Scenario D: Developer Platform Scoped API Keys & Webhook Outbox HMAC Delivery', () => {
    it('creates scoped API keys, enforces permission boundaries, and verifies HMAC-SHA256 signature on outbox deliveries', async () => {
      const orgId = randomUUID();
      await dbStore.seedOrganizationDirect({
        id: orgId,
        name: 'API Merchant Ltd',
        slug: `api-merchant-${orgId.slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'ENTERPRISE',
        isActive: true,
      });

      // 1. Generate scoped API Key
      const keyResult = await apiKeyService.createApiKey(orgId, {
        organizationId: orgId,
        name: 'Zapier Automation Key',
        scopes: [ApiKeyScope.SMS_SEND, ApiKeyScope.PAYMENTS_READ],
      });
      assert.ok(keyResult.plainTextSecret.startsWith('bsk_live_'));
      assert.ok(keyResult.apiKey.id);

      // 2. Validate API Key Scopes
      const validSend = await apiKeyService.validateApiKey(keyResult.plainTextSecret, ApiKeyScope.SMS_SEND);
      assert.ok(validSend);
      assert.equal(validSend.organizationId, orgId);

      const invalidScope = await apiKeyService.validateApiKey(keyResult.plainTextSecret, ApiKeyScope.INVOICES_WRITE);
      assert.equal(invalidScope, null); // lacks invoices:write scope

      // 3. Configure gateway, purchase credits and test developer dispatch action
      await messagingService.updateGatewayConfig(orgId, {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        apiToken: 'smsgate_test_token_123',
      });
      await messagingService.purchaseCredits(orgId, 10, 'purchase_dev_10');
      const actionResult = await developerActionService.handleSendMessageAction(keyResult.plainTextSecret, {
        recipientPhone: '+255784999111',
        message: 'Order confirmed via Zapier integration.',
        simSlot: 1,
      });
      assert.equal(actionResult.success, true);
      assert.ok(actionResult.messageId);

      // 4. Register Webhook Endpoint (Zapier Catch Hook)
      const endpoint = await webhookService.registerEndpoint(orgId, {
        url: 'https://hooks.zapier.com/hooks/catch/12345/abcde/',
        subscribedEvents: ['payment.matched' as any],
        secret: 'whsec_test_secret_32_bytes_entropy_1234',
      });
      assert.ok(endpoint.id);
      assert.equal(endpoint.url, 'https://hooks.zapier.com/hooks/catch/12345/abcde/');

      // 5. Test HMAC-SHA256 signature computation
      const testPayload = JSON.stringify({ event: 'payment.matched', amount: 50000 });
      const timestamp = Math.floor(Date.now() / 1000);
      const signatureHeader = webhookService.computeSignature(testPayload, endpoint.secret, timestamp);
      assert.ok(signatureHeader.startsWith(`t=${timestamp},v1=`));
    });
  });

  // SCENARIO E: Multi-Tenant Boundary Isolation
  describe('Scenario E: Strict Multi-Tenant Boundary Isolation Across All Resources', () => {
    it('forbids cross-tenant reads, mutations, and actions between Organization A and Organization B', async () => {
      // Create Org A and Org B
      const orgA = await dbStore.seedOrganizationDirect({
        id: randomUUID(),
        name: 'Tenant Alpha',
        slug: `alpha-${randomUUID().slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'STANDARD',
        isActive: true,
      });

      const orgB = await dbStore.seedOrganizationDirect({
        id: randomUUID(),
        name: 'Tenant Beta',
        slug: `beta-${randomUUID().slice(0, 8)}`,
        countryCode: 'TZA',
        timezone: 'Africa/Dar_es_Salaam',
        planTier: 'STANDARD',
        isActive: true,
      });

      // Tenant A creates invoice
      const invoiceA = await reconciliationService.createInvoice(orgA.id, {
        referenceNumber: 'INV-A-100',
        totalAmountCents: 2000000n,
        customerPhone: '+255711000001',
      });

      // Tenant B tries to query Tenant A's invoice -> must return null
      const crossInvoice = await reconciliationService.findInvoiceById(orgB.id, invoiceA.id);
      assert.equal(crossInvoice, null);

      // Tenant B lists invoices -> must not see Tenant A's invoice
      const invoicesB = await reconciliationService.listInvoices(orgB.id);
      assert.equal(invoicesB.length, 0);

      // Tenant A creates API key
      const keyA = await apiKeyService.createApiKey(orgA.id, {
        organizationId: orgA.id,
        name: 'Alpha Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });

      // Tenant B attempts to revoke Tenant A's key -> must fail
      const revoked = await apiKeyService.revokeApiKey(orgB.id, keyA.apiKey.id);
      assert.equal(revoked, false);

      // Tenant B lists API keys -> must not see Tenant A's key
      const keysB = await apiKeyService.listApiKeys(orgB.id);
      assert.equal(keysB.length, 0);
    });
  });

  // SCENARIO F: Service Outage Recovery & Operational Observability
  describe('Scenario F: Service Outage Recovery, Health Checks & Outbox Resilience', () => {
    it('reports accurate health status on /v1/health across database, redis, workers, and queues', async () => {
      const app = createApp();

      // Normal healthy state
      const healthyReq = {
        method: 'GET',
        url: new URL('http://localhost:3000/v1/health'),
        path: '/v1/health',
        params: {},
        query: {},
        headers: {},
        body: {},
        rawBody: '',
        rawBodyBuffer: Buffer.from(''),
        context: {},
        rawReq: {} as any,
      };

      const healthRes = (await (app as any).routes.find((r: any) => r.method === 'GET' && r.pattern.test('/v1/health'))?.handler(healthyReq)) as any;
      assert.equal(healthRes.success, true);
      assert.equal(healthRes.statusCode, 200);
      assert.equal(healthRes.data.dependencies.postgresql.status, 'UP');
      assert.equal(healthRes.data.dependencies.redis.status, 'UP');
      assert.equal(healthRes.data.dependencies.queues.status, 'UP');

      // Simulated PostgreSQL outage
      setSimulatedDatabaseOutage(true);
      const downRes = (await (app as any).routes.find((r: any) => r.method === 'GET' && r.pattern.test('/v1/health'))?.handler(healthyReq)) as any;
      assert.equal(downRes.success, false);
      assert.equal(downRes.statusCode, 503);
      assert.equal(downRes.data.dependencies.postgresql.status, 'DOWN');
      setSimulatedDatabaseOutage(false);
    });
  });
});
