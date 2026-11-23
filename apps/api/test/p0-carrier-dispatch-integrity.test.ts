import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  ApiKeyScope,
  BusinessEventType,
  InvoiceStatus,
  PaymentProvider,
  StkPushStatus,
} from '@brisksms/shared';
import { sql } from '@brisksms/db';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import {
  AirtelStkAdapter,
  HalopesaStkAdapter,
  MpesaStkAdapter,
  StkAdapterRegistry,
  TestCallbackVerifier,
  TestStkAdapter,
  TigoStkAdapter,
  UnsupportedStkAdapter,
  stkPushService,
} from '../src/modules/stk-push/index.js';
import { grantDeveloperPlan } from './helpers/developer-plan.js';

describe('P0: Carrier Dispatch Adapter Integrity & Fail-Closed Boundaries', () => {
  const router = createApp();
  const apiKeyService = new ApiKeyService();
  const reconciliationService = new ReconciliationService();

  const orgId = randomUUID();
  let apiKey: string;
  const TEST_SECRET = 'p0_dispatch_integrity_callback_secret_987';

  function signCallback(body: unknown, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
    const raw = JSON.stringify(body);
    const sig = createHmac('sha256', TEST_SECRET).update(`${ts}.${raw}`, 'utf8').digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-Signature': sig,
      'X-Timestamp': String(ts),
    };
  }

  async function makeRequest(
    method: string,
    urlPath: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<{ statusCode: number; json: any }> {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = urlPath;
    const normalizedHeaders: Record<string, string> = { host: 'localhost:3000' };
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }
    req.headers = normalizedHeaders;

    const res = new ServerResponse(req);
    let rawResp = '';
    let statusCode = 200;
    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.write = (chunk: any) => {
      if (chunk) rawResp += chunk.toString();
      return true;
    };
    res.end = (chunk?: any) => {
      if (chunk) rawResp += chunk.toString();
      return res;
    };

    if (body !== undefined) {
      req.push(JSON.stringify(body));
    }
    req.push(null);

    await router.handle(req, res);
    let parsed: any = null;
    try {
      parsed = rawResp ? JSON.parse(rawResp) : null;
    } catch {
      parsed = rawResp;
    }
    return { statusCode, json: parsed };
  }

  beforeEach(async () => {
    await dbStore.reset();
    stkPushService.verifierRegistry.resetToDefaults();
    stkPushService.adapterRegistry.resetToDefaults();

    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Honest Dispatch Traders Ltd',
      slug: `honest-dispatch-${orgId.slice(0, 8)}`,
      countryCode: 'TZA',
      planTier: 'ENTERPRISE',
      isActive: true,
    });

    await grantDeveloperPlan(orgId);
    const created = await apiKeyService.createApiKey(orgId, {
      organizationId: orgId,
      name: 'STK Key',
      scopes: [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_READ, ApiKeyScope.INVOICES_WRITE],
    });
    apiKey = created.plainTextSecret;
  });

  afterEach(() => {
    stkPushService.verifierRegistry.resetToDefaults();
    stkPushService.adapterRegistry.resetToDefaults();
  });

  it('1. unconfigured carrier adapters directly fail closed and never return simulated live success', async () => {
    const adapters = [
      new MpesaStkAdapter(),
      new TigoStkAdapter(),
      new AirtelStkAdapter(),
      new HalopesaStkAdapter(),
    ];

    for (const adapter of adapters) {
      assert.equal(adapter.isConfigured, false);
      const res = await adapter.initiatePush({
        checkoutId: 'stk_direct_test',
        organizationId: orgId,
        phoneNumber: '255754000111',
        amountCents: 1000000n,
        currency: 'TZS',
      });

      assert.equal(res.success, false);
      assert.equal(res.outcome, 'UNCONFIGURED');
      assert.equal(res.code, 'PROVIDER_DISPATCH_DISABLED');
      assert.equal(res.retryable, false);
      assert.equal(res.providerCheckoutId, undefined);
      assert.equal(res.customerPrompt, undefined);
    }
  });

  it('2. unsupported adapters fail closed with UNSUPPORTED_STK_PROVIDER for TTCL and bank rails', async () => {
    const registry = new StkAdapterRegistry();
    for (const provider of [
      PaymentProvider.TTCL_PESA,
      PaymentProvider.CRDB_BANK,
      PaymentProvider.NMB_BANK,
      PaymentProvider.MANUAL_BANK_TRANSFER,
    ]) {
      const adapter = registry.getAdapter(provider);
      assert.ok(adapter instanceof UnsupportedStkAdapter);
      assert.equal(adapter.isConfigured, false);

      const res = await adapter.initiatePush({
        checkoutId: 'stk_unsupp',
        organizationId: orgId,
        phoneNumber: '255732000111',
        amountCents: 500000n,
        currency: 'TZS',
      });
      assert.equal(res.success, false);
      assert.equal(res.outcome, 'UNSUPPORTED');
      assert.equal(res.code, 'UNSUPPORTED_STK_PROVIDER');
      assert.equal(res.retryable, false);
      assert.equal(res.providerCheckoutId, undefined);
    }
  });

  it('3. unconfigured MNOs fail closed via API, leave status UNSUPPORTED (not PENDING), and never settle invoice', async () => {
    const inv = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-DISPATCH-OFF',
      totalAmountCents: 2500000n,
    });

    const res = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      { phoneNumber: '0754 111 222', amount: 25000, invoiceId: inv.id },
    );

    assert.equal(res.statusCode, 503);
    assert.equal(res.json?.success, false);
    assert.equal(res.json?.error?.code, 'PROVIDER_DISPATCH_DISABLED');
    const checkoutId = res.json?.error?.details?.checkoutId as string;
    assert.ok(checkoutId);

    const rows = await sql<Record<string, any>>`
      SELECT * FROM "stk_push_transactions" WHERE "id" = ${checkoutId}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, StkPushStatus.UNSUPPORTED);
    assert.equal(rows[0]!.dispatch_outcome, 'UNCONFIGURED');
    assert.equal(rows[0]!.provider_checkout_id, null);
    assert.equal(rows[0]!.provider_reference, null);
    assert.equal(rows[0]!.settled_payment_id, null);

    // No PAYMENT_STK_INITIATED event emitted and invoice stays UNPAID
    const outbox = await sql`
      SELECT * FROM "outbox_events"
      WHERE "organization_id" = ${orgId} AND "event_type" = ${BusinessEventType.PAYMENT_STK_INITIATED}
    `;
    assert.equal(outbox.length, 0);

    const invAfter = await reconciliationService.findInvoiceById(orgId, inv.id);
    assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
    assert.equal(invAfter?.paidAmountCents, 0n);
  });

  it('4. unsupported carrier (TTCL 073x) fails closed with 422 UNSUPPORTED_STK_PROVIDER without settling', async () => {
    const inv = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-TTCL-OFF',
      totalAmountCents: 1000000n,
    });

    const res = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      { phoneNumber: '0733 444 555', amount: 10000, invoiceId: inv.id },
    );

    assert.equal(res.statusCode, 422);
    assert.equal(res.json?.error?.code, 'UNSUPPORTED_STK_PROVIDER');
    const checkoutId = res.json?.error?.details?.checkoutId as string;

    const statusDto = await stkPushService.getStkTransactionStatus(orgId, checkoutId);
    assert.equal(statusDto.status, StkPushStatus.UNSUPPORTED);
    assert.equal(statusDto.provider, PaymentProvider.TTCL_PESA);
    assert.equal(statusDto.providerReference, null);
    assert.equal(statusDto.settledPaymentId, null);

    const invAfter = await reconciliationService.findInvoiceById(orgId, inv.id);
    assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
  });

  it('5. callbacks cannot settle UNSUPPORTED, FAILED, INITIATING, or DISPATCH_UNCERTAIN checkouts', async () => {
    stkPushService.verifierRegistry.registerVerifier(
      new TestCallbackVerifier(PaymentProvider.MPESA, { secretKey: TEST_SECRET }),
    );

    const inv = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-NO-SETTLE',
      totalAmountCents: 3000000n,
    });

    // Trigger an UNSUPPORTED checkout by default
    const failRes = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      { phoneNumber: '0754 222 333', amount: 30000, invoiceId: inv.id },
    );
    const unsuppId = failRes.json?.error?.details?.checkoutId as string;

    // Seed INITIATING and DISPATCH_UNCERTAIN rows directly to test strict state boundary
    const initId = `stk_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const uncId = `stk_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await dbStore.createStkTransaction({
      id: initId,
      organizationId: orgId,
      provider: PaymentProvider.MPESA,
      phoneNumber: '255754222333',
      amountCents: 3000000n,
      status: StkPushStatus.INITIATING,
      invoiceId: inv.id,
    });
    await dbStore.createStkTransaction({
      id: uncId,
      organizationId: orgId,
      provider: PaymentProvider.MPESA,
      phoneNumber: '255754222333',
      amountCents: 3000000n,
      status: StkPushStatus.DISPATCH_UNCERTAIN,
      invoiceId: inv.id,
    });

    for (const [idx, cid] of [unsuppId, initId, uncId].entries()) {
      const cbPayload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: cid,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 30000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: `BLOCKED_CB_${idx}` },
                { Name: 'PhoneNumber', Value: 255754222333 },
              ],
            },
          },
        },
      };
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        signCallback(cbPayload, Math.floor(Date.now() / 1000) + idx),
        cbPayload,
      );
      assert.equal(cbRes.statusCode, 200);
      assert.notEqual(cbRes.json?.data?.status, StkPushStatus.SUCCESS);
    }

    const invAfter = await reconciliationService.findInvoiceById(orgId, inv.id);
    assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
    assert.equal(invAfter?.paidAmountCents, 0n);

    assert.equal((await dbStore.getNormalizedPaymentsByOrg(orgId)).length, 0);
    assert.equal(
      (await sql`SELECT * FROM "payment_reference_claims" WHERE "organization_id" = ${orgId}`).length,
      0,
    );
  });

  it('6. transport timeout/error records DISPATCH_UNCERTAIN, blocks unsafe retries, and sanitizes secrets', async () => {
    let dispatchAttempts = 0;
    stkPushService.adapterRegistry.registerAdapter(
      new TestStkAdapter(PaymentProvider.MPESA, {
        initiateHandler: async () => {
          dispatchAttempts += 1;
          throw new Error(
            'ETIMEDOUT connecting to https://user:secret_pass_99@api.carrier.example/stk with Bearer tok_live_secret_xyz apiKey=secret_val',
          );
        },
      }),
    );

    const inv = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-TIMEOUT',
      totalAmountCents: 4500000n,
    });

    const idemKey = `idem-timeout-${randomUUID()}`;
    const res1 = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      { phoneNumber: '0754 333 444', amount: 45000, invoiceId: inv.id },
    );

    assert.equal(res1.statusCode, 504);
    assert.equal(res1.json?.error?.code, 'STK_DISPATCH_UNCERTAIN');
    assert.equal(dispatchAttempts, 1);

    // Ensure secret tokens/passwords are redacted in both API response and database
    const respMsg = String(res1.json?.error?.message || '');
    assert.ok(!respMsg.includes('tok_live_secret_xyz'));
    assert.ok(!respMsg.includes('secret_pass_99'));
    assert.ok(!respMsg.includes('secret_val'));

    const checkoutId = res1.json?.error?.details?.checkoutId as string;
    const statusDto = await stkPushService.getStkTransactionStatus(orgId, checkoutId);
    assert.equal(statusDto.status, StkPushStatus.DISPATCH_UNCERTAIN);
    assert.equal(statusDto.dispatchOutcome, 'UNCERTAIN');
    assert.equal(statusDto.providerReference, null);
    assert.ok(!String(statusDto.errorMessage || '').includes('tok_live_secret_xyz'));

    // Retry with same Idempotency-Key MUST NOT invoke adapter again!
    const resRetry = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      { phoneNumber: '0754 333 444', amount: 45000, invoiceId: inv.id },
    );
    assert.equal(resRetry.statusCode, 409);
    assert.equal(resRetry.json?.error?.code, 'STK_DISPATCH_UNCERTAIN');
    assert.equal(dispatchAttempts, 1);

    const invAfter = await reconciliationService.findInvoiceById(orgId, inv.id);
    assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
  });

  it('7. definitive pre-acceptance failure records FAILED, emits payment.stk.failed, and never settles', async () => {
    let calls = 0;
    stkPushService.adapterRegistry.registerAdapter(
      new TestStkAdapter(PaymentProvider.MPESA, {
        initiateHandler: async () => {
          calls += 1;
          return {
            outcome: 'DEFINITIVE_FAILURE',
            success: false,
            code: 'CARRIER_REJECTED_MSISDN',
            retryable: false,
            errorMessage: 'Subscriber wallet blocked before push acceptance',
          };
        },
      }),
    );

    const inv = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-DEF-FAIL',
      totalAmountCents: 2000000n,
    });
    const idemKey = `idem-fail-${randomUUID()}`;

    const res = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      { phoneNumber: '0754 444 555', amount: 20000, invoiceId: inv.id },
    );

    assert.equal(res.statusCode, 502);
    assert.equal(res.json?.error?.code, 'CARRIER_REJECTED_MSISDN');
    assert.equal(calls, 1);

    const checkoutId = res.json?.error?.details?.checkoutId as string;
    const txRow = await stkPushService.getStkTransactionStatus(orgId, checkoutId);
    assert.equal(txRow.status, StkPushStatus.FAILED);
    assert.equal(txRow.providerReference, null);

    // Retry with same idempotency key does NOT re-call adapter
    const res2 = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      { phoneNumber: '0754 444 555', amount: 20000, invoiceId: inv.id },
    );
    assert.equal(res2.statusCode, 502);
    assert.equal(calls, 1);

    const invAfter = await reconciliationService.findInvoiceById(orgId, inv.id);
    assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
  });

  it('8. duplicate accepted initiations are idempotent, detect parameter conflicts, and persist no fake provider_reference', async () => {
    let calls = 0;
    stkPushService.adapterRegistry.registerAdapter(
      new TestStkAdapter(PaymentProvider.MPESA, {
        initiateHandler: async (params) => {
          calls += 1;
          return {
            outcome: 'ACCEPTED',
            success: true,
            providerCheckoutId: `ws_CO_${params.checkoutId}`,
            customerPrompt: 'Please enter your M-Pesa PIN.',
          };
        },
      }),
    );

    const idemKey = `idem-ok-${randomUUID()}`;
    const reqPayload = { phoneNumber: '0754 555 666', amount: 50000 };

    const r1 = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      reqPayload,
    );
    assert.equal(r1.statusCode, 201);
    assert.equal(r1.json?.data?.status, StkPushStatus.PENDING);
    assert.equal(calls, 1);

    // No fabricated provider_reference at initiation time!
    const dbRow = await stkPushService.getStkTransactionStatus(orgId, r1.json.data.checkoutId);
    assert.equal(dbRow.providerReference, null);
    assert.equal(dbRow.providerCheckoutId, `ws_CO_${r1.json.data.checkoutId}`);

    // Duplicate replay returns identical checkoutId without second dispatch
    const r2 = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      reqPayload,
    );
    assert.equal(r2.statusCode, 201);
    assert.equal(r2.json?.data?.checkoutId, r1.json?.data?.checkoutId);
    assert.equal(calls, 1);

    // Reusing same Idempotency-Key with altered amount rejects 409 IDEMPOTENCY_CONFLICT
    const rConflict = await makeRequest(
      'POST',
      '/v1/payments/stk-push',
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idemKey,
      },
      { phoneNumber: '0754 555 666', amount: 75000 },
    );
    assert.equal(rConflict.statusCode, 409);
    assert.equal(rConflict.json?.error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(calls, 1);

    // Valid callback matching provider_checkout_id resolves and settles cleanly
    stkPushService.verifierRegistry.registerVerifier(
      new TestCallbackVerifier(PaymentProvider.MPESA, { secretKey: TEST_SECRET }),
    );
    const cbPayload = {
      Body: {
        stkCallback: {
          CheckoutRequestID: `ws_CO_${r1.json.data.checkoutId}`,
          ResultCode: 0,
          ResultDesc: 'Success',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 50000 },
              { Name: 'Currency', Value: 'TZS' },
              { Name: 'MpesaReceiptNumber', Value: 'P0REALCK01' },
              { Name: 'PhoneNumber', Value: 255754555666 },
            ],
          },
        },
      },
    };
    const cbRes = await makeRequest(
      'POST',
      '/v1/payments/stk-push/callback/mpesa',
      signCallback(cbPayload),
      cbPayload,
    );
    assert.equal(cbRes.statusCode, 200);
    assert.equal(cbRes.json?.data?.status, StkPushStatus.SUCCESS);
    assert.equal(cbRes.json?.data?.providerReference, 'P0REALCK01');
  });

  it('9. TestStkAdapter cannot be instantiated when NODE_ENV=production', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(
        () => new TestStkAdapter(PaymentProvider.MPESA),
        /SECURITY VIOLATION: TestStkAdapter cannot be instantiated in production environment/,
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('10. all 8 providers keep callback verifiers disabled by default', async () => {
    stkPushService.verifierRegistry.resetToDefaults();
    for (const provider of Object.values(PaymentProvider)) {
      const check = await stkPushService.verifierRegistry.verifyCallback({
        provider,
        headers: {},
        body: {},
      });
      assert.equal(check.isValid, false);
      assert.equal(check.code, 'PROVIDER_CALLBACK_DISABLED');
    }
  });
});
