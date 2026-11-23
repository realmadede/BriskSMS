import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { sql } from '@brisksms/db';
import {
  ApiKeyScope,
  BillingInterval,
  GatewayMode,
  PaymentProvider,
  SmsStatus,
  StkPushStatus,
  TransactionState,
  UserRole,
  encryptSecret,
} from '@brisksms/shared';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { BILLING_WORKSPACE_SETTING } from '../src/modules/subscription/subscription.service.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { messagingService } from '../src/modules/messaging/messaging.service.js';
import { outboundSmsJobService } from '../src/modules/messaging/outbound-sms-job.service.js';
import { runMaintenanceCleanup, processSmsDeliveryRetryJob } from '@brisksms/worker';

describe('BriskSMS SaaS Production-Readiness & End-to-End Workflows', () => {
  const router = createApp();

  async function makeRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string | Record<string, unknown>,
  ): Promise<{ statusCode: number; headers: Record<string, any>; json: any }> {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = path;
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    const res = new ServerResponse(req);
    let capturedBody = '';
    let statusCode = 200;
    const responseHeaders: Record<string, any> = {};

    res.setHeader = (name: string, value: any) => {
      responseHeaders[name.toLowerCase()] = value;
      return res;
    };
    res.writeHead = (code: number, hdrs?: any) => {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          responseHeaders[k.toLowerCase()] = v;
        }
      }
      return res;
    };
    res.end = (chunk?: any) => {
      if (chunk) capturedBody += chunk.toString();
      return res;
    };

    if (body !== undefined) {
      req.push(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.push(null);

    await router.handle(req, res);
    let json: any = null;
    try {
      json = capturedBody ? JSON.parse(capturedBody) : null;
    } catch {
      json = capturedBody;
    }
    return { statusCode, headers: responseHeaders, json };
  }

  beforeEach(async () => {
    await dbStore.reset();
    await authService.clearRateLimits();
  });

  it('strips passwordHash and twoFactorSecret from all user profile responses', async () => {
    const reg = await authService.register({
      email: '2fa-safe@brisksms.app',
      password: 'Password123!',
      fullName: 'Safe User',
      organizationName: 'Safe Co',
    });

    await sql`
      UPDATE "users"
      SET "two_factor_secret" = 'JBSWY3DPEHPK3PXP', "two_factor_enabled" = true
      WHERE "id" = ${reg.user.id}
    `;

    const meRes = await makeRequest('GET', '/v1/auth/me', {
      Authorization: `Bearer ${reg.tokens.accessToken}`,
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json?.data?.user?.passwordHash, undefined);
    assert.equal(meRes.json?.data?.user?.twoFactorSecret, undefined);
    assert.equal(meRes.json?.data?.user?.twoFactorEnabled, true);
  });

  it('completes forgot-password and reset-password with single-use domain-separated tokens', async () => {
    await authService.register({
      email: 'reset-flow@brisksms.app',
      password: 'OldPassword123!',
      fullName: 'Reset Target',
      organizationName: 'Reset Co',
    });

    const forgotRes = await makeRequest(
      'POST',
      '/v1/auth/forgot-password',
      { 'Content-Type': 'application/json' },
      { email: 'reset-flow@brisksms.app' },
    );
    assert.equal(forgotRes.statusCode, 200);
    const resetToken = forgotRes.json?.data?.resetToken as string;
    assert.ok(resetToken && resetToken.startsWith('bsk_pr_'));

    // Password reset token must NOT be accepted on /v1/auth/verify-email
    const wrongEndpointRes = await makeRequest(
      'POST',
      '/v1/auth/verify-email',
      { 'Content-Type': 'application/json' },
      { token: resetToken },
    );
    assert.equal(wrongEndpointRes.statusCode, 400);

    // Reset password succeeds once and revokes prior sessions
    const resetRes = await makeRequest(
      'POST',
      '/v1/auth/reset-password',
      { 'Content-Type': 'application/json' },
      { token: resetToken, newPassword: 'NewStrongPassword456!' },
    );
    assert.equal(resetRes.statusCode, 200);
    assert.equal(resetRes.json?.data?.passwordReset, true);

    // Replay of consumed reset token is rejected
    const replayRes = await makeRequest(
      'POST',
      '/v1/auth/reset-password',
      { 'Content-Type': 'application/json' },
      { token: resetToken, newPassword: 'AnotherPassword789!' },
    );
    assert.equal(replayRes.statusCode, 400);

    // Login with new password succeeds
    const loginRes = await makeRequest(
      'POST',
      '/v1/auth/login',
      { 'Content-Type': 'application/json' },
      { email: 'reset-flow@brisksms.app', password: 'NewStrongPassword456!' },
    );
    assert.equal(loginRes.statusCode, 200);
    assert.ok(loginRes.json?.data?.tokens?.accessToken);
  });

  it('completes member invitation, password setup via accept-invitation, and workspace switching', async () => {
    const owner = await authService.register({
      email: 'owner-inv@brisksms.app',
      password: 'Password123!',
      fullName: 'Workspace Owner',
      organizationName: 'Primary Workspace',
    });

    const inviteRes = await makeRequest(
      'POST',
      `/v1/organizations/${owner.organizationId}/invitations`,
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      { email: 'new-finance@brisksms.app', role: UserRole.FINANCE, fullName: 'Finance Staff' },
    );
    assert.equal(inviteRes.statusCode, 200);
    assert.equal(inviteRes.json?.data?.invitationStatus, 'PENDING');
    const invitationToken = inviteRes.json?.data?.invitationToken as string;
    assert.ok(invitationToken && invitationToken.startsWith('bsk_inv_'));

    // Invited user sets password and accepts invitation
    const acceptRes = await makeRequest(
      'POST',
      '/v1/auth/accept-invitation',
      { 'Content-Type': 'application/json' },
      { token: invitationToken, password: 'FinancePassword123!' },
    );
    assert.equal(acceptRes.statusCode, 200);
    assert.equal(acceptRes.json?.data?.organizationId, owner.organizationId);
    assert.equal(acceptRes.json?.data?.role, UserRole.FINANCE);

    // Replay of already-accepted invitation is rejected
    const replayInvite = await makeRequest(
      'POST',
      '/v1/auth/accept-invitation',
      { 'Content-Type': 'application/json' },
      { token: invitationToken, password: 'FinancePassword123!' },
    );
    assert.equal(replayInvite.statusCode, 400);

    // Owner creates a second organization and switches active session to it
    const createOrg2 = await makeRequest(
      'POST',
      '/v1/organizations',
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      { name: 'Secondary Branch', countryCode: 'TZA' },
    );
    assert.equal(createOrg2.statusCode, 200);
    const secondOrgId = createOrg2.json?.data?.organization?.id as string;
    assert.ok(secondOrgId);

    const switchRes = await makeRequest(
      'POST',
      '/v1/auth/switch-organization',
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      { organizationId: secondOrgId },
    );
    assert.equal(switchRes.statusCode, 200);
    assert.equal(switchRes.json?.data?.organizationId, secondOrgId);
  });

  it('accepts callback-settled standalone STK push for subscription checkout and blocks cross-alias replay', async () => {
    const owner = await authService.register({
      email: 'sub-stk@brisksms.app',
      password: 'Password123!',
      fullName: 'Sub Owner',
      organizationName: 'Sub Org',
    });
    const orgId = owner.organizationId!;

    // Simulate a callback-settled standalone STK transaction (invoice_id IS NULL, settled_payment_id IS NOT NULL)
    const rawEvidenceId = randomUUID();
    const settledPaymentId = randomUUID();
    const stkTxId = randomUUID();
    const providerRef = 'MPESA_SUB_CALLBACK_991';
    const now = new Date();

    await sql`
      INSERT INTO "raw_payment_evidence" (
        "id", "organization_id", "source_type", "sender_address", "raw_payload",
        "device_timestamp"
      ) VALUES (
        ${rawEvidenceId}, ${orgId}, 'ANDROID_NOTIFICATION_RELAY'::"EvidenceSourceType", 'M-PESA',
        ${JSON.stringify({ receipt: providerRef })}, ${now}
      )
    `;

    await sql`
      INSERT INTO "normalized_payments" (
        "id", "organization_id", "raw_evidence_id", "provider", "reference",
        "amount_cents", "currency", "sender_phone", "sender_name", "provider_timestamp",
        "deduplication_hash", "state", "confidence_tier", "matched_invoice_id"
      ) VALUES (
        ${settledPaymentId}, ${orgId}, ${rawEvidenceId}, ${PaymentProvider.MPESA}::"PaymentProvider", ${providerRef},
        50000000::bigint, 'TZS', '+255754111222', 'Sub Payer', ${now},
        ${randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')},
        ${TransactionState.VERIFIED}::"TransactionState", 'EXACT', NULL
      )
    `;

    await sql`
      INSERT INTO "stk_push_transactions" (
        "id", "organization_id", "provider", "phone_number", "amount_cents", "currency",
        "reference_number", "invoice_id", "status",
        "provider_reference", "settled_payment_id"
      ) VALUES (
        ${stkTxId}, ${orgId}, ${PaymentProvider.MPESA}::"PaymentProvider", '+255754111222',
        50000000::bigint, 'TZS', 'SUB-PAY-1', NULL, ${StkPushStatus.SUCCESS}::"StkPushStatus",
        ${providerRef}, ${settledPaymentId}
      )
    `;

    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, orgId);
    // Checkout using stkTxId succeeds even though settled_payment_id is populated
    const checkoutRes = await makeRequest(
      'POST',
      `/v1/organizations/${orgId}/subscription/checkout`,
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {
        planCode: 'PLAN_GROWTH',
        currency: 'TZS',
        billingInterval: BillingInterval.MONTHLY,
        paymentMethodRef: stkTxId,
      },
    );
    assert.equal(checkoutRes.statusCode, 200);
    assert.equal(checkoutRes.json?.data?.subscription?.status, 'ACTIVE');

    // Replay using settledPaymentId or providerRef is blocked with 409
    const replayBySettledId = await makeRequest(
      'POST',
      `/v1/organizations/${orgId}/subscription/checkout`,
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {
        planCode: 'PLAN_ENTERPRISE',
        currency: 'TZS',
        billingInterval: BillingInterval.MONTHLY,
        paymentMethodRef: settledPaymentId,
      },
    );
    assert.equal(replayBySettledId.statusCode, 409);

    const invList = await makeRequest(
      'GET',
      `/v1/organizations/${orgId}/subscription/invoices`,
      { Authorization: `Bearer ${owner.tokens.accessToken}` },
    );
    assert.equal(invList.statusCode, 200);
    assert.equal(invList.json?.data?.invoices?.length, 1);
  });

  it('supports campaign listing, inspection, cancellation with credit release, and operational developer endpoints', async () => {
    const owner = await authService.register({
      email: 'camp-ops@brisksms.app',
      password: 'Password123!',
      fullName: 'Campaign Owner',
      organizationName: 'Campaign Org',
    });
    const orgId = owner.organizationId!;
    await makeRequest(
      'POST',
      `/v1/organizations/${orgId}/subscription/checkout`,
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {
        planCode: 'PLAN_ENTERPRISE',
        currency: 'TZS',
        billingInterval: BillingInterval.MONTHLY,
      },
    );
    await messagingService.purchaseCredits(orgId, 20, 'topup_camp_ops');

    // Create scheduled campaign (reserves 2 credits)
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const createCamp = await makeRequest(
      'POST',
      '/v1/messaging/campaigns',
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {
        organizationId: orgId,
        name: 'Scheduled Promo',
        templateText: 'Habari [name]!',
        scheduledAt: futureDate,
        recipients: [
          { phoneNumber: '+255754123456', variables: { name: 'Asha' } },
          { phoneNumber: '+255713123456', variables: { name: 'Juma' } },
        ],
      },
    );
    assert.equal(createCamp.statusCode, 201);
    const campaignId = createCamp.json?.data?.campaign?.id as string;
    assert.ok(campaignId);

    const balMid = await messagingService.getAccountBalances(orgId);
    assert.equal(balMid.creditBalance, 18);
    assert.equal(balMid.reservedCredits, 2);

    // List and inspect campaign
    const listRes = await makeRequest('GET', '/v1/messaging/campaigns', {
      Authorization: `Bearer ${owner.tokens.accessToken}`,
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json?.data?.campaigns?.length, 1);

    // Cancel campaign and verify reserved credits are released back to creditBalance
    const cancelRes = await makeRequest(
      'POST',
      `/v1/messaging/campaigns/${campaignId}/cancel`,
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {},
    );
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelRes.json?.data?.campaign?.status, 'CANCELLED');

    const balAfter = await messagingService.getAccountBalances(orgId);
    assert.equal(balAfter.creditBalance, 20);
    assert.equal(balAfter.reservedCredits, 0);

    // Configure gateway and provision signing key via HTTP endpoints
    const gwRes = await makeRequest(
      'PUT',
      '/v1/messaging/gateway-config',
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {
        gatewayMode: GatewayMode.MANAGED_GATEWAY,
        gatewayBaseUrl: 'https://gateway.brisksms.app/api/v1',
        defaultSimSlot: 1,
      },
    );
    assert.equal(gwRes.statusCode, 200);

    const keyRes = await makeRequest(
      'POST',
      '/v1/messaging/signing-keys/gateway',
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      { secret: 'whsec_gateway_secret_min_16_chars' },
    );
    assert.equal(keyRes.statusCode, 201);

    // Create and rotate API key, then inspect audit logs
    const createApiKey = await makeRequest(
      'POST',
      '/v1/developer/api-keys',
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      { name: 'ERP Key', scopes: [ApiKeyScope.SMS_SEND] },
    );
    assert.equal(createApiKey.statusCode, 201);
    const apiKeyId = createApiKey.json?.data?.apiKey?.id as string;

    const rotateRes = await makeRequest(
      'POST',
      `/v1/developer/api-keys/${apiKeyId}/rotate`,
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {},
    );
    assert.equal(rotateRes.statusCode, 200);
    assert.ok(rotateRes.json?.data?.plainTextSecret?.startsWith('bsk_live_'));

    const auditRes = await makeRequest('GET', '/v1/developer/audit-logs', {
      Authorization: `Bearer ${owner.tokens.accessToken}`,
    });
    assert.equal(auditRes.statusCode, 200);
    assert.ok(Array.isArray(auditRes.json?.data?.auditLogs));
    assert.ok(auditRes.json.data.auditLogs.length > 0);
  });

  it('sweeps due scheduled campaigns, expired outbound SMS jobs with credit refund, and stale STK checkouts in runMaintenanceCleanup', async () => {
    const owner = await authService.register({
      email: 'maint-sweep@brisksms.app',
      password: 'Password123!',
      fullName: 'Sweep Owner',
      organizationName: 'Sweep Org',
    });
    const orgId = owner.organizationId!;
    await makeRequest(
      'POST',
      `/v1/organizations/${orgId}/subscription/checkout`,
      {
        Authorization: `Bearer ${owner.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      {
        planCode: 'PLAN_ENTERPRISE',
        currency: 'TZS',
        billingInterval: BillingInterval.MONTHLY,
      },
    );
    await messagingService.purchaseCredits(orgId, 10, 'topup_sweep');

    // 1. Enqueue an outbound SMS job and expire its TTL in the past
    const enq = await outboundSmsJobService.enqueueJob(orgId, {
      to: '+255754999888',
      content: 'Expiring device job',
      ttlSeconds: 60,
    });
    await sql`
      UPDATE "outbound_sms_jobs"
      SET "created_at" = NOW() - INTERVAL '10 minutes',
          "expires_at" = NOW() - INTERVAL '5 minutes'
      WHERE "id" = ${enq.job.id}
    `;

    // 2. Insert a stale PENDING STK transaction older than 15 minutes
    const staleStkId = randomUUID();
    await sql`
      INSERT INTO "stk_push_transactions" (
        "id", "organization_id", "provider", "phone_number", "amount_cents", "currency",
        "reference_number", "status", "created_at"
      ) VALUES (
        ${staleStkId}, ${orgId}, ${PaymentProvider.MPESA}::"PaymentProvider", '+255754000111',
        100000::bigint, 'TZS', 'STALE-STK', ${StkPushStatus.PENDING}::"StkPushStatus",
        NOW() - INTERVAL '20 minutes'
      )
    `;

    // 3. Run maintenance cleanup
    const sweepRes = await runMaintenanceCleanup(30);
    assert.equal(sweepRes.expiredOutboundSmsJobs, 1);
    assert.equal(sweepRes.expiredStkTransactions, 1);

    // Verify credit was refunded after outbound job expired
    const bal = await messagingService.getAccountBalances(orgId);
    assert.equal(bal.creditBalance, 10);

    // 4. Verify processSmsDeliveryRetryJob performs gateway re-dispatch when credentials are present
    const encToken = encryptSecret(JSON.stringify({ type: 'BEARER', token: 'retry_tok_999' }));
    await sql`
      UPDATE "messaging_accounts"
      SET "gateway_base_url" = 'https://8.8.8.8/api/v1', "encrypted_api_token" = ${encToken}
      WHERE "organization_id" = ${orgId}
    `;
    const retryMsgId = randomUUID();
    await sql`
      INSERT INTO "sms_messages" (
        "id", "organization_id", "recipient_phone", "message_text", "status",
        "cost_credits", "sim_slot", "attempt_count", "created_at", "updated_at"
      ) VALUES (
        ${retryMsgId}, ${orgId}, '+255754333444', 'Retry test body',
        ${SmsStatus.QUEUED}::"SmsStatus", 1, 1, 1, NOW(), NOW()
      )
    `;

    const retryRes = await processSmsDeliveryRetryJob(
      {
        id: 'retry_job_1',
        name: 'retry-sms',
        queueName: 'sms-delivery-retry',
        data: { organizationId: orgId, messageId: retryMsgId },
        opts: {} as any,
        status: 'active' as any,
        attemptsMade: 0,
        timestamp: Date.now(),
      },
      async () =>
        new Response(JSON.stringify({ id: 'upstream_retry_ok_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    assert.equal(retryRes.status, SmsStatus.SUBMITTED);
    assert.equal(retryRes.refunded, false);
  });
});
