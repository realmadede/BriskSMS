import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { DatabaseUnavailableError, setSimulatedDatabaseOutage, sql } from '@brisksms/db';
import {
  ApiKeyScope,
  BillingInterval,
  BusinessEventType,
  OutboxStatus,
  PaymentProvider,
  UserRole,
  validateOutboundHttpUrl,
  validateResolvedOutboundUrl,
} from '@brisksms/shared';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { organizationService } from '../src/modules/organization/organization.service.js';
import { OAuthService } from '../src/modules/oauth/oauth.service.js';
import { WebhookService } from '../src/modules/developer/webhook.service.js';
import { SmsGateProvider } from '../src/modules/messaging/providers/smsgate.provider.js';
import { smsGateKeyService } from '../src/modules/messaging/services/smsgate-key.service.js';

const oauthService = new OAuthService();
const webhookService = new WebhookService();
const smsGateProvider = new SmsGateProvider();

describe('Second-Pass Independent Security & Integrity Regressions', () => {
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
    setSimulatedDatabaseOutage(false);
    await dbStore.reset();
    await authService.clearRateLimits();
    smsGateKeyService.clearAll();
  });

  it('1. Blocks OAuth bsk_at_ privilege escalation, multi-org switching, and missing scopes across all controllers', async () => {
    const owner = await authService.register({
      email: 'dual-org-owner@brisksms.co.tz',
      password: 'Password123!',
      fullName: 'Dual Org Owner',
      organizationName: 'Org Alpha',
    });
    const orgAlpha = owner.organizationId!;
    const orgBetaCreated = await organizationService.createOrganization(owner.user.id, {
      name: 'Org Beta',
      countryCode: 'TZA',
    });
    const orgBeta = orgBetaCreated.organization.id;

    // Issue bsk_at_ token scoped strictly to Org Alpha with ONLY PAYMENTS_READ
    const client = await oauthService.registerClient({
      organizationId: orgAlpha,
      name: 'Limited Read Client',
      redirectUris: ['https://app.example.com/cb'],
      isPublic: true,
    });
    const verifier = 'verifier_second_pass_test_secret_12345678901234567890';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = await oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId: owner.user.id,
      organizationId: orgAlpha,
      redirectUri: 'https://app.example.com/cb',
      scopes: [ApiKeyScope.PAYMENTS_READ],
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
    const tokenPair = await oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://app.example.com/cb',
    });

    // Authorization code replay & redirect_uri mismatch must fail
    await assert.rejects(
      () =>
        oauthService.exchangeCodeForTokens({
          clientId: client.id,
          code,
          codeVerifier: verifier,
          redirectUri: 'https://app.example.com/cb',
        }),
      (err: any) => err?.statusCode === 400,
    );

    const authHeaders = {
      Authorization: `Bearer ${tokenPair.access_token}`,
      'Content-Type': 'application/json',
    };

    // Allowed within Org Alpha + PAYMENTS_READ
    const allowedPayments = await makeRequest('GET', '/v1/reconciliation/payments', authHeaders);
    assert.equal(allowedPayments.statusCode, 200);

    // Dual-org bypass via ?organizationId=OrgBeta must return 403 CROSS_ORGANIZATION_FORBIDDEN
    const crossPayments = await makeRequest(
      'GET',
      `/v1/reconciliation/payments?organizationId=${orgBeta}`,
      authHeaders,
    );
    assert.equal(crossPayments.statusCode, 403);
    assert.equal(crossPayments.json?.error?.code, 'CROSS_ORGANIZATION_FORBIDDEN');

    // Missing scope enforcement across reconciliation, messaging, devices, and webhooks
    for (const [method, url, body] of [
      ['GET', '/v1/reconciliation/invoices', undefined],
      ['POST', '/v1/reconciliation/invoices', { referenceNumber: 'INV-X', totalAmountCents: 1000 }],
      ['POST', '/v1/reconciliation/verify', { paymentId: randomUUID() }],
      ['GET', '/v1/messaging/balance', undefined],
      ['POST', '/v1/messaging/campaigns', { name: 'Test', templateText: 'Hi', recipients: [] }],
      ['GET', '/v1/messaging/ledger', undefined],
      ['GET', '/v1/devices', undefined],
      ['GET', '/v1/developer/webhooks', undefined],
    ] as const) {
      const res = await makeRequest(method, url, authHeaders, body as any);
      assert.equal(res.statusCode, 403, `Expected 403 for ${method} ${url}`);
      assert.equal(res.json?.error?.code, 'INSUFFICIENT_SCOPE', `Wrong error code on ${method} ${url}`);
    }

    // Human-only administration endpoints must return 403 OAUTH_FORBIDDEN
    for (const [method, url, body] of [
      ['POST', '/v1/organizations', { name: 'Illegal OAuth Org' }],
      ['GET', '/v1/organizations', undefined],
      ['POST', `/v1/organizations/${orgAlpha}/invitations`, { email: 'evil@brisksms.co.tz', fullName: 'Evil', role: UserRole.OWNER }],
      ['GET', '/v1/developer/api-keys', undefined],
      ['POST', '/v1/developer/api-keys', { name: 'Escalate Key', scopes: [ApiKeyScope.PAYMENTS_WRITE] }],
      ['POST', '/v1/oauth/clients', { name: 'Nested Client', redirectUris: ['https://evil.example/cb'] }],
      ['GET', `/v1/oauth/authorize?client_id=${client.id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}&response_type=code&code_challenge=${challenge}`, undefined],
      ['POST', '/v1/devices/pairing-token', {}],
      ['POST', `/v1/devices/${randomUUID()}/revoke`, {}],
      ['GET', `/v1/organizations/${orgAlpha}/subscription`, undefined],
      ['POST', `/v1/organizations/${orgAlpha}/subscription/checkout`, { planCode: 'PLAN_GROWTH', currency: 'TZS', billingInterval: BillingInterval.MONTHLY }],
      ['GET', '/v1/ingestion/evidence', undefined],
    ] as const) {
      const res = await makeRequest(method, url, authHeaders, body as any);
      assert.equal(res.statusCode, 403, `Expected 403 OAUTH_FORBIDDEN for ${method} ${url}`);
      assert.equal(res.json?.error?.code, 'OAUTH_FORBIDDEN', `Wrong error code on ${method} ${url}`);
    }
  });

  it('2. Prevents single-payment replay and concurrent double-spend on subscription checkout', async () => {
    const reg = await authService.register({
      email: 'sub-replay@brisksms.co.tz',
      password: 'Password123!',
      fullName: 'Sub Owner',
      organizationName: 'Replay Defense Org',
    });
    const orgId = reg.organizationId!;
    const stkId = randomUUID();
    const providerRef = `MPESA_SUB_REF_${Date.now()}`;

    await sql`
      INSERT INTO "stk_push_transactions" (
        "id", "organization_id", "provider", "phone_number", "amount_cents",
        "currency", "status", "provider_reference"
      ) VALUES (
        ${stkId}, ${orgId}, ${PaymentProvider.MPESA}::"PaymentProvider", '+255754000999',
        '10000000', 'TZS', 'SUCCESS'::"StkPushStatus", ${providerRef}
      )
    `;

    const headers = {
      Authorization: `Bearer ${reg.tokens.accessToken}`,
      'Content-Type': 'application/json',
    };
    const payload = {
      planCode: 'PLAN_GROWTH',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
      paymentMethodRef: providerRef,
    };

    // Concurrent race on the same payment reference: exactly 1 succeeds (200), 1 fails (409)
    const [r1, r2] = await Promise.all([
      makeRequest('POST', `/v1/organizations/${orgId}/subscription/checkout`, headers, payload),
      makeRequest('POST', `/v1/organizations/${orgId}/subscription/checkout`, headers, payload),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    assert.deepEqual(codes, [200, 409]);

    // Replay using either provider_reference or internal STK id fails with 409 PAYMENT_REFERENCE_ALREADY_USED
    const replayByRef = await makeRequest(
      'POST',
      `/v1/organizations/${orgId}/subscription/checkout`,
      headers,
      payload,
    );
    assert.equal(replayByRef.statusCode, 409);
    assert.equal(replayByRef.json?.error?.code, 'PAYMENT_REFERENCE_ALREADY_USED');

    const replayById = await makeRequest(
      'POST',
      `/v1/organizations/${orgId}/subscription/checkout`,
      headers,
      { ...payload, paymentMethodRef: stkId },
    );
    assert.equal(replayById.statusCode, 409);
    assert.equal(replayById.json?.error?.code, 'PAYMENT_REFERENCE_ALREADY_USED');
  });

  it('3. Blocks IPv4-mapped IPv6 hex SSRF, DNS-to-private SSRF, and corrupt webhook secret dispatch', async () => {
    delete process.env.ALLOW_PRIVATE_WEBHOOK_NETWORKS;
    delete process.env.ALLOW_PRIVATE_GATEWAY_NETWORKS;

    for (const maliciousUrl of [
      'http://[::ffff:127.0.0.1]:8080/hook',
      'http://[::ffff:7f00:1]/hook',
      'http://[::ffff:169.254.169.254]/latest/meta-data',
      'http://[::]/',
      'http://0.0.0.0/',
      'http://100.64.0.1/',
    ]) {
      assert.throws(() => validateOutboundHttpUrl(maliciousUrl, { allowHttpInProd: true }));
      assert.throws(() => smsGateProvider.resolveEndpoint(maliciousUrl));
    }

    // DNS rebinding / split-horizon private resolution check
    await assert.rejects(
      () =>
        validateResolvedOutboundUrl(
          'https://rebind-test.example.com/webhook',
          { label: 'Webhook URL' },
          async () => [{ address: '::ffff:7f00:1', family: 6 }],
        ),
      /prohibited internal or private IP address/i,
    );

    // Corrupt ciphertext fail-closed behavior in WebhookService
    const reg = await authService.register({
      email: 'webhook-corrupt@brisksms.co.tz',
      password: 'Password123!',
      fullName: 'Webhook Owner',
      organizationName: 'Corrupt Webhook Org',
    });
    const orgId = reg.organizationId!;
    const ep = await webhookService.registerEndpoint(orgId, {
      url: 'https://hooks.example.com/valid-target',
      subscribedEvents: [BusinessEventType.PAYMENT_VERIFIED],
    });
    await sql`
      UPDATE "webhook_endpoints"
      SET "secret" = 'aes-256-gcm:000000000000000000000000:ffffffffffffffffffffffffffffffff:deadbeef'
      WHERE "id" = ${ep.id}::uuid
    `;

    // listEndpoints isolates decryption failures cleanly without crashing
    const listed = await webhookService.listEndpoints(orgId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.signingSecret, '****[DECRYPTION_ERROR]');

    // Outbox delivery fails closed (never signs with ciphertext or skips audit row)
    const outboxId = randomUUID();
    await sql`
      INSERT INTO "outbox_events" (
        "id", "organization_id", "event_type", "payload", "status"
      ) VALUES (
        ${outboxId}, ${orgId}, ${BusinessEventType.PAYMENT_VERIFIED},
        ${JSON.stringify({ ok: true })}::jsonb, ${OutboxStatus.PENDING}::"OutboxStatus"
      )
    `;
    let fetched = false;
    const delivery = await webhookService.deliverOutboxEventById(outboxId, orgId, async () => {
      fetched = true;
      return { status: 200, ok: true };
    });
    assert.equal(fetched, false);
    assert.equal(delivery.delivered, false);
    assert.equal(delivery.results[0]?.statusCode, 0);
  });

  it('4. SmsGateKeyService fails closed with DatabaseUnavailableError during PostgreSQL outage', async () => {
    const reg = await authService.register({
      email: 'smsgate-failclosed@brisksms.co.tz',
      password: 'Password123!',
      fullName: 'Gateway Owner',
      organizationName: 'Gateway FailClosed Org',
    });

    setSimulatedDatabaseOutage(true);
    try {
      await assert.rejects(
        () => smsGateKeyService.setDeviceSigningKey(reg.organizationId!, 'dev-outage-01', 'very_secure_secret_123456'),
        (err: unknown) => err instanceof DatabaseUnavailableError,
      );
      await assert.rejects(
        () => smsGateKeyService.resolveCandidateKeys(reg.organizationId!, 'dev-outage-01'),
        (err: unknown) => err instanceof DatabaseUnavailableError,
      );
    } finally {
      setSimulatedDatabaseOutage(false);
    }
  });
});
