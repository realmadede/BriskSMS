import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import { HttpException } from '../src/core/http.js';
import {
  ApiKeyScope,
  EvidenceSourceType,
  InvoiceStatus,
  PaymentProvider,
  StkPushStatus,
} from '@brisksms/shared';
import { sql } from '@brisksms/db';
import { dbStore } from '../src/core/store.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { stkPushService, TestCallbackVerifier, TestStkAdapter } from '../src/modules/stk-push/index.js';
import { grantDeveloperPlan } from './helpers/developer-plan.js';

describe('Carrier STK Push & Asynchronous Reconciliation Engine', () => {
  const router = createApp();
  const apiKeyService = new ApiKeyService();
  const reconciliationService = new ReconciliationService();
  const ingestionService = new IngestionService(reconciliationService);

  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  let validApiKey: string;
  let restrictedApiKey: string;

  const TEST_CALLBACK_SECRET = 'test_stk_callback_signing_secret_key_12345';

  function createSignedCallbackHeaders(
    body: any,
    customTimestampSec?: number,
    customSecret?: string,
  ): Record<string, string> {
    const timestamp = customTimestampSec ?? Math.floor(Date.now() / 1000);
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    const signingInput = `${timestamp}.${rawBody}`;
    const signature = createHmac('sha256', customSecret || TEST_CALLBACK_SECRET)
      .update(signingInput, 'utf8')
      .digest('hex');

    return {
      'Content-Type': 'application/json',
      'X-Signature': signature,
      'X-Timestamp': timestamp.toString(),
    };
  }

  async function makeRequest(
    method: string,
    urlPath: string,
    headers: Record<string, string>,
    body?: any,
  ): Promise<{ statusCode: number; json: any }> {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = urlPath;
    const lowerHeaders: Record<string, string> = { host: 'localhost:3000' };
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }
    req.headers = lowerHeaders;

    const res = new ServerResponse(req);
    let capturedBody = '';
    let statusCode = 200;

    res.writeHead = (code: number, ..._args: any[]) => {
      statusCode = code;
      return res;
    };
    res.write = (chunk: any, ..._rest: any[]) => {
      if (chunk) capturedBody += chunk.toString();
      return true;
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

  beforeEach(async () => {
    await dbStore.reset();
    stkPushService.verifierRegistry.resetToDefaults();
    stkPushService.adapterRegistry.resetToDefaults();

    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Kilimanjaro Pay Services',
      slug: `kili-pay-${orgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
    });

    await dbStore.seedOrganizationDirect({
      id: otherOrgId,
      name: 'Serengeti Safari Ltd',
      slug: `serengeti-${otherOrgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
    });

    await grantDeveloperPlan(orgId);
    const fullKeyRes = await apiKeyService.createApiKey(orgId, {
      organizationId: orgId,
      name: 'STK Live Checkout Key',
      scopes: [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_READ, ApiKeyScope.INVOICES_WRITE],
    });
    validApiKey = fullKeyRes.plainTextSecret;

    await grantDeveloperPlan(orgId);
    const restKeyRes = await apiKeyService.createApiKey(orgId, {
      organizationId: orgId,
      name: 'SMS Only Key',
      scopes: [ApiKeyScope.SMS_SEND],
    });
    restrictedApiKey = restKeyRes.plainTextSecret;
  });

  describe('1. Carrier Prefix Routing & Initiation', () => {
    it('fails closed by default when no live carrier dispatch adapter is configured', async () => {
      for (const phoneNumber of ['0754 123 456', '+255 713-000-111', '0784 999 888', '0622 111 222']) {
        const res = await makeRequest(
          'POST',
          '/v1/payments/stk-push',
          {
            Authorization: `Bearer ${validApiKey}`,
            'Content-Type': 'application/json',
          },
          { phoneNumber, amount: 15000, memo: 'Default fail-closed check' },
        );
        assert.equal(res.statusCode, 503);
        assert.equal(res.json?.success, false);
        assert.equal(res.json?.error?.code, 'PROVIDER_DISPATCH_DISABLED');
      }

      const ttclRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        { phoneNumber: '0732 111 222', amount: 15000 },
      );
      assert.equal(ttclRes.statusCode, 422);
      assert.equal(ttclRes.json?.error?.code, 'UNSUPPORTED_STK_PROVIDER');
    });

    it('initiates Vodacom M-Pesa STK Push for 075x / 076x / 074x under test harness', async () => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MPESA));
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 123 456',
          amount: 25000,
          memo: 'Order #4401',
        },
      );

      assert.equal(res.statusCode, 201);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.data?.provider, PaymentProvider.MPESA);
      assert.equal(res.json?.data?.phoneNumber, '255754123456');
      assert.equal(res.json?.data?.amountCents, '2500000');
      assert.equal(res.json?.data?.status, StkPushStatus.PENDING);
      assert.ok(res.json?.data?.checkoutId.startsWith('stk_'));
      assert.ok(res.json?.data?.customerPrompt.includes('MPESA'));
    });

    it('initiates Tigo Pesa (Mixx by Yas) STK Push for 071x / 065x / 067x under test harness', async () => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MIXX));
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '+255 713-000-111',
          amount: 15000,
        },
      );

      assert.equal(res.statusCode, 201);
      assert.equal(res.json?.data?.provider, PaymentProvider.MIXX);
      assert.equal(res.json?.data?.phoneNumber, '255713000111');
      assert.equal(res.json?.data?.amountCents, '1500000');
      assert.ok(res.json?.data?.customerPrompt.includes('MIXX'));
    });

    it('initiates Airtel Money STK Push for 078x / 068x / 069x under test harness', async () => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.AIRTEL_MONEY));
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0784 999 888',
          amount: 50000,
        },
      );

      assert.equal(res.statusCode, 201);
      assert.equal(res.json?.data?.provider, PaymentProvider.AIRTEL_MONEY);
      assert.equal(res.json?.data?.phoneNumber, '255784999888');
      assert.equal(res.json?.data?.amountCents, '5000000');
      assert.ok(res.json?.data?.customerPrompt.includes('AIRTEL_MONEY'));
    });

    it('initiates HaloPesa STK Push for 062x / 061x under test harness', async () => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.HALOPESA));
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0622 111 222',
          amount: 10000,
        },
      );

      assert.equal(res.statusCode, 201);
      assert.equal(res.json?.data?.provider, PaymentProvider.HALOPESA);
      assert.equal(res.json?.data?.phoneNumber, '255622111222');
      assert.equal(res.json?.data?.amountCents, '1000000');
    });

    it('rejects invalid or foreign phone numbers safely', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0123456789',
          amount: 5000,
        },
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.json?.success, false);
      assert.ok(res.json?.error?.message.includes('Invalid Tanzanian mobile phone number'));
    });
  });

  describe('2. Scoped API Key Authorization & Status Polling', () => {
    it('blocks API keys lacking payment:stk or payments:write scope', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${restrictedApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 123 456',
          amount: 10000,
        },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'INSUFFICIENT_SCOPE');
    });

    it('blocks forged or non-existent API keys', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: 'Bearer bsk_live_00000000000000000000000000000000',
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 123 456',
          amount: 10000,
        },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.error?.code, 'INVALID_API_KEY');
    });

    it('polls transaction status via GET /v1/payments/stk-push/:checkoutId', async () => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MPESA));
      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 123 456',
          amount: 30000,
          memo: 'Invoice INV-9901',
        },
      );

      const checkoutId = initRes.json?.data?.checkoutId;
      assert.ok(checkoutId);

      const statusRes = await makeRequest(
        'GET',
        `/v1/payments/stk-push/${checkoutId}`,
        {
          Authorization: `Bearer ${validApiKey}`,
        },
      );

      assert.equal(statusRes.statusCode, 200);
      assert.equal(statusRes.json?.data?.checkoutId, checkoutId);
      assert.equal(statusRes.json?.data?.status, StkPushStatus.PENDING);
      assert.equal(statusRes.json?.data?.amountCents, '3000000');
    });
  });

  describe('3. P0 Trust Boundary & Settlement Authorization Suite', () => {
    beforeEach(() => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MPESA));
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MIXX));
    });

    it('1. Unauthenticated callback cannot settle an invoice (fails with HTTP 403 or 401)', async () => {
      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-UNAUTH-1',
        totalAmountCents: 5000000n, // 50,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 50000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Attempt callback without any authentication headers
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        { 'Content-Type': 'application/json' },
        {
          Body: {
            stkCallback: {
              CheckoutRequestID: checkoutId,
              ResultCode: 0,
              ResultDesc: 'Success',
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: 50000 },
                  { Name: 'Currency', Value: 'TZS' },
                  { Name: 'MpesaReceiptNumber', Value: 'UNAUTH999' },
                  { Name: 'PhoneNumber', Value: 255754000111 },
                ],
              },
            },
          },
        },
      );

      // Must be rejected by trust boundary guard
      assert.ok([401, 403].includes(callbackRes.statusCode));

      // Verify invoice balance and status are completely UNTOUCHED
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
      assert.equal(invAfter?.balanceCents, 5000000n);
      assert.equal(invAfter?.paidAmountCents, 0n);
    });

    it('2. Disabled provider verifier rejects callbacks (HTTP 403 PROVIDER_CALLBACK_DISABLED)', async () => {
      // By default, all providers are registered with DisabledProviderCallbackVerifier
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        { 'Content-Type': 'application/json' },
        { checkoutId: 'stk_dummy_123', success: true },
      );

      assert.equal(callbackRes.statusCode, 403);
      assert.equal(callbackRes.json?.error?.code, 'PROVIDER_CALLBACK_DISABLED');
      assert.ok(callbackRes.json?.error?.message.includes('disabled by default'));
    });

    it('3. Invalid provider signature cannot settle an invoice (fails with HTTP 401 INVALID_SIGNATURE)', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-FORGE-1',
        totalAmountCents: 3000000n, // 30,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 30000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 30000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'FORGE1234' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      // Create signature with WRONG secret
      const forgedHeaders = createSignedCallbackHeaders(payload, undefined, 'attacker_forged_secret');

      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        forgedHeaders,
        payload,
      );

      assert.equal(callbackRes.statusCode, 401);
      assert.equal(callbackRes.json?.error?.code, 'INVALID_SIGNATURE');

      // Verify invoice was NOT settled
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
      assert.equal(invAfter?.balanceCents, 3000000n);
    });

    it('4. Valid test verifier permits only the correctly correlated transaction and settles invoice', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-PAY-505',
        totalAmountCents: 5000000n, // 50,000 TZS
        customerPhone: '+255754000111',
        customerName: 'Amina Selemani',
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 50000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'The service request is processed successfully.',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 50000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'QA88HH99II' },
                { Name: 'TransactionDate', Value: 20261110120000 },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const validHeaders = createSignedCallbackHeaders(payload);
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        validHeaders,
        payload,
      );

      assert.equal(callbackRes.statusCode, 200);
      assert.equal(callbackRes.json?.data?.status, StkPushStatus.SUCCESS);
      assert.equal(callbackRes.json?.data?.providerReference, 'QA88HH99II');

      // Verify invoice is settled in PostgreSQL
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.PAID);
      assert.equal(invAfter?.balanceCents, 0n);
      assert.equal(invAfter?.paidAmountCents, 5000000n);

      // Verify STK transaction updated
      const statusRes = await makeRequest('GET', `/v1/payments/stk-push/${checkoutId}`, {
        Authorization: `Bearer ${validApiKey}`,
      });
      assert.equal(statusRes.json?.data?.status, StkPushStatus.SUCCESS);
      assert.ok(statusRes.json?.data?.settledPaymentId);
    });

    it('5. Amount mismatch cannot settle (fails with HTTP 422 AMOUNT_MISMATCH)', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-AMOUNT-1',
        totalAmountCents: 5000000n, // 50,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 50000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Attacker or telco reports 1,000 TZS instead of 50,000 TZS
      const mismatchPayload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 1000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'UNDERPAY1' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const signedHeaders = createSignedCallbackHeaders(mismatchPayload);
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        signedHeaders,
        mismatchPayload,
      );

      assert.equal(callbackRes.statusCode, 422);
      assert.equal(callbackRes.json?.error?.code, 'AMOUNT_MISMATCH');

      // Verify invoice balance is completely UNCHANGED
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
      assert.equal(invAfter?.balanceCents, 5000000n);
    });

    it('6. Currency mismatch cannot settle (fails with HTTP 422 CURRENCY_MISMATCH)', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MIXX, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CURR-1',
        totalAmountCents: 2000000n,
        currency: 'TZS',
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0713 000 111', amount: 20000, invoiceId: invoice.id, currency: 'TZS' },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const currencyPayload = {
        checkoutId,
        success: true,
        amountCents: 2000000,
        currency: 'USD', // Mismatched currency
        providerReference: 'TIGO_USD_1',
      };

      const signedHeaders = createSignedCallbackHeaders(currencyPayload);
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mixx',
        signedHeaders,
        currencyPayload,
      );

      assert.equal(callbackRes.statusCode, 422);
      assert.equal(callbackRes.json?.error?.code, 'CURRENCY_MISMATCH');

      // Verify invoice remains unpaid
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
    });

    it('7. Cross-organization callback cannot settle another organization invoice', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      // Invoice in Org A
      const invOrgA = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-ORGA-1',
        totalAmountCents: 1000000n,
      });

      // Invoice in Org B
      const invOrgB = await reconciliationService.createInvoice(otherOrgId, {
        referenceNumber: 'INV-ORGB-1',
        totalAmountCents: 1000000n,
      });

      // STK push initiated in Org A
      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 10000, invoiceId: invOrgA.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Callback executes
      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 10000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'XORG_REF_1' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const signedHeaders = createSignedCallbackHeaders(payload);
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        signedHeaders,
        payload,
      );

      assert.equal(callbackRes.statusCode, 200);

      // Verify Org A invoice is settled
      const invAfterA = await reconciliationService.findInvoiceById(orgId, invOrgA.id);
      assert.equal(invAfterA?.status, InvoiceStatus.PAID);

      // Verify Org B invoice is completely UNTOUCHED
      const invAfterB = await reconciliationService.findInvoiceById(otherOrgId, invOrgB.id);
      assert.equal(invAfterB?.status, InvoiceStatus.UNPAID);
      assert.equal(invAfterB?.balanceCents, 1000000n);
    });

    it('8. Duplicate callbacks cannot double-settle (idempotent second call)', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-IDEM-1',
        totalAmountCents: 4000000n, // 40,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 40000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 40000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'IDEM_RECEIPT_1' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      // 1. First callback arrives
      const nowSec = Math.floor(Date.now() / 1000);
      const headers1 = createSignedCallbackHeaders(payload, nowSec);
      const res1 = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', headers1, payload);
      assert.equal(res1.statusCode, 200);

      const invAfterFirst = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfterFirst?.status, InvoiceStatus.PAID);
      assert.equal(invAfterFirst?.balanceCents, 0n);
      assert.equal(invAfterFirst?.paidAmountCents, 4000000n);

      // 2. Carrier retries delivery (new timestamp & signature)
      const headers2 = createSignedCallbackHeaders(payload, nowSec + 1);
      const res2 = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', headers2, payload);
      assert.equal(res2.statusCode, 200);

      // Verify invoice was NOT double-credited
      const invAfterSecond = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfterSecond?.status, InvoiceStatus.PAID);
      assert.equal(invAfterSecond?.balanceCents, 0n);
      assert.equal(invAfterSecond?.paidAmountCents, 4000000n);
    });

    it('9. Concurrent callbacks produce exactly one settlement', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-RACE-1',
        totalAmountCents: 6000000n, // 60,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 60000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 60000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'RACE_REF_99' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      // Race two concurrent requests
      const nowSec = Math.floor(Date.now() / 1000);
      const headersA = createSignedCallbackHeaders(payload, nowSec);
      const headersB = createSignedCallbackHeaders(payload, nowSec + 1);

      const [resA, resB] = await Promise.all([
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', headersA, payload),
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', headersB, payload),
      ]);

      assert.equal(resA.statusCode, 200);
      assert.equal(resB.statusCode, 200);

      // Exactly one settlement committed
      const invFinal = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invFinal?.status, InvoiceStatus.PAID);
      assert.equal(invFinal?.paidAmountCents, 6000000n);
      assert.equal(invFinal?.balanceCents, 0n);

      // Verify only ONE normalized payment exists for this reference
      const payments = await sql`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${orgId} AND "reference" = 'RACE_REF_99'
      `;
      assert.equal(payments.length, 1);
    });

    it('10. Database rollback leaves no partial settlement', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-ROLLBACK-1',
        totalAmountCents: 1500000n,
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 15000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Transition target invoice to VOID to force verifyPayment to fail & trigger atomic rollback
      await sql`
        UPDATE "invoices"
        SET "status" = 'VOID'::"InvoiceStatus"
        WHERE "id" = ${invoice.id}
      `;

      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 15000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'ROLLBACK_REF' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const signedHeaders = createSignedCallbackHeaders(payload);
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        signedHeaders,
        payload,
      );

      // Callback must fail due to non-payable invoice state error
      assert.equal(callbackRes.statusCode, 422);

      // Verify invoice balance was NOT touched
      const invCheck = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invCheck?.status, InvoiceStatus.VOID);
      assert.equal(invCheck?.paidAmountCents, 0n);

      // Verify transaction status remained PENDING due to atomic rollback
      const stkCheck = await stkPushService.getStkTransactionStatus(orgId, checkoutId);
      assert.equal(stkCheck.status, StkPushStatus.PENDING);

      // Verify no orphan raw evidence or normalized payments were left committed
      const orphans = await sql`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${orgId} AND "reference" = 'ROLLBACK_REF'
      `;
      assert.equal(orphans.length, 0);
    });

    it('11. Provider evidence remains distinct from companion notification evidence', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-PROV-EVID',
        totalAmountCents: 7500000n, // 75,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 75000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 75000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'DISTINCT_EVID_1' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const signedHeaders = createSignedCallbackHeaders(payload);
      await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', signedHeaders, payload);

      // Inspect RawPaymentEvidence in PostgreSQL
      const evidenceRows = await sql<Record<string, any>>`
        SELECT * FROM "raw_payment_evidence"
        WHERE "organization_id" = ${orgId}
        ORDER BY "received_at" DESC
        LIMIT 1
      `;
      assert.equal(evidenceRows.length, 1);
      const ev = evidenceRows[0]!;

      // Invariants: Provenance is DIRECT_PROVIDER_API, NOT an Android notification
      assert.equal(ev.source_type, EvidenceSourceType.DIRECT_PROVIDER_API);
      assert.equal(ev.sender_address, 'PROVIDER_API_MPESA');

      // Invariant: Raw payload is the authentic carrier JSON, NOT a fabricated Swahili SMS
      assert.ok(ev.raw_payload.includes('stkCallback'));
      assert.ok(ev.raw_payload.includes('DISTINCT_EVID_1'));
      assert.ok(!ev.raw_payload.includes('Imethibitishwa')); // Never synthesized!
    });

    it('12. Later companion evidence cannot duplicate a provider-confirmed settlement', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CLAIM-BOX-1',
        totalAmountCents: 4000000n, // 40,000 TZS
        customerPhone: '+255754999000',
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 999 000', amount: 40000, invoiceId: invoice.id, referenceNumber: invoice.referenceNumber },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // 1. Direct provider callback arrives and settles invoice
      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 40000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'QZ99AA11BB' },
                { Name: 'PhoneNumber', Value: 255754999000 },
              ],
            },
          },
        },
      };

      const signedHeaders = createSignedCallbackHeaders(payload);
      const cbRes = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', signedHeaders, payload);
      assert.equal(cbRes.statusCode, 200);

      const invSettled = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invSettled?.status, InvoiceStatus.PAID);
      assert.equal(invSettled?.balanceCents, 0n);

      // 2. Companion Android Phone receives carrier SMS receipt 30 seconds later and forwards it
      const smsPayload = 'QZ99AA11BB Imethibitishwa. Umepokea Tsh40,000 kutoka kwa 255754999000 tarehe 10/11/2026 saa 15:00. Kumbukumbu namba: INV-CLAIM-BOX-1';

      const duplicateAck = await ingestionService.ingestEvidence({
        organizationId: orgId,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        senderAddress: 'M-PESA',
        rawPayload: smsPayload,
        deviceTimestamp: new Date(),
      });

      // Assert that duplicate detection caught the duplicate provider reference and rejected it
      assert.equal(duplicateAck.status, 'DUPLICATE');

      // Verify invoice was NOT double-settled
      const invFinal = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invFinal?.status, InvoiceStatus.PAID);
      assert.equal(invFinal?.paidAmountCents, 4000000n);
    });

    it('safely handles user prompt cancellation without settling invoice', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CANCEL-101',
        totalAmountCents: 2000000n, // 20,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 123 456', amount: 20000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Customer cancels prompt on their phone (Daraja ResultCode 1032)
      const cancelPayload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 1032,
            ResultDesc: 'Request cancelled by user',
          },
        },
      };

      const signedHeaders = createSignedCallbackHeaders(cancelPayload);
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        signedHeaders,
        cancelPayload,
      );

      assert.equal(callbackRes.statusCode, 200);
      assert.equal(callbackRes.json?.data?.status, StkPushStatus.CANCELLED);

      // Verify invoice remains UNPAID
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
      assert.equal(invAfter?.balanceCents, 2000000n);
      assert.equal(invAfter?.paidAmountCents, 0n);
    });
  });

  describe('4. P0.1 Provider Reference Uniqueness & Callback Integrity Suite', () => {
    beforeEach(() => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MPESA));
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MIXX));
    });

    it('P0.1-1: Two different checkout IDs concurrently presenting the same provider reference', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const inv1 = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CONCURR-1',
        totalAmountCents: 1000000n, // 10,000 TZS
      });
      const inv2 = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CONCURR-2',
        totalAmountCents: 1000000n, // 10,000 TZS
      });

      const init1 = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 10000, invoiceId: inv1.id },
      );
      const init2 = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 222', amount: 10000, invoiceId: inv2.id },
      );

      const checkoutId1 = init1.json?.data?.checkoutId;
      const checkoutId2 = init2.json?.data?.checkoutId;

      const sharedRef = 'COLLIDE_REF_001';
      const payload1 = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId1,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 10000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: sharedRef },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const payload2 = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId2,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 10000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: sharedRef },
                { Name: 'PhoneNumber', Value: 255754000222 },
              ],
            },
          },
        },
      };

      const nowSec = Math.floor(Date.now() / 1000);
      const headers1 = createSignedCallbackHeaders(payload1, nowSec);
      const headers2 = createSignedCallbackHeaders(payload2, nowSec + 1);

      // Execute concurrently
      const [res1, res2] = await Promise.all([
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', headers1, payload1),
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', headers2, payload2),
      ]);

      const statuses = [res1.statusCode, res2.statusCode].sort();
      assert.deepEqual(statuses, [200, 409]);

      // Exactly ONE invoice must be settled
      const checkInv1 = await reconciliationService.findInvoiceById(orgId, inv1.id);
      const checkInv2 = await reconciliationService.findInvoiceById(orgId, inv2.id);
      const paidInvoices = [checkInv1?.status, checkInv2?.status].filter((s) => s === InvoiceStatus.PAID);
      assert.equal(paidInvoices.length, 1);

      // Exactly ONE claim in payment_reference_claims
      const claims = await sql`
        SELECT * FROM "payment_reference_claims"
        WHERE "provider" = 'MPESA'::"PaymentProvider" AND "provider_reference" = ${sharedRef}
      `;
      assert.equal(claims.length, 1);

      // Exactly ONE normalized payment
      const payments = await sql`
        SELECT * FROM "normalized_payments"
        WHERE "provider" = 'MPESA'::"PaymentProvider" AND "reference" = ${sharedRef}
      `;
      assert.equal(payments.length, 1);
    });

    it('P0.1-2: The same provider reference cannot be claimed by two different organizations', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invA = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-ORGA-CLAIM',
        totalAmountCents: 2000000n, // 20,000 TZS
      });
      const invB = await reconciliationService.createInvoice(otherOrgId, {
        referenceNumber: 'INV-ORGB-CLAIM',
        totalAmountCents: 2000000n, // 20,000 TZS
      });

      await grantDeveloperPlan(otherOrgId);
      const keyResB = await apiKeyService.createApiKey(otherOrgId, {
        organizationId: otherOrgId,
        name: 'Org B Key',
        scopes: [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_READ, ApiKeyScope.INVOICES_WRITE],
      });

      const initA = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 20000, invoiceId: invA.id },
      );
      const initB = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${keyResB.plainTextSecret}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 222', amount: 20000, invoiceId: invB.id },
      );

      const checkoutA = initA.json?.data?.checkoutId;
      const checkoutB = initB.json?.data?.checkoutId;
      const crossRef = 'CROSS_ORG_REF_999';

      // Org A claims reference first
      const payloadA = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutA,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 20000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: crossRef },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const resA = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(payloadA), payloadA);
      assert.equal(resA.statusCode, 200);

      // Org B attempts to claim the same reference
      const payloadB = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutB,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 20000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: crossRef },
                { Name: 'PhoneNumber', Value: 255754000222 },
              ],
            },
          },
        },
      };

      const resB = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(payloadB), payloadB);
      assert.equal(resB.statusCode, 409);
      assert.equal(resB.json?.error?.code, 'REFERENCE_ALREADY_SETTLED');

      // Org B invoice remains UNPAID
      const checkInvB = await reconciliationService.findInvoiceById(otherOrgId, invB.id);
      assert.equal(checkInvB?.status, InvoiceStatus.UNPAID);
      assert.equal(checkInvB?.paidAmountCents, 0n);

      // Org B checkout remains PENDING
      const checkStkB = await stkPushService.getStkTransactionStatus(otherOrgId, checkoutB);
      assert.equal(checkStkB.status, StkPushStatus.PENDING);
    });

    it('P0.1-3: Same-org provisional SMS upgrades cleanly on STK confirmation and already-settled SMS invoices block duplicate STK reuse', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const smsRef = 'QC77BB88AA';
      const settledInvoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-SMS-SETTLED',
        totalAmountCents: 2500000n,
      });
      // 1. Ingest SMS notification first and manually verify/settle it against INV-SMS-SETTLED
      const smsAck = await ingestionService.ingestEvidence({
        organizationId: orgId,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        senderAddress: 'M-PESA',
        rawPayload: `${smsRef} Imethibitishwa. Umepokea Tsh25,000.00 kutoka kwa JOHN DOE 255754111222 tarehe 11/11/2026 saa 10:00 AM. Kumbukumbu namba: INV-SMS-SETTLED. Salio lako jipya la M-Pesa ni Tsh100,000.00.`,
        deviceTimestamp: new Date(),
      });
      await reconciliationService.verifyPayment(orgId, {
        paymentId: smsAck.paymentId!,
        invoiceId: settledInvoice.id,
        verificationMethod: 'MANUAL_FINANCE_APPROVAL' as any,
        externalVerificationRef: 'M-PESA-STMT-001',
        notes: 'Manually verified against merchant till statement',
      });

      // 2. Second invoice initiates STK Push
      const secondInvoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-SMS-DUP',
        totalAmountCents: 2500000n,
      });
      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 111 222', amount: 25000, invoiceId: secondInvoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // 3. Callback arrives reusing the same receipt number for a DIFFERENT invoice
      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 25000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: smsRef },
                { Name: 'PhoneNumber', Value: 255754111222 },
              ],
            },
          },
        },
      };

      const res = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(payload), payload);
      assert.equal(res.statusCode, 409);
      assert.equal(res.json?.error?.code, 'REFERENCE_ALREADY_USED');

      // Second invoice remains unpaid
      const invCheck = await reconciliationService.findInvoiceById(orgId, secondInvoice.id);
      assert.equal(invCheck?.status, InvoiceStatus.UNPAID);
    });

    it('P0.1-4: The same reference claimed concurrently across independent database transactions is serialized', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const inv1 = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-WORKER-1',
        totalAmountCents: 5000000n,
      });
      const inv2 = await reconciliationService.createInvoice(otherOrgId, {
        referenceNumber: 'INV-WORKER-2',
        totalAmountCents: 5000000n,
      });

      await grantDeveloperPlan(otherOrgId);
      const keyResB = await apiKeyService.createApiKey(otherOrgId, {
        organizationId: otherOrgId,
        name: 'Worker B Key',
        scopes: [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_READ, ApiKeyScope.INVOICES_WRITE],
      });

      const init1 = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 50000, invoiceId: inv1.id },
      );
      const init2 = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${keyResB.plainTextSecret}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 222', amount: 50000, invoiceId: inv2.id },
      );

      const workerRef = 'WORKER_RACE_77';
      const payload1 = {
        Body: {
          stkCallback: {
            CheckoutRequestID: init1.json?.data?.checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 50000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: workerRef },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const payload2 = {
        Body: {
          stkCallback: {
            CheckoutRequestID: init2.json?.data?.checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 50000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: workerRef },
                { Name: 'PhoneNumber', Value: 255754000222 },
              ],
            },
          },
        },
      };

      const nowSec = Math.floor(Date.now() / 1000);
      const [res1, res2] = await Promise.all([
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(payload1, nowSec), payload1),
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(payload2, nowSec + 1), payload2),
      ]);

      const codes = [res1.statusCode, res2.statusCode].sort();
      assert.deepEqual(codes, [200, 409]);

      // Exactly 1 claim in database
      const countClaims = await sql`
        SELECT COUNT(*)::int as count FROM "payment_reference_claims"
        WHERE "provider_reference" = ${workerRef}
      `;
      assert.equal(countClaims[0]!.count, 1);
    });

    it('P0.1-5: Rollback after a failed reference claim leaves no evidence, normalized payments, or settlements', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const existingRef = 'ALREADY_TAKEN_REF';
      // Seed an existing confirmed claim in payment_reference_claims
      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "checkout_id",
          "status", "evidence_tier", "claimed_at", "confirmed_at"
        )
        VALUES (
          gen_random_uuid(), 'MPESA'::"PaymentProvider", ${existingRef}, ${otherOrgId}, 'stk_prior',
          'CONFIRMED_PROVIDER'::"claim_status", 'AUTHORITATIVE_PROVIDER'::"claim_evidence_tier", NOW(), NOW()
        )
      `;

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-ROLLBACK-CLAIM',
        totalAmountCents: 3000000n,
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 30000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 30000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: existingRef },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const res = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(payload), payload);
      assert.equal(res.statusCode, 409);

      // Verify transaction rolled back completely
      const stkCheck = await stkPushService.getStkTransactionStatus(orgId, checkoutId);
      assert.equal(stkCheck.status, StkPushStatus.PENDING);

      // No normalized payment created in orgId
      const payCheck = await sql`
        SELECT * FROM "normalized_payments" WHERE "organization_id" = ${orgId}
      `;
      assert.equal(payCheck.length, 0);

      // No raw evidence created in orgId
      const evCheck = await sql`
        SELECT * FROM "raw_payment_evidence" WHERE "organization_id" = ${orgId}
      `;
      assert.equal(evCheck.length, 0);

      // Invoice untouched
      const invCheck = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invCheck?.status, InvoiceStatus.UNPAID);
    });

    it('P0.1-6: An expired transaction receiving a late success callback remains EXPIRED and does not settle', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-EXPIRED-1',
        totalAmountCents: 1000000n,
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 10000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Mark transaction EXPIRED (e.g. by expiration background job)
      await sql`
        UPDATE "stk_push_transactions"
        SET "status" = 'EXPIRED'::"StkPushStatus"
        WHERE "id" = ${checkoutId}
      `;

      // Late success callback arrives
      const payload = {
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 10000 },
                { Name: 'Currency', Value: 'TZS' },
                { Name: 'MpesaReceiptNumber', Value: 'LATE_REF_01' },
                { Name: 'PhoneNumber', Value: 255754000111 },
              ],
            },
          },
        },
      };

      const res = await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(payload), payload);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.data?.status, StkPushStatus.EXPIRED);

      // Verify transaction remains EXPIRED
      const stkCheck = await stkPushService.getStkTransactionStatus(orgId, checkoutId);
      assert.equal(stkCheck.status, StkPushStatus.EXPIRED);

      // Invoice remains UNPAID
      const invCheck = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invCheck?.status, InvoiceStatus.UNPAID);
      assert.equal(invCheck?.paidAmountCents, 0n);

      // No claim created
      const claims = await sql`
        SELECT * FROM "payment_reference_claims" WHERE "provider_reference" = 'LATE_REF_01'
      `;
      assert.equal(claims.length, 0);
    });

    it('P0.1-7: Missing callback currency fails closed with 422 MISSING_CALLBACK_CURRENCY', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MIXX, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-NOCURR',
        totalAmountCents: 1500000n,
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0713 000 111', amount: 15000, invoiceId: invoice.id, currency: 'TZS' },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Omit currency completely
      const payload = {
        checkoutId,
        success: true,
        amountCents: 1500000,
        providerReference: 'TIGO_NOCURR_1',
      };

      const res = await makeRequest('POST', '/v1/payments/stk-push/callback/mixx', createSignedCallbackHeaders(payload), payload);
      assert.equal(res.statusCode, 422);
      assert.equal(res.json?.error?.code, 'MISSING_CALLBACK_CURRENCY');

      // Invoice remains unpaid
      const invCheck = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invCheck?.status, InvoiceStatus.UNPAID);
    });

    it('P0.1-8: Currency mismatch fails closed with 422 CURRENCY_MISMATCH', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MIXX, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CURR-MISMATCH',
        totalAmountCents: 2000000n,
        currency: 'TZS',
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0713 000 111', amount: 20000, invoiceId: invoice.id, currency: 'TZS' },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      const payload = {
        checkoutId,
        success: true,
        amountCents: 2000000,
        currency: 'EUR',
        providerReference: 'TIGO_EUR_1',
      };

      const res = await makeRequest('POST', '/v1/payments/stk-push/callback/mixx', createSignedCallbackHeaders(payload), payload);
      assert.equal(res.statusCode, 422);
      assert.equal(res.json?.error?.code, 'CURRENCY_MISMATCH');

      // Invoice remains unpaid
      const invCheck = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invCheck?.status, InvoiceStatus.UNPAID);
    });

    it('P0.1-9: Exact original request bytes survive HTTP ingress and evidence persistence without reserialization', async () => {
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, {
        secretKey: TEST_CALLBACK_SECRET,
      });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-RAW-BYTES',
        totalAmountCents: 3500000n,
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${validApiKey}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 000 111', amount: 35000, invoiceId: invoice.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Custom formatting with unique multi-spaces, trailing newline, and non-canonical property ordering
      const rawBodyString = `{\n  "extra_nonstandard_field":   "test_whitespace",\n  "Body": {\n    "stkCallback": {\n      "CheckoutRequestID": "${checkoutId}",\n      "ResultCode": 0,\n      "ResultDesc": "Success",\n      "CallbackMetadata": {\n        "Item": [\n          { "Name": "Amount", "Value": 35000 },\n          { "Name": "Currency", "Value": "TZS" },\n          { "Name": "MpesaReceiptNumber", "Value": "RAW_BYTES_REF" },\n          { "Name": "PhoneNumber", "Value": 255754000111 }\n        ]\n      }\n    }\n  }\n}\n`;

      const nowSec = Math.floor(Date.now() / 1000);
      const signingInput = `${nowSec}.${rawBodyString}`;
      const sig = createHmac('sha256', TEST_CALLBACK_SECRET).update(signingInput, 'utf8').digest('hex');

      const headers = {
        'content-type': 'application/json',
        'x-signature': sig,
        'x-timestamp': nowSec.toString(),
        'x-nonce': 'test_nonce_123',
      };

      // Custom makeRequest that pushes raw string directly
      const socket = new Socket();
      const req = new IncomingMessage(socket);
      req.method = 'POST';
      req.url = '/v1/payments/stk-push/callback/mpesa';
      req.headers = { ...headers, host: 'localhost:3000' };
      const res = new ServerResponse(req);
      let capturedBody = '';
      let statusCode = 200;
      res.writeHead = (c: number) => { statusCode = c; return res; };
      res.write = (c: any) => { if (c) capturedBody += c; return true; };
      res.end = (c?: any) => { if (c) capturedBody += c; return res; };
      req.push(rawBodyString);
      req.push(null);

      await router.handle(req, res);
      assert.equal(statusCode, 200);

      // Verify raw_payment_evidence stores the EXACT rawBodyString, NOT re-serialized JSON!
      const evRows = await sql<Record<string, any>>`
        SELECT * FROM "raw_payment_evidence"
        WHERE "organization_id" = ${orgId}
        ORDER BY "received_at" DESC
        LIMIT 1
      `;
      assert.equal(evRows.length, 1);
      assert.equal(evRows[0]!.raw_payload, rawBodyString);
      assert.equal(evRows[0]!.nonce, 'test_nonce_123');
    });

    it('P0.1-10: TestCallbackVerifier cannot be instantiated in production mode', () => {
      const prevEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        assert.throws(
          () => new TestCallbackVerifier(PaymentProvider.MPESA, { secretKey: 'foo' }),
          /SECURITY VIOLATION: TestCallbackVerifier cannot be instantiated in production environment/,
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('P0.1-11: Direct invocation of handleCarrierCallback enforces trust boundary at service layer', async () => {
      // 1. With default registry (all disabled), direct call fails with 403 PROVIDER_CALLBACK_DISABLED
      stkPushService.verifierRegistry.resetToDefaults();
      await assert.rejects(
        () => stkPushService.handleCarrierCallback(PaymentProvider.MPESA, { checkoutId: 'dummy' }),
        (err: any) => err instanceof HttpException && err.statusCode === 403 && err.code === 'PROVIDER_CALLBACK_DISABLED',
      );

      // 2. With test verifier registered, direct call without signature headers fails with 401 MISSING_SIGNATURE
      const testVerifier = new TestCallbackVerifier(PaymentProvider.MPESA, { secretKey: TEST_CALLBACK_SECRET });
      stkPushService.verifierRegistry.registerVerifier(testVerifier);

      await assert.rejects(
        () => stkPushService.handleCarrierCallback(PaymentProvider.MPESA, { checkoutId: 'dummy' }),
        (err: any) => err instanceof HttpException && err.statusCode === 401 && err.code === 'MISSING_SIGNATURE',
      );
    });
  });

  describe('P2-8: Explicit Provider Selection & MNP Ported-Number Routing Integrity', () => {
    it('routes an MNP-ported 0754 number explicitly to AIRTEL_MONEY instead of prefix-only MPESA', async () => {
      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.AIRTEL_MONEY));
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'mnp-explicit-001',
        },
        {
          phoneNumber: '0754 123 456', // Historical Vodacom prefix, ported to Airtel Money
          provider: PaymentProvider.AIRTEL_MONEY,
          amount: 20000,
          memo: 'Ported MNP checkout',
        },
      );

      assert.equal(res.statusCode, 201);
      assert.equal(res.json?.data?.provider, PaymentProvider.AIRTEL_MONEY);
      assert.equal(res.json?.data?.routingResolution, 'EXPLICIT');
      assert.ok(res.json?.data?.customerPrompt.includes('AIRTEL_MONEY'));

      // Reusing same idempotency key with a different provider fails closed with 409 conflict
      const conflictRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'mnp-explicit-001',
        },
        {
          phoneNumber: '0754 123 456',
          provider: PaymentProvider.MPESA,
          amount: 20000,
          memo: 'Ported MNP checkout',
        },
      );
      assert.equal(conflictRes.statusCode, 409);
    });

    it('rejects invalid explicit provider values fail-closed with 400 and marks omitted provider as PREFIX_HEURISTIC', async () => {
      const badProvider = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 123 456',
          provider: 'INVALID_MNO',
          amount: 10000,
        },
      );
      assert.equal(badProvider.statusCode, 400);

      stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MPESA));
      const heuristicRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 123 456',
          amount: 10000,
        },
      );
      assert.equal(heuristicRes.statusCode, 201);
      assert.equal(heuristicRes.json?.data?.provider, PaymentProvider.MPESA);
      assert.equal(heuristicRes.json?.data?.routingResolution, 'PREFIX_HEURISTIC');
    });
  });
});
