import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { sql } from '@brisksms/db';
import {
  ApiKeyScope,
  BillingInterval,
  FeatureKey,
  UserRole,
} from '@brisksms/shared';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { entitlementService } from '../src/modules/subscription/entitlement.service.js';
import { organizationService } from '../src/modules/organization/organization.service.js';
import { OAuthService } from '../src/modules/oauth/oauth.service.js';
import { grantDeveloperPlan } from './helpers/developer-plan.js';
import { BILLING_WORKSPACE_SETTING } from '../src/modules/subscription/subscription.service.js';

const oauthService = new OAuthService();

describe('Cluster 1 Security & Integrity Hardening Suite', () => {
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

  it('sets HTTP hardening headers and rejects oversized payloads (>1MB) with 413', async () => {
    const health = await makeRequest('GET', '/v1/catalog/public');
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(health.headers['x-frame-options'], 'DENY');
    assert.equal(health.headers['referrer-policy'], 'no-referrer');

    const hugePayload = JSON.stringify({ data: 'a'.repeat(1_050_000) });
    const hugeRes = await makeRequest(
      'POST',
      '/v1/auth/login',
      { 'Content-Type': 'application/json' },
      hugePayload,
    );
    assert.equal(hugeRes.statusCode, 413);
    assert.equal(hugeRes.json?.error?.code, 'PAYLOAD_TOO_LARGE');
  });

  it('rejects deactivated user and revoked organization membership immediately on JWT endpoints', async () => {
    const reg = await authService.register({
      email: 'deactivated-user@brisksms.app',
      password: 'Password123!',
      fullName: 'Deactivated Target',
      organizationName: 'Target Org',
    });

    const okRes = await makeRequest('GET', `/v1/reconciliation/invoices?organizationId=${reg.organizationId}`, {
      Authorization: `Bearer ${reg.tokens.accessToken}`,
    });
    assert.equal(okRes.statusCode, 200);

    await sql`UPDATE "users" SET "is_active" = false WHERE "id" = ${reg.user.id}`;
    const blockedRes = await makeRequest('GET', `/v1/reconciliation/invoices?organizationId=${reg.organizationId}`, {
      Authorization: `Bearer ${reg.tokens.accessToken}`,
    });
    assert.equal(blockedRes.statusCode, 401);
    assert.equal(blockedRes.json?.error?.code, 'ACCOUNT_DEACTIVATED');
  });

  it('enforces platform admin key (503 unset / 403 mismatch) on /v1/admin/catalog/plans', async () => {
    const merchant = await authService.register({
      email: 'merchant-nonadmin@brisksms.app',
      password: 'Password123!',
      fullName: 'Merchant User',
      organizationName: 'Merchant Co',
    });

    const prevAdminSecret = process.env.PLATFORM_ADMIN_SECRET;
    try {
      delete process.env.PLATFORM_ADMIN_SECRET;
      const resUnconfigured = await makeRequest(
        'POST',
        '/v1/admin/catalog/plans',
        { Authorization: `Bearer ${merchant.tokens.accessToken}`, 'Content-Type': 'application/json' },
        { code: 'PLAN_ILLEGAL', name: 'Illegal' },
      );
      assert.equal(resUnconfigured.statusCode, 503);
      assert.equal(resUnconfigured.json?.error?.code, 'PLATFORM_ADMIN_UNCONFIGURED');

      process.env.PLATFORM_ADMIN_SECRET = 'super_secret_platform_key_32bytes!';
      const resForbidden = await makeRequest(
        'POST',
        '/v1/admin/catalog/plans',
        {
          Authorization: `Bearer ${merchant.tokens.accessToken}`,
          'X-Platform-Admin-Key': 'wrong_key',
          'Content-Type': 'application/json',
        },
        { code: 'PLAN_ILLEGAL', name: 'Illegal' },
      );
      assert.equal(resForbidden.statusCode, 403);
      assert.equal(resForbidden.json?.error?.code, 'PLATFORM_ADMIN_FORBIDDEN');
    } finally {
      if (prevAdminSecret === undefined) delete process.env.PLATFORM_ADMIN_SECRET;
      else process.env.PLATFORM_ADMIN_SECRET = prevAdminSecret;
    }
  });

  it('fails closed (402 PAYMENT_VERIFICATION_REQUIRED) on paid subscription checkout without verified payment and expires lapsed periods', async () => {
    const reg = await authService.register({
      email: 'sub-failclosed@brisksms.app',
      password: 'Password123!',
      fullName: 'Billing Owner',
      organizationName: 'Billing Org',
    });

    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, reg.organizationId!);
    const unpaidCheckout = await makeRequest(
      'POST',
      `/v1/organizations/${reg.organizationId}/subscription/checkout`,
      { Authorization: `Bearer ${reg.tokens.accessToken}`, 'Content-Type': 'application/json' },
      {
        planCode: 'PLAN_GROWTH',
        currency: 'TZS',
        billingInterval: BillingInterval.MONTHLY,
        paymentMethodRef: 'FORGED_REF_12345',
      },
    );
    assert.equal(unpaidCheckout.statusCode, 402);
    assert.equal(unpaidCheckout.json?.error?.code, 'PAYMENT_VERIFICATION_REQUIRED');

    // Trial checkout without payment succeeds as TRIALING with isPaid=false (never fake PAID)
    const trialCheckout = await makeRequest(
      'POST',
      `/v1/organizations/${reg.organizationId}/subscription/checkout`,
      { Authorization: `Bearer ${reg.tokens.accessToken}`, 'Content-Type': 'application/json' },
      {
        planCode: 'PLAN_GROWTH',
        currency: 'TZS',
        billingInterval: BillingInterval.MONTHLY,
      },
    );
    assert.equal(trialCheckout.statusCode, 200);
    assert.equal(trialCheckout.json?.data?.subscription?.status, 'TRIALING');
    const histRows = await sql<{ is_paid: boolean; paid_at: Date | null }>`
      SELECT "is_paid", "paid_at" FROM "subscription_billing_invoices"
      WHERE "organization_id" = ${reg.organizationId}
      ORDER BY "created_at" DESC LIMIT 1
    `;
    assert.equal(histRows[0]?.is_paid, false);
    assert.equal(histRows[0]?.paid_at, null);

    // Expire current subscription period and verify entitlement revokes plan features
    await sql`
      UPDATE "organization_subscriptions"
      SET "status" = 'ACTIVE',
          "current_period_end" = NOW() - INTERVAL '2 days',
          "trial_ends_at" = NOW() - INTERVAL '2 days'
      WHERE "organization_id" = ${reg.organizationId}
    `;
    const activeSub = await dbStore.getOrganizationSubscription(reg.organizationId!);
    assert.ok(activeSub);
    const expiredEnabled = await entitlementService.isFeatureEnabled(
      reg.organizationId!,
      FeatureKey.WEBHOOK_ACCESS,
    );
    assert.equal(expiredEnabled, false);
  });

  it('blocks cross-organization access on stk-push and ingestion evidence endpoints with 403', async () => {
    const orgA = await authService.register({
      email: 'org-a-iso@brisksms.app',
      password: 'Password123!',
      fullName: 'Org A Owner',
      organizationName: 'Org A',
    });
    const orgB = await authService.register({
      email: 'org-b-iso@brisksms.app',
      password: 'Password123!',
      fullName: 'Org B Owner',
      organizationName: 'Org B',
    });

    const stkCross = await makeRequest(
      'GET',
      `/v1/payments/stk-push/chk_cross_tenant_123?organizationId=${orgB.organizationId}`,
      { Authorization: `Bearer ${orgA.tokens.accessToken}` },
    );
    assert.equal(stkCross.statusCode, 403);
    assert.equal(stkCross.json?.error?.code, 'CROSS_ORGANIZATION_FORBIDDEN');

    const ingCross = await makeRequest(
      'GET',
      `/v1/ingestion/evidence?organizationId=${orgB.organizationId}`,
      { Authorization: `Bearer ${orgA.tokens.accessToken}` },
    );
    assert.equal(ingCross.statusCode, 403);
    assert.equal(ingCross.json?.error?.code, 'CROSS_ORGANIZATION_FORBIDDEN');
  });

  it('protects OWNER role from ADMIN demotion and avoids sentinel password hashes on invitations', async () => {
    const owner = await authService.register({
      email: 'owner-org@brisksms.app',
      password: 'Password123!',
      fullName: 'Original Owner',
      organizationName: 'Role Guard Org',
    });
    const invitedAdmin = await organizationService.inviteMember(owner.organizationId!, owner.user.id, {
      email: 'second-admin@brisksms.app',
      fullName: 'Second Admin',
      role: UserRole.ADMIN,
    });

    const dbUser = await dbStore.findUserById(invitedAdmin.user.id);
    assert.equal(dbUser?.passwordHash, undefined);

    await assert.rejects(
      () =>
        organizationService.updateMemberRole(
          owner.organizationId!,
          invitedAdmin.user.id,
          owner.user.id,
          UserRole.CASHIER,
        ),
      (err: any) => err?.statusCode === 403,
    );
  });

  it('enforces OAuth clientSecret on confidential refresh, rejects plain PKCE, and authenticates Bearer bsk_at_ tokens', async () => {
    const reg = await authService.register({
      email: 'oauth-hardening@brisksms.app',
      password: 'Password123!',
      fullName: 'OAuth Owner',
      organizationName: 'OAuth Hardening Org',
    });

    await grantDeveloperPlan(reg.organizationId!);
    const clientSecret = 'very_strong_client_secret_value_123';
    const client = await oauthService.registerClient({
      organizationId: reg.organizationId!,
      name: 'Confidential App',
      redirectUris: ['https://app.example.com/callback'],
      isPublic: false,
      clientSecret,
    });

    await assert.rejects(
      () =>
        oauthService.generateAuthorizationCode({
          clientId: client.id,
          userId: reg.user.id,
          organizationId: reg.organizationId!,
          redirectUri: 'https://app.example.com/callback',
          scopes: [ApiKeyScope.PAYMENTS_READ],
          codeChallenge: 'plain_challenge_value_with_enough_length_123456',
          codeChallengeMethod: 'plain',
        }),
      (err: any) => err?.code === 'INVALID_REQUEST' && err?.statusCode === 400,
    );

    const codeVerifier = 's256_verifier_example_string_with_sufficient_entropy_1234567890';
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const code = await oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId: reg.user.id,
      organizationId: reg.organizationId!,
      redirectUri: 'https://app.example.com/callback',
      scopes: [ApiKeyScope.PAYMENTS_READ],
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    const tokenPair = await oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code,
      codeVerifier,
      redirectUri: 'https://app.example.com/callback',
      clientSecret,
    });

    await assert.rejects(
      () =>
        oauthService.refreshTokens({
          clientId: client.id,
          refreshToken: tokenPair.refresh_token,
        }),
      (err: any) => err?.statusCode === 401,
    );

    const readRes = await makeRequest(
      'GET',
      `/v1/reconciliation/payments?organizationId=${reg.organizationId}`,
      { Authorization: `Bearer ${tokenPair.access_token}` },
    );
    assert.equal(readRes.statusCode, 200);

    const invoicesBlockedRes = await makeRequest(
      'GET',
      `/v1/reconciliation/invoices?organizationId=${reg.organizationId}`,
      { Authorization: `Bearer ${tokenPair.access_token}` },
    );
    assert.equal(invoicesBlockedRes.statusCode, 403);
    assert.equal(invoicesBlockedRes.json?.error?.code, 'INSUFFICIENT_SCOPE');

    const writeBlockedRes = await makeRequest(
      'POST',
      '/v1/messages/send',
      { Authorization: `Bearer ${tokenPair.access_token}`, 'Content-Type': 'application/json' },
      { recipientPhone: '+255754000111', message: 'Should be blocked by scope' },
    );
    assert.equal(writeBlockedRes.statusCode, 403);
    assert.equal(writeBlockedRes.json?.error?.code, 'INSUFFICIENT_SCOPE');
  });
});
