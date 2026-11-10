import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import {
  ApiKeyScope,
  EvidenceSourceType,
  InvoiceStatus,
  PaymentProvider,
  StkPushStatus,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';

describe('Carrier STK Push & Asynchronous Reconciliation Engine', () => {
  const router = createApp();
  const apiKeyService = new ApiKeyService();
  const reconciliationService = new ReconciliationService();
  const ingestionService = new IngestionService(reconciliationService);

  const orgId = randomUUID();
  let validApiKey: string;
  let restrictedApiKey: string;

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

    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Kilimanjaro Pay Services',
      slug: `kili-pay-${orgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
    });

    const fullKeyRes = await apiKeyService.createApiKey(orgId, {
      organizationId: orgId,
      name: 'STK Live Checkout Key',
      scopes: [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_READ, ApiKeyScope.INVOICES_WRITE],
    });
    validApiKey = fullKeyRes.plainTextSecret;

    const restKeyRes = await apiKeyService.createApiKey(orgId, {
      organizationId: orgId,
      name: 'SMS Only Key',
      scopes: [ApiKeyScope.SMS_SEND],
    });
    restrictedApiKey = restKeyRes.plainTextSecret;
  });

  describe('1. Carrier Prefix Routing & Initiation', () => {
    it('initiates Vodacom M-Pesa STK Push for 075x / 076x / 074x', async () => {
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
      assert.ok(res.json?.data?.customerPrompt.includes('M-Pesa'));
    });

    it('initiates Tigo Pesa (Mixx by Yas) STK Push for 071x / 065x / 067x', async () => {
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
      assert.ok(res.json?.data?.customerPrompt.includes('Mixx'));
    });

    it('initiates Airtel Money STK Push for 078x / 068x / 069x', async () => {
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
      assert.ok(res.json?.data?.customerPrompt.includes('Airtel Money'));
    });

    it('initiates HaloPesa STK Push for 062x / 061x', async () => {
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

  describe('3. Asynchronous Telco Callback & Zero-Guesswork Reconciliation', () => {
    it('settles open invoice atomically with row-level locks on M-Pesa callback', async () => {
      // 1. Create open invoice
      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-PAY-505',
        totalAmountCents: 5000000n, // 50,000 TZS
        customerPhone: '+255754000111',
        customerName: 'Amina Selemani',
      });

      assert.equal(invoice.status, InvoiceStatus.UNPAID);
      assert.equal(invoice.balanceCents, 5000000n);

      // 2. Dispatch STK push locked to invoice
      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 000 111',
          amount: 50000,
          invoiceId: invoice.id,
          referenceNumber: invoice.referenceNumber,
        },
      );

      const checkoutId = initRes.json?.data?.checkoutId;
      assert.ok(checkoutId);

      // Verify invoice remains UNPAID before customer enters PIN
      const invBefore = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invBefore?.status, InvoiceStatus.UNPAID);

      // 3. Telco delivers asynchronous M-Pesa Daraja callback
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        {
          'Content-Type': 'application/json',
        },
        {
          Body: {
            stkCallback: {
              MerchantRequestID: '29115-34620561-1',
              CheckoutRequestID: checkoutId,
              ResultCode: 0,
              ResultDesc: 'The service request is processed successfully.',
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: 50000 },
                  { Name: 'MpesaReceiptNumber', Value: 'QA88HH99II' },
                  { Name: 'TransactionDate', Value: 20261110120000 },
                  { Name: 'PhoneNumber', Value: 255754000111 },
                ],
              },
            },
          },
        },
      );

      assert.equal(callbackRes.statusCode, 200);
      assert.equal(callbackRes.json?.data?.status, StkPushStatus.SUCCESS);
      assert.equal(callbackRes.json?.data?.providerReference, 'QA88HH99II');

      // 4. Verify invoice is fully settled in PostgreSQL
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.PAID);
      assert.equal(invAfter?.balanceCents, 0n);
      assert.equal(invAfter?.paidAmountCents, 5000000n);

      // 5. Verify STK transaction updated with settlement linkage
      const statusRes = await makeRequest(
        'GET',
        `/v1/payments/stk-push/${checkoutId}`,
        {
          Authorization: `Bearer ${validApiKey}`,
        },
      );
      assert.equal(statusRes.json?.data?.status, StkPushStatus.SUCCESS);
      assert.equal(statusRes.json?.data?.providerReference, 'QA88HH99II');
      assert.ok(statusRes.json?.data?.settledPaymentId);
    });

    it('safely handles user prompt cancellation without settling invoice', async () => {
      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CANCEL-101',
        totalAmountCents: 2000000n, // 20,000 TZS
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 123 456',
          amount: 20000,
          invoiceId: invoice.id,
        },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // Customer cancels prompt on their phone (Daraja ResultCode 1032)
      const callbackRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        {
          'Content-Type': 'application/json',
        },
        {
          Body: {
            stkCallback: {
              CheckoutRequestID: checkoutId,
              ResultCode: 1032,
              ResultDesc: 'Request cancelled by user',
            },
          },
        },
      );

      assert.equal(callbackRes.statusCode, 200);
      assert.equal(callbackRes.json?.data?.status, StkPushStatus.CANCELLED);

      // Invoice MUST remain UNPAID
      const invAfter = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
      assert.equal(invAfter?.balanceCents, 2000000n);
    });

    it('rejects duplicate SMS ingestion when companion phone receives receipt after STK settlement', async () => {
      // 1. Create open invoice & execute STK push
      const invoice = await reconciliationService.createInvoice(orgId, {
        referenceNumber: 'INV-CLAIM-BOX-1',
        totalAmountCents: 4000000n, // 40,000 TZS
        customerPhone: '+255754999000',
      });

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        {
          Authorization: `Bearer ${validApiKey}`,
          'Content-Type': 'application/json',
        },
        {
          phoneNumber: '0754 999 000',
          amount: 40000,
          invoiceId: invoice.id,
          referenceNumber: invoice.referenceNumber,
        },
      );
      const checkoutId = initRes.json?.data?.checkoutId;

      // 2. STK callback arrives first and settles invoice
      await makeRequest(
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
                  { Name: 'Amount', Value: 40000 },
                  { Name: 'MpesaReceiptNumber', Value: 'QZ99AA11BB' },
                  { Name: 'PhoneNumber', Value: 255754999000 },
                ],
              },
            },
          },
        },
      );

      const invSettled = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invSettled?.status, InvoiceStatus.PAID);
      assert.equal(invSettled?.balanceCents, 0n);

      // 3. Companion Android Phone receives SMS receipt 30 seconds later and forwards it
      const smsPayload = 'QZ99AA11BB Imethibitishwa. Umepokea Tsh40,000 kutoka kwa 255754999000 tarehe 10/11/2026 saa 15:00. Kumbukumbu namba: INV-CLAIM-BOX-1';

      const duplicateAck = await ingestionService.ingestEvidence({
        organizationId: orgId,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        senderAddress: 'M-PESA',
        rawPayload: smsPayload,
        deviceTimestamp: new Date(),
      });

      // Assert that duplicate detection caught the duplicate hash and rejected it safely
      assert.equal(duplicateAck.status, 'DUPLICATE');

      // Verify invoice was NOT double-settled
      const invFinal = await reconciliationService.findInvoiceById(orgId, invoice.id);
      assert.equal(invFinal?.status, InvoiceStatus.PAID);
      assert.equal(invFinal?.paidAmountCents, 4000000n);
    });
  });
});
