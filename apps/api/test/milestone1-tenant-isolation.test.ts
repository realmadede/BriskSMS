import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  EvidenceSourceType,
  VerificationMethod,
  ApiKeyScope,
  BusinessEventType,
  BillingInterval,
} from '@brisksms/shared';
import { BullJob } from '@brisksms/db';
import { dbStore } from '../src/core/store.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { OrganizationService } from '../src/modules/organization/organization.service.js';
import { DeviceService } from '../src/modules/device/device.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { SubscriptionService } from '../src/modules/subscription/subscription.service.js';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { WebhookService } from '../src/modules/developer/webhook.service.js';
import { OAuthService } from '../src/modules/oauth/oauth.service.js';
import {
  processWebhookDeliveryJob,
  processSmsCampaignJob,
  WebhookDeliveryJobData,
  SmsCampaignJobData,
} from '@brisksms/worker';

describe('Milestone 1: Strict Multi-Tenant Isolation Across All Domains & Workers', () => {
  const authService = new AuthService();
  const orgService = new OrganizationService();
  const deviceService = new DeviceService();
  const reconService = new ReconciliationService();
  const ingestionService = new IngestionService(reconService);
  const subService = new SubscriptionService();
  const messagingService = new MessagingService();
  const apiKeyService = new ApiKeyService();
  const webhookService = new WebhookService();
  const oauthService = new OAuthService();

  let orgAId: string;
  let userAId: string;
  let orgBId: string;
  let userBId: string;

  beforeEach(async () => {
    await dbStore.reset();

    const regA = await authService.register({
      email: 'owner-a@tenanta.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Owner A',
      organizationName: 'Tenant A Enterprises',
    });
    orgAId = regA.organizationId!;
    userAId = regA.user.id;

    const regB = await authService.register({
      email: 'owner-b@tenantb.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Owner B',
      organizationName: 'Tenant B Holdings',
    });
    orgBId = regB.organizationId!;
    userBId = regB.user.id;
  });

  it('prevents cross-tenant access to organizations, members, and devices', async () => {
    // Organization details & member lists
    await assert.rejects(
      () => orgService.getOrganization(orgAId, userBId),
      /You do not have access to this organization/,
    );
    await assert.rejects(
      () => orgService.listMembers(orgAId, userBId),
      /You do not have access to (view members of )?this organization/,
    );

    // Device pairing & revocation across tenants
    const pairA = await deviceService.createPairingToken(orgAId, userAId);
    const devA = await deviceService.pairDevice({
      enrollmentToken: pairA.pairingToken,
      deviceModel: 'SM-A54',
      manufacturer: 'Samsung',
      androidVersion: '14',
      appVersion: '1.0.0',
      publicKeyPem: 'key_a',
    });

    // User B cannot view or revoke Tenant A's device
    await assert.rejects(
      () => deviceService.getDevice(devA.deviceId, orgAId, userBId),
      /No access to organization devices/,
    );
    await assert.rejects(
      () => deviceService.revokeDevice(devA.deviceId, orgBId, userBId),
      /Device not found in (this )?organization/,
    );
  });

  it('isolates invoices, payment evidence, reconciliation matching, and verification across organizations', async () => {
    // Tenant A creates an invoice with reference QA77CROSS88
    const invA = await reconService.createInvoice(orgAId, {
      referenceNumber: 'QA77CROSS88',
      totalAmountCents: 8000000n,
      customerPhone: '+255754333444',
    });

    // Tenant B cannot read Tenant A's invoice
    const crossLookup = await reconService.findInvoiceById(orgBId, invA.id);
    assert.equal(crossLookup, null);

    // Tenant B ingests a payment with the exact same reference QA77CROSS88 -> must NOT match Tenant A's invoice!
    const ackB = await ingestionService.ingestEvidence({
      organizationId: orgBId,
      sourceType: EvidenceSourceType.DIRECT_PROVIDER_API,
      senderAddress: 'M-PESA',
      rawPayload: 'QA77CROSS88 Imethibitishwa. Umepokea Tsh80,000 kutoka kwa Asha 255754333444 tarehe 05/11/2026 saa 12:00.',
      deviceTimestamp: new Date('2026-11-05T12:00:00Z'),
    });

    assert.equal(ackB.matchedInvoiceId, undefined);
    assert.equal(ackB.state, 'UNMATCHED');

    // Tenant B cannot verify a payment against Tenant A's invoice
    await assert.rejects(
      () =>
        reconService.verifyPayment(orgBId, {
          paymentId: ackB.paymentId!,
          invoiceId: invA.id,
          verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
          verifiedById: userBId,
        }),
      /not found in organization/,
    );

    // Tenant A's invoice remains untouched
    const invACheck = await reconService.findInvoiceById(orgAId, invA.id);
    assert.equal(invACheck?.paidAmountCents, 0n);
  });

  it('isolates subscriptions, prepaid SMS credits, API keys, OAuth clients, and webhooks across organizations', async () => {
    // Subscriptions
    await subService.checkoutSubscription(orgAId, userAId, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
    assert.equal(await subService.getOrganizationSubscription(orgBId), null);

    // Prepaid SMS credits
    await messagingService.purchaseCredits(orgAId, 250, 'ORG-A-CREDITS');
    assert.equal(await messagingService.getCreditBalance(orgAId), 250);
    assert.equal(await messagingService.getCreditBalance(orgBId), 0);

    // API Keys: Tenant B cannot revoke or rotate Tenant A's API key
    const keyA = await apiKeyService.createApiKey(orgAId, {
      organizationId: orgAId,
      name: 'Org A Key',
      scopes: [ApiKeyScope.SMS_SEND],
    });
    const crossRevoke = await apiKeyService.revokeApiKey(orgBId, keyA.apiKey.id);
    assert.equal(crossRevoke, false);
    await assert.rejects(
      () => apiKeyService.rotateApiKey(orgBId, keyA.apiKey.id),
      /API key not found for this organization/,
    );

    // OAuth Clients: Tenant B cannot issue authorization codes for Tenant A's OAuth client
    const clientA = await oauthService.registerClient({
      organizationId: orgAId,
      name: 'Org A OAuth App',
      redirectUris: ['https://example.com/cb'],
    });
    await assert.rejects(
      () =>
        oauthService.generateAuthorizationCode({
          clientId: clientA.id,
          userId: userBId,
          organizationId: orgBId,
          redirectUri: 'https://example.com/cb',
          scopes: [ApiKeyScope.SMS_SEND],
          codeChallenge: 'challenge_xyz',
        }),
      /OAuth client does not belong to the specified organization/,
    );

    // Webhooks: Tenant B cannot deactivate Tenant A's webhook endpoint
    const epA = await webhookService.registerEndpoint(orgAId, {
      url: 'https://hooks.tenanta.co.tz/webhook',
      subscribedEvents: [BusinessEventType.PAYMENT_VERIFIED],
    });
    const deactivatedByB = await webhookService.deactivateEndpoint(orgBId, epA.id);
    assert.equal(deactivatedByB, false);
    const listB = await webhookService.listEndpoints(orgBId);
    assert.equal(listB.length, 0);
  });

  it('enforces organization context inside background worker jobs and rejects cross-tenant job payloads', async () => {
    const outboxEventA = await dbStore.insertOutboxEvent({
      organizationId: orgAId,
      eventType: BusinessEventType.PAYMENT_VERIFIED,
      payload: { amountCents: '100000' },
    });

    // Forged worker job claiming orgBId for orgAId's outboxEventId must fail
    const forgedWebhookJob: BullJob<WebhookDeliveryJobData> = {
      id: randomUUID(),
      name: 'deliver-outbox-event',
      queueName: 'webhook-delivery',
      data: {
        organizationId: orgBId,
        outboxEventId: outboxEventA.id,
        eventType: BusinessEventType.PAYMENT_VERIFIED,
      },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        delay: 0,
        timeoutMs: 5000,
        requireOrganizationContext: true,
        correlationId: 'test-forged-webhook',
      },
      status: 'active',
      attemptsMade: 1,
      timestamp: Date.now(),
    };

    await assert.rejects(
      () => processWebhookDeliveryJob(forgedWebhookJob),
      /Tenant isolation or missing record/,
    );

    // Forged campaign job claiming orgBId for orgAId's campaignId must fail
    await subService.checkoutSubscription(orgAId, userAId, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
    await messagingService.purchaseCredits(orgAId, 10);
    const { campaign } = await messagingService.createCampaign(orgAId, {
      name: 'Org A Campaign',
      templateText: 'Hello {{name}}',
      recipients: [{ phoneNumber: '0754123456', variables: { name: 'Asha' } }],
    });

    const forgedCampaignJob: BullJob<SmsCampaignJobData> = {
      id: randomUUID(),
      name: 'dispatch-campaign',
      queueName: 'sms-campaign',
      data: {
        organizationId: orgBId,
        campaignId: campaign.id,
      },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        delay: 0,
        timeoutMs: 5000,
        requireOrganizationContext: true,
        correlationId: 'test-forged-campaign',
      },
      status: 'active',
      attemptsMade: 1,
      timestamp: Date.now(),
    };

    await assert.rejects(
      () => processSmsCampaignJob(forgedCampaignJob),
      /Tenant isolation or missing record/,
    );
  });
});
