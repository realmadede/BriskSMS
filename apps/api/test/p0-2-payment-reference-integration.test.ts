import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  ApiKeyScope,
  ClaimEventAction,
  ClaimEvidenceTier,
  ClaimStatus,
  DeviceIngestionMode,
  DeviceStatus,
  EvidenceSourceType,
  InvoiceStatus,
  PaymentProvider,
  PaymentVerificationState,
  StkPushStatus,
  TransactionState,
  UserRole,
  VerificationMethod,
} from '@brisksms/shared';
import { sql } from '@brisksms/db';
import { createApp } from '../src/app.js';
import { HttpException } from '../src/core/http.js';
import { hashToken } from '../src/core/crypto.js';
import { dbStore } from '../src/core/store.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { DeviceService } from '../src/modules/device/device.service.js';
import { buildPairingChallengeTranscript } from '../src/modules/device/device-crypto.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { PaymentReferenceClaimService } from '../src/modules/reconciliation/payment-reference-claim.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import {
  DisabledProviderCallbackVerifier,
  StkPushService,
  TestCallbackVerifier,
  TestStkAdapter,
} from '../src/modules/stk-push/index.js';
import { stkPushService } from '../src/modules/stk-push/stk-push.service.js';
import { grantDeveloperPlan } from './helpers/developer-plan.js';

describe('P0.2 Integrated Payment-Reference Claim Boundary (Companion, Manual, STK)', () => {
  const router = createApp();
  const authService = new AuthService();
  const apiKeyService = new ApiKeyService();
  const deviceService = new DeviceService();
  const claimService = new PaymentReferenceClaimService();
  const reconciliationService = new ReconciliationService(claimService);
  const ingestionService = new IngestionService(reconciliationService, claimService);

  const TEST_CALLBACK_SECRET = 'p02_integration_test_callback_secret_987654';

  const orgA = randomUUID();
  const orgB = randomUUID();
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  let apiKeyA: string;
  let apiKeyB: string;

  function createSignedCallbackHeaders(body: unknown, timestampOverride?: number): Record<string, string> {
    const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    const signature = createHmac('sha256', TEST_CALLBACK_SECRET)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');

    return {
      'Content-Type': 'application/json',
      'X-Signature': signature,
      'X-Timestamp': String(timestamp),
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
    const lowerHeaders: Record<string, string> = { host: 'localhost:3000' };
    for (const [k, v] of Object.entries(headers)) {
      lowerHeaders[k.toLowerCase()] = v;
    }
    req.headers = lowerHeaders;

    const res = new ServerResponse(req);
    let capturedBody = '';
    let statusCode = 200;

    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.write = (chunk: any) => {
      if (chunk) capturedBody += chunk.toString();
      return true;
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
    let parsed: any = null;
    try {
      parsed = capturedBody ? JSON.parse(capturedBody) : null;
    } catch {
      parsed = capturedBody;
    }
    return { statusCode, json: parsed };
  }

  function buildMpesaCallbackPayload(params: {
    checkoutId: string;
    receiptNumber: string;
    amount: number;
    currency?: string;
    phone?: string;
    resultCode?: number;
    resultDesc?: string;
  }) {
    if ((params.resultCode ?? 0) !== 0) {
      return {
        Body: {
          stkCallback: {
            CheckoutRequestID: params.checkoutId,
            ResultCode: params.resultCode,
            ResultDesc: params.resultDesc ?? 'Request cancelled by user',
          },
        },
      };
    }

    const items: Array<{ Name: string; Value: unknown }> = [
      { Name: 'Amount', Value: params.amount },
      { Name: 'MpesaReceiptNumber', Value: params.receiptNumber },
      { Name: 'PhoneNumber', Value: Number(params.phone ?? '255754000111') },
    ];
    if (params.currency !== undefined) {
      items.push({ Name: 'Currency', Value: params.currency });
    } else {
      items.push({ Name: 'Currency', Value: 'TZS' });
    }

    return {
      Body: {
        stkCallback: {
          CheckoutRequestID: params.checkoutId,
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: { Item: items },
        },
      },
    };
  }

  function registerTestMpesaVerifier(): void {
    stkPushService.adapterRegistry.registerAdapter(new TestStkAdapter(PaymentProvider.MPESA));
    stkPushService.verifierRegistry.registerVerifier(
      new TestCallbackVerifier(PaymentProvider.MPESA, { secretKey: TEST_CALLBACK_SECRET }),
    );
  }

  beforeEach(async () => {
    await dbStore.reset();
    stkPushService.verifierRegistry.resetToDefaults();
    stkPushService.adapterRegistry.resetToDefaults();

    await dbStore.seedOrganizationDirect({
      id: orgA,
      name: 'Org Alpha Enterprises',
      slug: `org-alpha-${orgA.slice(0, 8)}`,
      countryCode: 'TZA',
    });
    await dbStore.seedOrganizationDirect({
      id: orgB,
      name: 'Org Beta Retailers',
      slug: `org-beta-${orgB.slice(0, 8)}`,
      countryCode: 'TZA',
    });

    await dbStore.registerDevice({
      id: deviceA,
      organizationId: orgA,
      label: 'Alpha Relay Phone',
      deviceModel: 'SM-A546E',
      manufacturer: 'Samsung',
      androidVersion: '14.0',
      appVersion: '1.0.0',
      publicKeyPem: 'KEY_ALPHA',
      status: DeviceStatus.ACTIVE,
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
      tokenHash: `tok_a_${deviceA}`,
    });

    await dbStore.registerDevice({
      id: deviceB,
      organizationId: orgB,
      label: 'Beta Relay Phone',
      deviceModel: 'SM-A546E',
      manufacturer: 'Samsung',
      androidVersion: '14.0',
      appVersion: '1.0.0',
      publicKeyPem: 'KEY_BETA',
      status: DeviceStatus.ACTIVE,
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
      tokenHash: `tok_b_${deviceB}`,
    });

    await grantDeveloperPlan(orgA);
    const createdKeyA = await apiKeyService.createApiKey(orgA, {
      organizationId: orgA,
      name: 'Alpha STK Key',
      scopes: [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_READ, ApiKeyScope.PAYMENTS_WRITE],
    });
    apiKeyA = createdKeyA.plainTextSecret;

    await grantDeveloperPlan(orgB);
    const createdKeyB = await apiKeyService.createApiKey(orgB, {
      organizationId: orgB,
      name: 'Beta STK Key',
      scopes: [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_READ, ApiKeyScope.PAYMENTS_WRITE],
    });
    apiKeyB = createdKeyB.plainTextSecret;
  });

  afterEach(() => {
    stkPushService.verifierRegistry.resetToDefaults();
    stkPushService.adapterRegistry.resetToDefaults();
  });

  // =========================================================================
  // GROUP A: Companion Ingestion Integration (8 tests)
  // =========================================================================
  describe('A. Companion Payment Ingestion Integration', () => {
    it('1. acquires PROVISIONAL global claim, normalizes ref, and never auto-settles invoice', async () => {
      const invoice = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-A-001',
        totalAmountCents: 12000000n,
        customerPhone: '+255754111001',
      });

      const ack = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'qc11aa22bb Imethibitishwa. Umepokea Tsh120,000 kutoka kwa Asha Musa 255754111001 tarehe 14/11/2026 saa 10:00. Kumbukumbu namba: INV-A-001.',
        deviceTimestamp: new Date('2026-11-14T10:00:00Z'),
      });

      assert.equal(ack.acknowledged, true);
      assert.equal(ack.status, 'OBSERVED');
      assert.equal(ack.reference, 'QC11AA22BB');
      assert.equal(ack.state, TransactionState.MATCHED);

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QC11AA22BB');
      assert.equal(claim?.status, ClaimStatus.PROVISIONAL);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.CLIENT_REPORTED);
      assert.equal(claim?.organizationId, orgA);
      assert.equal(claim?.paymentId, ack.paymentId);

      // Candidate matching only: invoice remains UNPAID and never confirmed by carrier
      const invAfter = await reconciliationService.findInvoiceById(orgA, invoice.id);
      assert.equal(invAfter?.status, InvoiceStatus.UNPAID);
      assert.equal(invAfter?.paidAmountCents, 0n);

      const rawEv = await dbStore.getRawEvidencesByOrg(orgA);
      assert.equal(rawEv[0]?.sourceType, EvidenceSourceType.ANDROID_NOTIFICATION_RELAY);
    });

    it('2. makes repeated identical delivery idempotent via deduplication_hash without second claim event', async () => {
      await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-A-002',
        totalAmountCents: 5000000n,
      });

      const payload = 'QC22IDEM01 Imethibitishwa. Umepokea Tsh50,000 kutoka kwa Juma 255754111002 tarehe 14/11/2026 saa 11:00. Kumbukumbu namba: INV-A-002.';
      const ts = new Date('2026-11-14T11:00:00Z');

      const first = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: payload,
        deviceTimestamp: ts,
      });

      const second = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: payload,
        deviceTimestamp: ts,
      });

      assert.equal(first.status, 'OBSERVED');
      assert.equal(second.status, 'DUPLICATE');
      assert.equal(second.state, TransactionState.DUPLICATE_REJECTED);
      assert.equal(second.paymentId, first.paymentId);

      const payments = await dbStore.getNormalizedPaymentsByOrg(orgA);
      assert.equal(payments.length, 1);

      const events = await sql`SELECT * FROM "payment_reference_claim_events" WHERE "provider_reference" = 'QC22IDEM01'`;
      assert.equal(events.length, 1);
    });

    it('3. correlates same-tenant supplementary SMS as supplementary evidence without second payment', async () => {
      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-SUPP-03',
        totalAmountCents: 8000000n,
      });

      const first = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QC33SUPP03 Imethibitishwa. Umepokea Tsh80,000 kutoka kwa Ali 255754333003 tarehe 14/11/2026 saa 12:00. Kumbukumbu namba: INV-SUPP-03.',
        deviceTimestamp: new Date('2026-11-14T12:00:00Z'),
      });

      const supplementary = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'qc33supp03 Imethibitishwa. Umepokea Tsh80,000 kutoka kwa Ali 255754333003 tarehe 14/11/2026 saa 12:05. Kumbukumbu namba: INV-SUPP-03.',
        deviceTimestamp: new Date('2026-11-14T12:05:00Z'),
      });

      assert.equal(supplementary.paymentId, first.paymentId);
      const payments = await dbStore.getNormalizedPaymentsByOrg(orgA);
      assert.equal(payments.length, 1);

      const rawRows = await sql`
        SELECT "parse_status" FROM "raw_payment_evidence"
        WHERE "organization_id" = ${orgA}
        ORDER BY "received_at" ASC
      `;
      assert.deepEqual(rawRows.map((r) => r.parse_status), ['OBSERVED', 'OBSERVED_SUPPLEMENTARY']);

      const events = await sql`
        SELECT "action" FROM "payment_reference_claim_events"
        WHERE "provider_reference" = 'QC33SUPP03'
        ORDER BY "created_at" ASC
      `;
      assert.deepEqual(events.map((e) => e.action), [
        ClaimEventAction.PROVISIONALLY_CLAIMED,
        ClaimEventAction.SUPPLEMENTARY_ATTACHED,
      ]);

      const invCheck = await reconciliationService.findInvoiceById(orgA, inv.id);
      assert.equal(invCheck?.status, InvoiceStatus.UNPAID);
    });

    it('4. flags conflicting same-tenant supplementary SMS as AMOUNT_MISMATCH_DISPUTE and REVIEW_REQUIRED', async () => {
      await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QC44CONF04 Imethibitishwa. Umepokea Tsh50,000 kutoka kwa John 255754444004 tarehe 14/11/2026 saa 12:00.',
        deviceTimestamp: new Date('2026-11-14T12:00:00Z'),
      });

      const conflict = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QC44CONF04 Imethibitishwa. Umepokea Tsh95,000 kutoka kwa John 255754444004 tarehe 14/11/2026 saa 12:02.',
        deviceTimestamp: new Date('2026-11-14T12:02:00Z'),
      });

      assert.equal(conflict.state, TransactionState.REVIEW_REQUIRED);
      const payments = await dbStore.getNormalizedPaymentsByOrg(orgA);
      assert.equal(payments.length, 1);
      assert.equal(payments[0]!.state, TransactionState.REVIEW_REQUIRED);

      const rawRows = await sql`
        SELECT "parse_status" FROM "raw_payment_evidence"
        WHERE "organization_id" = ${orgA}
        ORDER BY "received_at" ASC
      `;
      assert.equal(rawRows[1]?.parse_status, 'AMOUNT_MISMATCH_DISPUTE');
    });

    it('5. blocks competing organization from claiming an active PROVISIONAL reference via companion SMS', async () => {
      await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QC55LOCK05 Imethibitishwa. Umepokea Tsh40,000 kutoka kwa Halima 255754555005 tarehe 14/11/2026 saa 12:10.',
        deviceTimestamp: new Date('2026-11-14T12:10:00Z'),
      });

      await assert.rejects(
        () =>
          ingestionService.ingestEvidence({
            organizationId: orgB,
            sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
            deviceId: deviceB,
            senderAddress: 'M-PESA',
            rawPayload: 'qc55lock05 Imethibitishwa. Umepokea Tsh40,000 kutoka kwa Halima 255754555005 tarehe 14/11/2026 saa 12:11.',
            deviceTimestamp: new Date('2026-11-14T12:11:00Z'),
          }),
        (err: any) => err instanceof HttpException && err.statusCode === 409 && err.code === 'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
      );

      assert.equal((await dbStore.getNormalizedPaymentsByOrg(orgB)).length, 0);
      assert.equal((await dbStore.getRawEvidencesByOrg(orgB)).length, 0);
    });

    it('6. escalates cross-tenant EXPIRED claim grab attempt to persisted DISPUTED and rejects HTTP 409', async () => {
      await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QC66EXP006 Imethibitishwa. Umepokea Tsh30,000 kutoka kwa Musa 255754666006 tarehe 14/11/2026 saa 09:00.',
        deviceTimestamp: new Date('2026-11-14T09:00:00Z'),
      });

      await sql`
        UPDATE "payment_reference_claims"
        SET "status" = 'EXPIRED'::"claim_status",
            "expires_at" = CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        WHERE "provider_reference" = 'QC66EXP006'
      `;

      await assert.rejects(
        () =>
          ingestionService.ingestEvidence({
            organizationId: orgB,
            sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
            deviceId: deviceB,
            senderAddress: 'M-PESA',
            rawPayload: 'QC66EXP006 Imethibitishwa. Umepokea Tsh30,000 kutoka kwa Musa 255754666006 tarehe 14/11/2026 saa 12:15.',
            deviceTimestamp: new Date('2026-11-14T12:15:00Z'),
          }),
        (err: any) => err instanceof HttpException && err.statusCode === 409 && err.code === 'CROSS_TENANT_DISPUTE',
      );

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QC66EXP006');
      assert.equal(claim?.status, ClaimStatus.DISPUTED);
      assert.equal((await dbStore.getNormalizedPaymentsByOrg(orgB)).length, 0);

      const events = await sql`
        SELECT "action" FROM "payment_reference_claim_events"
        WHERE "provider_reference" = 'QC66EXP006' AND "action" = 'DISPUTE_RAISED'
      `;
      assert.equal(events.length, 1);
    });

    it('7. rejects UNRESOLVED_COLLISION on companion ingestion and rolls back failed ingestion cleanly', async () => {
      const colClaimId = randomUUID();
      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "status", "evidence_tier"
        ) VALUES (
          ${colClaimId}, 'MPESA'::"PaymentProvider", 'QC77COL007', NULL, 'UNRESOLVED_COLLISION'::"claim_status", 'UNRESOLVED'::"claim_evidence_tier"
        )
      `;

      await assert.rejects(
        () =>
          ingestionService.ingestEvidence({
            organizationId: orgA,
            sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
            deviceId: deviceA,
            senderAddress: 'M-PESA',
            rawPayload: 'QC77COL007 Imethibitishwa. Umepokea Tsh10,000 kutoka kwa Zena 255754777007 tarehe 14/11/2026 saa 12:20.',
            deviceTimestamp: new Date('2026-11-14T12:20:00Z'),
          }),
        (err: any) => err instanceof HttpException && err.statusCode === 409 && err.code === 'COLLISION_QUARANTINED',
      );
      assert.equal((await dbStore.getNormalizedPaymentsByOrg(orgA)).length, 0);

      // Failed mid-transaction candidate evaluation leaves zero orphaned claims or payments
      const failingRecon = {
        reconcilePayment: async () => {
          throw new Error('SIMULATED_RECON_FAILURE');
        },
      } as unknown as ReconciliationService;
      const failingIngestion = new IngestionService(failingRecon, claimService);

      await assert.rejects(
        () =>
          failingIngestion.ingestEvidence({
            organizationId: orgA,
            sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
            deviceId: deviceA,
            senderAddress: 'M-PESA',
            rawPayload: 'QC77ROLL07 Imethibitishwa. Umepokea Tsh10,000 kutoka kwa Zena 255754777007 tarehe 14/11/2026 saa 12:22.',
            deviceTimestamp: new Date('2026-11-14T12:22:00Z'),
          }),
        /SIMULATED_RECON_FAILURE/,
      );

      assert.equal(await claimService.getClaim(PaymentProvider.MPESA, 'QC77ROLL07'), null);
      assert.equal((await dbStore.getNormalizedPaymentsByOrg(orgA)).length, 0);
    });

    it('8. distinguishes ANDROID_NOTIFICATION_RELAY vs DIRECT_PROVIDER_API and never sets PROVIDER_AUTHENTICATED on relay', async () => {
      const ack = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QC88PROV08 Imethibitishwa. Umepokea Tsh65,000 kutoka kwa Neema 255754888008 tarehe 14/11/2026 saa 12:30.',
        deviceTimestamp: new Date('2026-11-14T12:30:00Z'),
      });

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QC88PROV08');
      assert.equal(claim?.status, ClaimStatus.PROVISIONAL);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.CLIENT_REPORTED);
      assert.notEqual(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal((await dbStore.getNormalizedPaymentsByOrg(orgA))[0]!.state, TransactionState.UNMATCHED);
      assert.ok(ack.evidenceId);
    });
  });

  // =========================================================================
  // GROUP B: Manual Reconciliation Integration (8 tests)
  // =========================================================================
  describe('B. Manual Payment Reconciliation & Verification Integration', () => {
    it('9. manual verification settles invoice while preserving PROVISIONAL claim & HUMAN_ATTESTED tier', async () => {
      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-MAN-09',
        totalAmountCents: 7500000n,
      });

      const ack = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QM09MAN001 Imethibitishwa. Umepokea Tsh75,000 kutoka kwa Asha 255754100009 tarehe 14/11/2026 saa 13:00. Kumbukumbu namba: INV-MAN-09.',
        deviceTimestamp: new Date('2026-11-14T13:00:00Z'),
      });

      const verifierId = randomUUID();
      const settled = await reconciliationService.verifyPayment(orgA, {
        paymentId: ack.paymentId!,
        invoiceId: inv.id,
        verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
        verifiedById: verifierId,
        externalVerificationRef: 'M-PESA-TILL-STMT-09',
        notes: 'Confirmed on official till statement extract',
      });

      assert.equal(settled.verificationState, PaymentVerificationState.HUMAN_ATTESTED);
      assert.equal(settled.claimStatus, ClaimStatus.PROVISIONAL);
      assert.equal(settled.invoice.status, InvoiceStatus.PAID);
      assert.equal(settled.payment.verifiedById, verifierId);
      assert.equal(settled.verification.externalVerificationRef, 'M-PESA-TILL-STMT-09');

      // Global claim remains PROVISIONAL / CLIENT_REPORTED (NOT CONFIRMED_PROVIDER)
      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QM09MAN001');
      assert.equal(claim?.status, ClaimStatus.PROVISIONAL);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.CLIENT_REPORTED);
    });

    it('10. refreshes same-org EXPIRED claim during manual verification and blocks competing tenant', async () => {
      const invA = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-MAN-10',
        totalAmountCents: 4500000n,
      });

      const ack = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QM10EXP002 Imethibitishwa. Umepokea Tsh45,000 kutoka kwa Beka 255754100010 tarehe 14/11/2026 saa 08:00. Kumbukumbu namba: INV-MAN-10.',
        deviceTimestamp: new Date('2026-11-14T08:00:00Z'),
      });

      await sql`
        UPDATE "payment_reference_claims"
        SET "status" = 'EXPIRED'::"claim_status",
            "expires_at" = CURRENT_TIMESTAMP - INTERVAL '1 hour'
        WHERE "provider_reference" = 'QM10EXP002'
      `;

      const settled = await reconciliationService.verifyPayment(orgA, {
        paymentId: ack.paymentId!,
        invoiceId: invA.id,
        verificationMethod: VerificationMethod.BANK_STATEMENT_RECONCILIATION,
        verifiedById: randomUUID(),
        externalVerificationRef: 'CRDB-STMT-2026-11',
        notes: 'Late manual reconciliation against CRDB business statement',
      });

      assert.equal(settled.invoice.status, InvoiceStatus.PAID);
      assert.equal(settled.claimStatus, ClaimStatus.PROVISIONAL);
      const refreshedClaim = await claimService.getClaim(PaymentProvider.MPESA, 'QM10EXP002');
      assert.equal(refreshedClaim?.status, ClaimStatus.PROVISIONAL);
      assert.ok(refreshedClaim!.expiresAt!.getTime() > Date.now());
    });

    it('11. blocks manual verification on UNRESOLVED_COLLISION, DISPUTED, and other-org claims', async () => {
      const invB = await reconciliationService.createInvoice(orgB, {
        referenceNumber: 'INV-MAN-11',
        totalAmountCents: 2000000n,
      });

      // Seed payment directly in Org B under an UNRESOLVED_COLLISION claim
      const rawId = randomUUID();
      const payB = randomUUID();
      await sql`
        INSERT INTO "raw_payment_evidence" ("id", "organization_id", "source_type", "sender_address", "raw_payload", "device_timestamp")
        VALUES (${rawId}, ${orgB}, 'AUTHORIZED_MANUAL_IMPORT'::"EvidenceSourceType", 'M-PESA', 'manual row', NOW())
      `;
      await sql`
        INSERT INTO "normalized_payments" (
          "id", "organization_id", "raw_evidence_id", "provider", "reference",
          "amount_cents", "currency", "sender_phone", "provider_timestamp", "state", "deduplication_hash"
        ) VALUES (
          ${payB}, ${orgB}, ${rawId}, 'MPESA'::"PaymentProvider", 'QM11BLK003',
          2000000, 'TZS', '255754100011', NOW(), 'MATCHED'::"TransactionState", ${'hash_' + randomUUID()}
        )
      `;
      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "status", "evidence_tier"
        ) VALUES (
          gen_random_uuid(), 'MPESA'::"PaymentProvider", 'QM11BLK003', NULL,
          'UNRESOLVED_COLLISION'::"claim_status", 'UNRESOLVED'::"claim_evidence_tier"
        )
      `;

      await assert.rejects(
        () =>
          reconciliationService.verifyPayment(orgB, {
            paymentId: payB,
            invoiceId: invB.id,
            verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
            verifiedById: randomUUID(),
            externalVerificationRef: 'FIN-CHK-001',
            notes: 'Attempting verify on quarantined collision reference',
          }),
        (err: any) => err instanceof HttpException && err.code === 'COLLISION_QUARANTINED',
      );

      // Move claim to DISPUTED held by Org A
      await sql`
        UPDATE "payment_reference_claims"
        SET "organization_id" = ${orgA}, "status" = 'DISPUTED'::"claim_status"
        WHERE "provider_reference" = 'QM11BLK003'
      `;
      await assert.rejects(
        () =>
          reconciliationService.verifyPayment(orgB, {
            paymentId: payB,
            invoiceId: invB.id,
            verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
            verifiedById: randomUUID(),
            externalVerificationRef: 'FIN-CHK-002',
            notes: 'Attempting verify on disputed cross-tenant reference',
          }),
        (err: any) => err instanceof HttpException && err.code === 'CROSS_TENANT_DISPUTE',
      );

      // Move claim to PROVISIONAL held by Org A
      await sql`
        UPDATE "payment_reference_claims"
        SET "status" = 'PROVISIONAL'::"claim_status", "expires_at" = NOW() + INTERVAL '1 hour'
        WHERE "provider_reference" = 'QM11BLK003'
      `;
      await assert.rejects(
        () =>
          reconciliationService.verifyPayment(orgB, {
            paymentId: payB,
            invoiceId: invB.id,
            verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
            verifiedById: randomUUID(),
            externalVerificationRef: 'FIN-CHK-003',
            notes: 'Attempting verify on reference claimed by Org A',
          }),
        (err: any) => err instanceof HttpException && err.code === 'REFERENCE_CLAIMED_BY_ANOTHER_ORG',
      );

      const invCheck = await reconciliationService.findInvoiceById(orgB, invB.id);
      assert.equal(invCheck?.status, InvoiceStatus.UNPAID);
    });

    it('12. enforces separation of duties against device pairing user and permits independent finance user', async () => {
      const pairingUser = await authService.register({
        email: `pairer-${randomUUID().slice(0, 6)}@brisksms.app`,
        password: 'StrongPassword123!',
        fullName: 'Pairing Admin',
      });
      const financeUser = await authService.register({
        email: `finance-${randomUUID().slice(0, 6)}@brisksms.app`,
        password: 'StrongPassword123!',
        fullName: 'Finance Auditor',
      });

      await dbStore.addMember({
        organizationId: orgA,
        userId: pairingUser.user.id,
        role: UserRole.ADMIN,
        actorId: pairingUser.user.id,
      });

      await sql`DELETE FROM "devices" WHERE "id" = ${deviceA}`;
      const pairedToken = await deviceService.createPairingToken(orgA, pairingUser.user.id);
      const sodKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const sodPubPem = sodKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
      const sodFp = createHash('sha256')
        .update(sodKeys.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex');
      const sodChallenge = await deviceService.createPairingChallenge({
        enrollmentToken: pairedToken.pairingToken,
        publicKeyPem: sodPubPem,
      });
      const sodSig = cryptoSign(
        'sha256',
        buildPairingChallengeTranscript({
          challengeId: sodChallenge.challengeId,
          enrollmentId: sodChallenge.enrollmentId,
          organizationId: sodChallenge.organizationId,
          pairingTokenHash: hashToken(pairedToken.pairingToken),
          publicKeyFingerprint: sodFp,
          keyAlgorithm: sodChallenge.keyAlgorithm,
          signatureAlgorithm: sodChallenge.signatureAlgorithm,
          challengeNonce: sodChallenge.challenge,
          expiresAtIso: sodChallenge.expiresAt,
        }),
        { key: sodKeys.privateKey, dsaEncoding: 'der' },
      ).toString('base64');
      const paired = await deviceService.pairDevice({
        enrollmentToken: pairedToken.pairingToken,
        challengeId: sodChallenge.challengeId,
        challengeSignature: sodSig,
        label: 'Paired Till Phone',
        deviceModel: 'Pixel 7',
        manufacturer: 'Google',
        androidVersion: '14',
        appVersion: '1.0.0',
        publicKeyPem: sodPubPem,
        ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
      });

      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-SOD-12',
        totalAmountCents: 6000000n,
      });

      const ack = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: paired.deviceId,
        senderAddress: 'M-PESA',
        rawPayload: 'QM12SOD004 Imethibitishwa. Umepokea Tsh60,000 kutoka kwa Salum 255754100012 tarehe 14/11/2026 saa 13:10. Kumbukumbu namba: INV-SOD-12.',
        deviceTimestamp: new Date('2026-11-14T13:10:00Z'),
      });

      // Same user who paired device cannot verify it
      await assert.rejects(
        () =>
          reconciliationService.verifyPayment(orgA, {
            paymentId: ack.paymentId!,
            invoiceId: inv.id,
            verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
            verifiedById: pairingUser.user.id,
            externalVerificationRef: 'SOD-REF-001',
            notes: 'Self-verifying payment from self-paired relay device',
          }),
        (err: any) => err instanceof HttpException && err.statusCode === 403 && err.code === 'SEPARATION_OF_DUTIES_VIOLATION',
      );

      // Different finance user succeeds cleanly
      const verified = await reconciliationService.verifyPayment(orgA, {
        paymentId: ack.paymentId!,
        invoiceId: inv.id,
        verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
        verifiedById: financeUser.user.id,
        externalVerificationRef: 'SOD-REF-002',
        notes: 'Verified independently by second finance officer',
      });
      assert.equal(verified.invoice.status, InvoiceStatus.PAID);
    });

    it('13. requires externalVerificationRef >= 6 chars and notes >= 10 chars on HTTP POST /v1/reconciliation/verify', async () => {
      const reg = await authService.register({
        email: `fin-http-${randomUUID().slice(0, 6)}@brisksms.app`,
        password: 'StrongPassword123!',
        fullName: 'HTTP Finance User',
        organizationName: 'HTTP Verify Org',
      });
      const testOrgId = reg.organizationId!;

      const inv = await reconciliationService.createInvoice(testOrgId, {
        referenceNumber: 'INV-HTTP-13',
        totalAmountCents: 3500000n,
      });
      const ack = await ingestionService.ingestEvidence({
        organizationId: testOrgId,
        sourceType: EvidenceSourceType.DIRECT_PROVIDER_API,
        senderAddress: 'M-PESA',
        rawPayload: 'QM13HTTP05 Imethibitishwa. Umepokea Tsh35,000 kutoka kwa Dina 255754100013 tarehe 14/11/2026 saa 13:20. Kumbukumbu namba: INV-HTTP-13.',
        deviceTimestamp: new Date('2026-11-14T13:20:00Z'),
      });

      const authHeader = {
        Authorization: `Bearer ${reg.tokens.accessToken}`,
        'Content-Type': 'application/json',
      };

      const badRef = await makeRequest('POST', '/v1/reconciliation/verify', authHeader, {
        organizationId: testOrgId,
        paymentId: ack.paymentId,
        invoiceId: inv.id,
        externalVerificationRef: 'OK',
        notes: 'Valid length audit explanation note',
      });
      assert.equal(badRef.statusCode, 400);
      assert.equal(badRef.json?.error?.code, 'INVALID_EXTERNAL_VERIFICATION_REF');

      const badNotes = await makeRequest('POST', '/v1/reconciliation/verify', authHeader, {
        organizationId: testOrgId,
        paymentId: ack.paymentId,
        invoiceId: inv.id,
        externalVerificationRef: 'VALID-EXT-REF',
        notes: 'short',
      });
      assert.equal(badNotes.statusCode, 400);
      assert.equal(badNotes.json?.error?.code, 'INVALID_VERIFICATION_NOTES');

      const okRes = await makeRequest('POST', '/v1/reconciliation/verify', authHeader, {
        organizationId: testOrgId,
        paymentId: ack.paymentId,
        invoiceId: inv.id,
        externalVerificationRef: 'VALID-EXT-REF',
        notes: 'Matched against Vodacom daily merchant portal extract',
      });
      assert.equal(okRes.statusCode, 200);
      assert.equal(okRes.json?.data?.invoice?.status, InvoiceStatus.PAID);
    });

    it('14. preserves partial payment and overpayment review behavior under global claim integration', async () => {
      const invPartial = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-PART-14',
        totalAmountCents: 10000000n,
      });

      const partAck = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QM14PART06 Imethibitishwa. Umepokea Tsh40,000 kutoka kwa Pendo 255754100014 tarehe 14/11/2026 saa 13:30. Kumbukumbu namba: INV-PART-14.',
        deviceTimestamp: new Date('2026-11-14T13:30:00Z'),
      });
      const partialRes = await reconciliationService.verifyPayment(orgA, {
        paymentId: partAck.paymentId!,
        verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
        verifiedById: randomUUID(),
        externalVerificationRef: 'PARTIAL-01',
        notes: 'Approved first installment payment toward invoice',
      });
      assert.equal(partialRes.invoice.id, invPartial.id);
      assert.equal(partialRes.invoice.status, InvoiceStatus.PARTIALLY_PAID);
      assert.equal(partialRes.invoice.balanceCents, 6000000n);

      const invOver = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-OVER-14',
        totalAmountCents: 5000000n,
      });
      const overAck = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QM14OVER07 Imethibitishwa. Umepokea Tsh75,000 kutoka kwa Pendo 255754100014 tarehe 14/11/2026 saa 13:35. Kumbukumbu namba: INV-OVER-14.',
        deviceTimestamp: new Date('2026-11-14T13:35:00Z'),
      });
      assert.equal(overAck.state, TransactionState.REVIEW_REQUIRED);

      const overRes = await reconciliationService.verifyPayment(orgA, {
        paymentId: overAck.paymentId!,
        invoiceId: invOver.id,
        verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
        verifiedById: randomUUID(),
        externalVerificationRef: 'OVERPAY-01',
        notes: 'Finance confirmed customer intended full overpayment',
      });
      assert.equal(overRes.invoice.status, InvoiceStatus.OVERPAID);
    });

    it('15. local rejectPayment leaves global claim intact without releasing to RELEASED', async () => {
      await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-REJ-15',
        totalAmountCents: 3000000n,
      });

      const ack = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QM15REJ008 Imethibitishwa. Umepokea Tsh30,000 kutoka kwa Tariq 255754100015 tarehe 14/11/2026 saa 13:40. Kumbukumbu namba: INV-REJ-15.',
        deviceTimestamp: new Date('2026-11-14T13:40:00Z'),
      });

      const rejected = await reconciliationService.rejectPayment(orgA, {
        paymentId: ack.paymentId!,
        verifiedById: randomUUID(),
        notes: 'Reference absent from official statement; rejected as spoofed',
      });
      assert.equal(rejected.payment.state, TransactionState.REJECTED);

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QM15REJ008');
      assert.equal(claim?.status, ClaimStatus.PROVISIONAL);
    });

    it('16. blocks a second same-org payment from reusing a claim already linked to another payment', async () => {
      const inv1 = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-DUP-16A',
        totalAmountCents: 2500000n,
      });
      const inv2 = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-DUP-16B',
        totalAmountCents: 2500000n,
      });

      const ack1 = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QM16DUP009 Imethibitishwa. Umepokea Tsh25,000 kutoka kwa Ally 255754100016 tarehe 14/11/2026 saa 13:45. Kumbukumbu namba: INV-DUP-16A.',
        deviceTimestamp: new Date('2026-11-14T13:45:00Z'),
      });

      // Seed a rogue second normalized payment in same org with identical reference
      const rawId2 = randomUUID();
      const roguePayId = randomUUID();
      await sql`
        INSERT INTO "raw_payment_evidence" ("id", "organization_id", "source_type", "sender_address", "raw_payload", "device_timestamp")
        VALUES (${rawId2}, ${orgA}, 'AUTHORIZED_MANUAL_IMPORT'::"EvidenceSourceType", 'M-PESA', 'rogue dup', NOW())
      `;
      await sql`
        INSERT INTO "normalized_payments" (
          "id", "organization_id", "raw_evidence_id", "provider", "reference",
          "amount_cents", "currency", "sender_phone", "provider_timestamp", "state", "deduplication_hash"
        ) VALUES (
          ${roguePayId}, ${orgA}, ${rawId2}, 'MPESA'::"PaymentProvider", 'QM16DUP009',
          2500000, 'TZS', '255754100016', NOW(), 'MATCHED'::"TransactionState", ${'rogue_' + randomUUID()}
        )
      `;

      await assert.rejects(
        () =>
          reconciliationService.verifyPayment(orgA, {
            paymentId: roguePayId,
            invoiceId: inv2.id,
            verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
            verifiedById: randomUUID(),
            externalVerificationRef: 'DUP-CHK-01',
            notes: 'Attempting to settle second invoice with bound ref',
          }),
        (err: any) => err instanceof HttpException && err.code === 'REFERENCE_ALREADY_USED',
      );

      // Original payment verification still succeeds on inv1
      const ok = await reconciliationService.verifyPayment(orgA, {
        paymentId: ack1.paymentId!,
        invoiceId: inv1.id,
        verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
        verifiedById: randomUUID(),
        externalVerificationRef: 'ORIG-CHK-01',
        notes: 'Verifying original first candidate payment safely',
      });
      assert.equal(ok.invoice.status, InvoiceStatus.PAID);
    });
  });

  // =========================================================================
  // GROUP C: STK Callback Integration (10 tests)
  // =========================================================================
  describe('C. STK Callback Integration & Contradictory Callback Resolution', () => {
    it('17. keeps all 8 production callback verifiers disabled by default and rejects unverified callbacks fail-closed', async () => {
      const freshService = new StkPushService(reconciliationService, undefined, claimService);
      for (const provider of Object.values(PaymentProvider)) {
        assert.ok(
          freshService.verifierRegistry.getVerifier(provider) instanceof DisabledProviderCallbackVerifier,
          `Production verifier for ${provider} must default to DisabledProviderCallbackVerifier`,
        );
      }

      const payload = buildMpesaCallbackPayload({
        checkoutId: `voda_${randomUUID()}`,
        receiptNumber: 'QS17FAIL01',
        amount: 10000,
      });
      const res = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(payload),
        payload,
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'PROVIDER_CALLBACK_DISABLED');
    });

    it('18. authentic STK callback confirms claim CONFIRMED_PROVIDER, marks PROVIDER_AUTHENTICATED, and settles invoice', async () => {
      registerTestMpesaVerifier();

      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-STK-18',
        totalAmountCents: 9000000n,
      });
      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 111 222', amount: 90000, invoiceId: inv.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId as string;

      const cbPayload = buildMpesaCallbackPayload({
        checkoutId,
        receiptNumber: 'QS18CONF01',
        amount: 90000,
      });
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      assert.equal(cbRes.statusCode, 200);
      assert.equal(cbRes.json?.data?.status, StkPushStatus.SUCCESS);

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QS18CONF01');
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.AUTHORITATIVE_PROVIDER);
      assert.equal(claim?.checkoutId, checkoutId);

      const invAfter = await reconciliationService.findInvoiceById(orgA, inv.id);
      assert.equal(invAfter?.status, InvoiceStatus.PAID);

      const auditRows = await sql`
        SELECT "new_state", "metadata" FROM "audit_logs"
        WHERE "organization_id" = ${orgA} AND "action" = 'payment.verified'
      `;
      const newState =
        typeof auditRows[0]!.new_state === 'string'
          ? JSON.parse(auditRows[0]!.new_state)
          : auditRows[0]!.new_state;
      assert.equal(newState.verificationState, PaymentVerificationState.PROVIDER_AUTHENTICATED);
    });

    it('19. normalizes lowercase and whitespace-padded callback references before claiming and storing', async () => {
      registerTestMpesaVerifier();

      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-STK-19',
        totalAmountCents: 1500000n,
      });
      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 111 222', amount: 15000, invoiceId: inv.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId as string;

      const cbPayload = buildMpesaCallbackPayload({
        checkoutId,
        receiptNumber: '  qs19case02  ',
        amount: 15000,
      });
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      assert.equal(cbRes.statusCode, 200);
      assert.equal(cbRes.json?.data?.providerReference, 'QS19CASE02');

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QS19CASE02');
      assert.equal(claim?.providerReference, 'QS19CASE02');
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
    });

    it('20. upgrades same-org PROVISIONAL SMS claim to CONFIRMED_PROVIDER on STK callback without duplicate payment', async () => {
      registerTestMpesaVerifier();

      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-STK-20',
        totalAmountCents: 5500000n,
      });

      const smsAck = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QS20UPG003 Imethibitishwa. Umepokea Tsh55,000 kutoka kwa Rehema 255754200020 tarehe 14/11/2026 saa 14:00. Kumbukumbu namba: INV-STK-20.',
        deviceTimestamp: new Date('2026-11-14T14:00:00Z'),
      });
      assert.equal((await claimService.getClaim(PaymentProvider.MPESA, 'QS20UPG003'))?.status, ClaimStatus.PROVISIONAL);

      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 020', amount: 55000, invoiceId: inv.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId as string;

      const cbPayload = buildMpesaCallbackPayload({
        checkoutId,
        receiptNumber: 'QS20UPG003',
        amount: 55000,
      });
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      assert.equal(cbRes.statusCode, 200);

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QS20UPG003');
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.AUTHORITATIVE_PROVIDER);
      assert.equal(claim?.paymentId, smsAck.paymentId);

      // Exactly 1 normalized_payments row reused across SMS -> STK confirmation, invoice paid once
      const pays = await dbStore.getNormalizedPaymentsByOrg(orgA);
      assert.equal(pays.length, 1);
      assert.equal(pays[0]!.state, TransactionState.VERIFIED);

      const invAfter = await reconciliationService.findInvoiceById(orgA, inv.id);
      assert.equal(invAfter?.status, InvoiceStatus.PAID);
      assert.equal(invAfter?.paidAmountCents, 5500000n);
    });

    it('21. idempotently handles duplicate/concurrent same-checkout STK callbacks with single event & settlement', async () => {
      registerTestMpesaVerifier();

      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-STK-21',
        totalAmountCents: 4000000n,
      });
      const initRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 021', amount: 40000, invoiceId: inv.id },
      );
      const checkoutId = initRes.json?.data?.checkoutId as string;

      const cbPayload = buildMpesaCallbackPayload({
        checkoutId,
        receiptNumber: 'QS21IDEM04',
        amount: 40000,
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const [s1, s2] = await Promise.allSettled([
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(cbPayload, nowSec), cbPayload),
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(cbPayload, nowSec + 1), cbPayload),
      ]);
      assert.equal(s1.status, 'fulfilled');
      assert.equal(s2.status, 'fulfilled');
      assert.equal(s1.value.statusCode, 200);
      assert.equal(s2.value.statusCode, 200);

      const invAfter = await reconciliationService.findInvoiceById(orgA, inv.id);
      assert.equal(invAfter?.status, InvoiceStatus.PAID);
      assert.equal(invAfter?.paidAmountCents, 4000000n);

      const events = await sql`SELECT * FROM "payment_reference_claim_events" WHERE "provider_reference" = 'QS21IDEM04'`;
      assert.equal(events.length, 1);
    });

    it('22. evicts unverified PROVISIONAL claim in Org B when authoritative STK callback arrives for Org A', async () => {
      registerTestMpesaVerifier();

      // Org B receives unverified companion SMS
      const invB = await reconciliationService.createInvoice(orgB, {
        referenceNumber: 'INV-B-EVICT',
        totalAmountCents: 6500000n,
      });
      const smsB = await ingestionService.ingestEvidence({
        organizationId: orgB,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceB,
        senderAddress: 'M-PESA',
        rawPayload: 'QS22EVICT5 Imethibitishwa. Umepokea Tsh65,000 kutoka kwa Thief 255754200022 tarehe 14/11/2026 saa 14:10. Kumbukumbu namba: INV-B-EVICT.',
        deviceTimestamp: new Date('2026-11-14T14:10:00Z'),
      });
      assert.equal((await claimService.getClaim(PaymentProvider.MPESA, 'QS22EVICT5'))?.organizationId, orgB);

      // Org A receives authentic STK callback
      const invA = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-A-WIN',
        totalAmountCents: 6500000n,
      });
      const initA = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 022', amount: 65000, invoiceId: invA.id },
      );
      const cbPayload = buildMpesaCallbackPayload({
        checkoutId: initA.json?.data?.checkoutId,
        receiptNumber: 'QS22EVICT5',
        amount: 65000,
      });
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      assert.equal(cbRes.statusCode, 200);

      // Claim ownership transferred to Org A as CONFIRMED_PROVIDER
      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QS22EVICT5');
      assert.equal(claim?.organizationId, orgA);
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);

      // Org B payment downgraded to REVIEW_REQUIRED; Org B raw evidence preserved; Org B invoice unpaid
      const payBRows = await sql`SELECT "state", "review_reason" FROM "normalized_payments" WHERE "id" = ${smsB.paymentId!}`;
      assert.equal(payBRows[0]!.state, TransactionState.REVIEW_REQUIRED);
      assert.match(payBRows[0]!.review_reason, /CLAIM_SUPERSEDED/);
      assert.equal((await dbStore.getRawEvidencesByOrg(orgB)).length, 1);
      assert.equal((await reconciliationService.findInvoiceById(orgB, invB.id))?.status, InvoiceStatus.UNPAID);

      // Org A invoice settled
      assert.equal((await reconciliationService.findInvoiceById(orgA, invA.id))?.status, InvoiceStatus.PAID);
    });

    it('23. evicts EXPIRED unverified claim in Org A cleanly when authoritative STK callback arrives for Org B', async () => {
      registerTestMpesaVerifier();

      await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QS23EXP006 Imethibitishwa. Umepokea Tsh20,000 kutoka kwa Dan 255754200023 tarehe 14/11/2026 saa 08:00.',
        deviceTimestamp: new Date('2026-11-14T08:00:00Z'),
      });
      await sql`
        UPDATE "payment_reference_claims"
        SET "status" = 'EXPIRED'::"claim_status", "expires_at" = CURRENT_TIMESTAMP - INTERVAL '2 hours'
        WHERE "provider_reference" = 'QS23EXP006'
      `;

      const invB = await reconciliationService.createInvoice(orgB, {
        referenceNumber: 'INV-B-EXPWIN',
        totalAmountCents: 2000000n,
      });
      const initB = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyB}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 023', amount: 20000, invoiceId: invB.id },
      );
      const cbPayload = buildMpesaCallbackPayload({
        checkoutId: initB.json?.data?.checkoutId,
        receiptNumber: 'QS23EXP006',
        amount: 20000,
      });
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      assert.equal(cbRes.statusCode, 200);

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QS23EXP006');
      assert.equal(claim?.organizationId, orgB);
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);
      assert.equal((await reconciliationService.findInvoiceById(orgB, invB.id))?.status, InvoiceStatus.PAID);
    });

    it('24. preserves settled Org A books and escalates to DISPUTED on delayed contradictory STK callback for Org B', async () => {
      registerTestMpesaVerifier();

      // Time T0-T2: Org A receives SMS, human-attests, and settles Invoice A
      const invA = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-A-SETTLED',
        totalAmountCents: 11000000n,
      });
      const ackA = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QS24DISP07 Imethibitishwa. Umepokea Tsh110,000 kutoka kwa Grace 255754200024 tarehe 14/11/2026 saa 10:00. Kumbukumbu namba: INV-A-SETTLED.',
        deviceTimestamp: new Date('2026-11-14T10:00:00Z'),
      });
      await reconciliationService.verifyPayment(orgA, {
        paymentId: ackA.paymentId!,
        invoiceId: invA.id,
        verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
        verifiedById: randomUUID(),
        externalVerificationRef: 'FIN-SETTLE-24',
        notes: 'Verified via merchant portal before delayed callback',
      });

      // Time T3: Authentic carrier callback arrives for Org B checkout using the same ref
      const invB = await reconciliationService.createInvoice(orgB, {
        referenceNumber: 'INV-B-CONTESTED',
        totalAmountCents: 11000000n,
      });
      const initB = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyB}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 024', amount: 110000, invoiceId: invB.id },
      );
      const checkoutB = initB.json?.data?.checkoutId as string;

      const cbPayload = buildMpesaCallbackPayload({
        checkoutId: checkoutB,
        receiptNumber: 'QS24DISP07',
        amount: 110000,
      });
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      // Carrier webhook is acknowledged HTTP 200 so webhook retries cease, while dispute is durably persisted
      assert.equal(cbRes.statusCode, 200);
      assert.notEqual(cbRes.json?.data?.status, StkPushStatus.SUCCESS);

      // Global claim transitioned -> DISPUTED with AUTHORITATIVE_PROVIDER tier
      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QS24DISP07');
      assert.equal(claim?.status, ClaimStatus.DISPUTED);
      assert.equal(claim?.evidenceTier, ClaimEvidenceTier.AUTHORITATIVE_PROVIDER);

      // Org A historical invoice & payment remain preserved (zero silent reversal!), with dispute flag recorded
      const invACheck = await reconciliationService.findInvoiceById(orgA, invA.id);
      assert.equal(invACheck?.status, InvoiceStatus.PAID);
      assert.equal(invACheck?.paidAmountCents, 11000000n);
      const payACheck = await sql`SELECT "state", "review_reason" FROM "normalized_payments" WHERE "id" = ${ackA.paymentId!}`;
      assert.equal(payACheck[0]!.state, TransactionState.VERIFIED);
      assert.match(payACheck[0]!.review_reason, /CROSS_TENANT_CARRIER_DISPUTE/);

      // Org B invoice stays UNPAID and Org B candidate payment held in REVIEW_REQUIRED
      const invBCheck = await reconciliationService.findInvoiceById(orgB, invB.id);
      assert.equal(invBCheck?.status, InvoiceStatus.UNPAID);
      const payBCheck = await sql`SELECT "state", "review_reason" FROM "normalized_payments" WHERE "organization_id" = ${orgB}`;
      assert.equal(payBCheck.length, 1);
      assert.equal(payBCheck[0]!.state, TransactionState.REVIEW_REQUIRED);
      assert.equal(payBCheck[0]!.review_reason, 'CLAIM_DISPUTED_PREVIOUSLY_SETTLED_BY_OTHER_ORG');
    });

    it('25. blocks subsequent STK callback or manual verification once claim is DISPUTED', async () => {
      registerTestMpesaVerifier();

      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "status", "evidence_tier"
        ) VALUES (
          gen_random_uuid(), 'MPESA'::"PaymentProvider", 'QS25FROZ08', ${orgA},
          'DISPUTED'::"claim_status", 'AUTHORITATIVE_PROVIDER'::"claim_evidence_tier"
        )
      `;

      const invB = await reconciliationService.createInvoice(orgB, {
        referenceNumber: 'INV-B-FROZ',
        totalAmountCents: 1800000n,
      });
      const initB = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyB}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 025', amount: 18000, invoiceId: invB.id },
      );

      const cbPayload = buildMpesaCallbackPayload({
        checkoutId: initB.json?.data?.checkoutId,
        receiptNumber: 'QS25FROZ08',
        amount: 18000,
      });
      const cbRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      assert.equal(cbRes.statusCode, 409);
      assert.equal(cbRes.json?.error?.code, 'CROSS_TENANT_DISPUTE');
      assert.equal((await reconciliationService.findInvoiceById(orgB, invB.id))?.status, InvoiceStatus.UNPAID);
    });

    it('26. cancellation/failure callbacks do not create global claims and expired checkouts stay EXPIRED', async () => {
      registerTestMpesaVerifier();

      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-STK-26',
        totalAmountCents: 2200000n,
      });

      // User cancelled prompt
      const initCancel = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 026', amount: 22000, invoiceId: inv.id },
      );
      const cancelPayload = buildMpesaCallbackPayload({
        checkoutId: initCancel.json?.data?.checkoutId,
        receiptNumber: '',
        amount: 22000,
        resultCode: 1032,
        resultDesc: 'Cancelled by user',
      });
      const cancelRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cancelPayload),
        cancelPayload,
      );
      assert.equal(cancelRes.statusCode, 200);
      assert.equal(cancelRes.json?.data?.status, StkPushStatus.CANCELLED);

      // Expired checkout receiving late success does not claim reference or settle
      const initExp = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 200 026', amount: 22000, invoiceId: inv.id },
      );
      const expiredCheckoutId = initExp.json?.data?.checkoutId as string;
      await sql`
        UPDATE "stk_push_transactions" SET "status" = 'EXPIRED'::"StkPushStatus" WHERE "id" = ${expiredCheckoutId}
      `;

      const latePayload = buildMpesaCallbackPayload({
        checkoutId: expiredCheckoutId,
        receiptNumber: 'QS26LATE09',
        amount: 22000,
      });
      const lateRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(latePayload),
        latePayload,
      );
      assert.equal(lateRes.statusCode, 200);
      assert.equal(lateRes.json?.data?.status, StkPushStatus.EXPIRED);
      assert.equal(await claimService.getClaim(PaymentProvider.MPESA, 'QS26LATE09'), null);
      assert.equal((await reconciliationService.findInvoiceById(orgA, inv.id))?.status, InvoiceStatus.UNPAID);
    });
  });

  // =========================================================================
  // GROUP D: Cross-Path Integrity & Lock-Ordering Concurrency (6 tests)
  // =========================================================================
  describe('D. Cross-Path Integrity & Lock-Ordering Concurrency', () => {
    it('27. serializes concurrent companion ingestion (Org A vs Org B) on identical reference', async () => {
      const ref = 'QX27RACE01';
      const [resA, resB] = await Promise.allSettled([
        ingestionService.ingestEvidence({
          organizationId: orgA,
          sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
          deviceId: deviceA,
          senderAddress: 'M-PESA',
          rawPayload: `${ref} Imethibitishwa. Umepokea Tsh50,000 kutoka kwa Ali 255754300027 tarehe 14/11/2026 saa 15:00.`,
          deviceTimestamp: new Date('2026-11-14T15:00:00Z'),
        }),
        ingestionService.ingestEvidence({
          organizationId: orgB,
          sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
          deviceId: deviceB,
          senderAddress: 'M-PESA',
          rawPayload: `${ref.toLowerCase()} Imethibitishwa. Umepokea Tsh50,000 kutoka kwa Ali 255754300027 tarehe 14/11/2026 saa 15:00.`,
          deviceTimestamp: new Date('2026-11-14T15:00:00Z'),
        }),
      ]);

      const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
      const rejected = [resA, resB].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0]!.reason instanceof HttpException);
      assert.equal(rejected[0]!.reason.statusCode, 409);

      const claim = await claimService.getClaim(PaymentProvider.MPESA, ref);
      assert.equal(claim?.status, ClaimStatus.PROVISIONAL);
    });

    it('28. arbitrates concurrent Companion (Org B) vs STK Callback (Org A) deterministically', async () => {
      registerTestMpesaVerifier();

      const invA = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-RACE-28A',
        totalAmountCents: 7000000n,
      });
      const initA = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 300 028', amount: 70000, invoiceId: invA.id },
      );

      const cbPayload = buildMpesaCallbackPayload({
        checkoutId: initA.json?.data?.checkoutId,
        receiptNumber: 'QX28RACE02',
        amount: 70000,
      });

      const [stkRes, compRes] = await Promise.allSettled([
        makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(cbPayload), cbPayload),
        ingestionService.ingestEvidence({
          organizationId: orgB,
          sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
          deviceId: deviceB,
          senderAddress: 'M-PESA',
          rawPayload: 'QX28RACE02 Imethibitishwa. Umepokea Tsh70,000 kutoka kwa Comp 255754300028 tarehe 14/11/2026 saa 15:05.',
          deviceTimestamp: new Date('2026-11-14T15:05:00Z'),
        }),
      ]);

      // Regardless of arrival order: Org A ends up CONFIRMED_PROVIDER and PAID; Org B never holds claim or settled invoice
      assert.equal(stkRes.status, 'fulfilled');
      assert.equal(stkRes.value.statusCode, 200);
      assert.equal((await reconciliationService.findInvoiceById(orgA, invA.id))?.status, InvoiceStatus.PAID);

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QX28RACE02');
      assert.equal(claim?.organizationId, orgA);
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);

      if (compRes.status === 'rejected') {
        assert.equal(compRes.reason.statusCode, 409);
      } else {
        // Companion arrived microseconds before STK callback -> evicted into REVIEW_REQUIRED
        const payB = await sql`SELECT "state" FROM "normalized_payments" WHERE "organization_id" = ${orgB}`;
        assert.equal(payB[0]?.state, TransactionState.REVIEW_REQUIRED);
      }
    });

    it('29. serializes concurrent supplementary SMS + manual verification in same org with zero duplicate settlement', async () => {
      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-SAME-29',
        totalAmountCents: 4800000n,
      });
      const first = await ingestionService.ingestEvidence({
        organizationId: orgA,
        sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
        deviceId: deviceA,
        senderAddress: 'M-PESA',
        rawPayload: 'QX29SAME03 Imethibitishwa. Umepokea Tsh48,000 kutoka kwa Sami 255754300029 tarehe 14/11/2026 saa 15:10. Kumbukumbu namba: INV-SAME-29.',
        deviceTimestamp: new Date('2026-11-14T15:10:00Z'),
      });

      const [verSettled, suppSettled] = await Promise.allSettled([
        reconciliationService.verifyPayment(orgA, {
          paymentId: first.paymentId!,
          invoiceId: inv.id,
          verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
          verifiedById: randomUUID(),
          externalVerificationRef: 'MAN-RACE-29',
          notes: 'Concurrent manual verification with supplementary SMS',
        }),
        ingestionService.ingestEvidence({
          organizationId: orgA,
          sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
          deviceId: deviceA,
          senderAddress: 'M-PESA',
          rawPayload: 'QX29SAME03 Imethibitishwa. Umepokea Tsh48,000 kutoka kwa Sami 255754300029 tarehe 14/11/2026 saa 15:11. Kumbukumbu namba: INV-SAME-29.',
          deviceTimestamp: new Date('2026-11-14T15:11:00Z'),
        }),
      ]);
      assert.equal(verSettled.status, 'fulfilled');
      assert.equal(suppSettled.status, 'fulfilled');
      const verResult = verSettled.value;
      const suppResult = suppSettled.value;

      assert.equal(verResult.invoice.status, InvoiceStatus.PAID);
      assert.equal(suppResult.paymentId, first.paymentId);
      assert.equal((await dbStore.getNormalizedPaymentsByOrg(orgA)).length, 1);

      const invAfter = await reconciliationService.findInvoiceById(orgA, inv.id);
      assert.equal(invAfter?.paidAmountCents, 4800000n);
      assert.equal((await sql`SELECT * FROM "payment_verifications" WHERE "organization_id" = ${orgA}`).length, 1);
    });

    it('30. survives interleaved manual verification & delayed STK callback contention without deadlocks', async () => {
      registerTestMpesaVerifier();

      // Prepare 5 overlapping references across Org A (SMS + open invoice) and Org B (initiated STK checkout)
      const pairs: Array<{
        ref: string;
        payA: string;
        invA: string;
        checkoutB: string;
        invB: string;
        amount: number;
      }> = [];

      for (let i = 0; i < 5; i++) {
        const ref = `QX30STRESS0${i}`;
        const amount = 25000 + i * 1000;
        const amountCents = BigInt(amount) * 100n;
        const invA = await reconciliationService.createInvoice(orgA, {
          referenceNumber: `INV-STR-A-${i}`,
          totalAmountCents: amountCents,
        });
        const ackA = await ingestionService.ingestEvidence({
          organizationId: orgA,
          sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
          deviceId: deviceA,
          senderAddress: 'M-PESA',
          rawPayload: `${ref} Imethibitishwa. Umepokea Tsh${amount.toLocaleString('en-US')} kutoka kwa User${i} 25575430003${i} tarehe 14/11/2026 saa 15:20. Kumbukumbu namba: INV-STR-A-${i}.`,
          deviceTimestamp: new Date('2026-11-14T15:20:00Z'),
        });

        const invB = await reconciliationService.createInvoice(orgB, {
          referenceNumber: `INV-STR-B-${i}`,
          totalAmountCents: amountCents,
        });
        const initB = await makeRequest(
          'POST',
          '/v1/payments/stk-push',
          { Authorization: `Bearer ${apiKeyB}`, 'Content-Type': 'application/json' },
          { phoneNumber: `0754 300 03${i}`, amount, invoiceId: invB.id },
        );

        pairs.push({
          ref,
          payA: ackA.paymentId!,
          invA: invA.id,
          checkoutB: initB.json?.data?.checkoutId,
          invB: invB.id,
          amount,
        });
      }

      // Race all manual verifications in Org A concurrently with all STK callbacks in Org B
      const ops = pairs.flatMap((p) => [
        reconciliationService.verifyPayment(orgA, {
          paymentId: p.payA,
          invoiceId: p.invA,
          verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
          verifiedById: randomUUID(),
          externalVerificationRef: `STRESS-${p.ref}`,
          notes: 'Interleaved manual verification stress test',
        }),
        makeRequest(
          'POST',
          '/v1/payments/stk-push/callback/mpesa',
          createSignedCallbackHeaders(
            buildMpesaCallbackPayload({
              checkoutId: p.checkoutB,
              receiptNumber: p.ref,
              amount: p.amount,
            }),
          ),
          buildMpesaCallbackPayload({
            checkoutId: p.checkoutB,
            receiptNumber: p.ref,
            amount: p.amount,
          }),
        ),
      ]);

      const settled = await Promise.allSettled(ops);
      for (const s of settled) {
        if (s.status === 'rejected') {
          // Only expected business rejections (already evicted by STK), never 40P01 deadlock!
          assert.ok(s.reason instanceof HttpException, `Unexpected error: ${s.reason}`);
          assert.equal(s.reason.code, 'REFERENCE_ALREADY_SETTLED');
        }
      }

      // Invariant check across every pair: never BOTH invoices PAID!
      for (const p of pairs) {
        const aInv = await reconciliationService.findInvoiceById(orgA, p.invA);
        const bInv = await reconciliationService.findInvoiceById(orgB, p.invB);
        assert.ok(!(aInv?.status === InvoiceStatus.PAID && bInv?.status === InvoiceStatus.PAID));
      }
    });

    it('31. preserves permanent CONFIRMED_PROVIDER anti-replay block even after invoice VOID or REFUNDED mutation', async () => {
      registerTestMpesaVerifier();

      const inv = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-REPLAY-31',
        totalAmountCents: 3300000n,
      });
      const init1 = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 300 031', amount: 33000, invoiceId: inv.id },
      );
      const cb1 = buildMpesaCallbackPayload({
        checkoutId: init1.json?.data?.checkoutId,
        receiptNumber: 'QX31ANTIREP',
        amount: 33000,
      });
      assert.equal(
        (await makeRequest('POST', '/v1/payments/stk-push/callback/mpesa', createSignedCallbackHeaders(cb1), cb1)).statusCode,
        200,
      );

      // Invoice is later refunded/voided
      await sql`UPDATE "invoices" SET "status" = 'REFUNDED'::"InvoiceStatus" WHERE "id" = ${inv.id}`;

      const claim = await claimService.getClaim(PaymentProvider.MPESA, 'QX31ANTIREP');
      assert.equal(claim?.status, ClaimStatus.CONFIRMED_PROVIDER);

      // Reusing reference across Org B SMS or another checkout remains permanently blocked
      await assert.rejects(
        () =>
          ingestionService.ingestEvidence({
            organizationId: orgB,
            sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
            deviceId: deviceB,
            senderAddress: 'M-PESA',
            rawPayload: 'QX31ANTIREP Imethibitishwa. Umepokea Tsh33,000 kutoka kwa Replay 255754300031 tarehe 14/11/2026 saa 15:30.',
            deviceTimestamp: new Date('2026-11-14T15:30:00Z'),
          }),
        (err: any) => err instanceof HttpException && err.code === 'REFERENCE_ALREADY_SETTLED',
      );

      const inv2 = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-REPLAY-31B',
        totalAmountCents: 3300000n,
      });
      const init2 = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyA}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 300 031', amount: 33000, invoiceId: inv2.id },
      );
      const cb2 = buildMpesaCallbackPayload({
        checkoutId: init2.json?.data?.checkoutId,
        receiptNumber: 'QX31ANTIREP',
        amount: 33000,
      });
      const res2 = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cb2),
        cb2,
      );
      assert.equal(res2.statusCode, 409);
      assert.equal(res2.json?.error?.code, 'REFERENCE_ALREADY_USED');
    });

    it('32. enforces universal COLLISION_QUARANTINED block across Companion, Manual, and STK paths', async () => {
      registerTestMpesaVerifier();

      const claimId = randomUUID();
      await sql`
        INSERT INTO "payment_reference_claims" (
          "id", "provider", "provider_reference", "organization_id", "status", "evidence_tier"
        ) VALUES (
          ${claimId}, 'MPESA'::"PaymentProvider", 'QX32QUAR99', NULL,
          'UNRESOLVED_COLLISION'::"claim_status", 'UNRESOLVED'::"claim_evidence_tier"
        )
      `;
      await sql`
        INSERT INTO "payment_reference_claim_collisions" (
          "id", "claim_id", "provider", "provider_reference", "competing_records", "status"
        ) VALUES (
          gen_random_uuid(), ${claimId}, 'MPESA'::"PaymentProvider", 'QX32QUAR99',
          ${JSON.stringify([{ organizationId: orgA }, { organizationId: orgB }])}::jsonb, 'UNRESOLVED'
        )
      `;

      // Path 1: Companion SMS rejected
      await assert.rejects(
        () =>
          ingestionService.ingestEvidence({
            organizationId: orgA,
            sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
            deviceId: deviceA,
            senderAddress: 'M-PESA',
            rawPayload: 'qx32quar99 Imethibitishwa. Umepokea Tsh50,000 kutoka kwa Col 255754300032 tarehe 14/11/2026 saa 15:40.',
            deviceTimestamp: new Date('2026-11-14T15:40:00Z'),
          }),
        (err: any) => err instanceof HttpException && err.code === 'COLLISION_QUARANTINED',
      );

      // Path 2: Manual verification rejected
      const rawId = randomUUID();
      const payA = randomUUID();
      await sql`
        INSERT INTO "raw_payment_evidence" ("id", "organization_id", "source_type", "sender_address", "raw_payload", "device_timestamp")
        VALUES (${rawId}, ${orgA}, 'AUTHORIZED_MANUAL_IMPORT'::"EvidenceSourceType", 'M-PESA', 'historical row', NOW())
      `;
      await sql`
        INSERT INTO "normalized_payments" (
          "id", "organization_id", "raw_evidence_id", "provider", "reference",
          "amount_cents", "currency", "sender_phone", "provider_timestamp", "state", "deduplication_hash"
        ) VALUES (
          ${payA}, ${orgA}, ${rawId}, 'MPESA'::"PaymentProvider", 'QX32QUAR99',
          5000000, 'TZS', '255754300032', NOW(), 'MATCHED'::"TransactionState", ${'hist_' + randomUUID()}
        )
      `;
      const invA = await reconciliationService.createInvoice(orgA, {
        referenceNumber: 'INV-QUAR-32A',
        totalAmountCents: 5000000n,
      });

      await assert.rejects(
        () =>
          reconciliationService.verifyPayment(orgA, {
            paymentId: payA,
            invoiceId: invA.id,
            verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
            verifiedById: randomUUID(),
            externalVerificationRef: 'QUAR-MAN-32',
            notes: 'Trying manual verification on quarantined collision row',
          }),
        (err: any) => err instanceof HttpException && err.code === 'COLLISION_QUARANTINED',
      );

      // Path 3: STK Callback rejected
      const invB = await reconciliationService.createInvoice(orgB, {
        referenceNumber: 'INV-QUAR-32B',
        totalAmountCents: 5000000n,
      });
      const initB = await makeRequest(
        'POST',
        '/v1/payments/stk-push',
        { Authorization: `Bearer ${apiKeyB}`, 'Content-Type': 'application/json' },
        { phoneNumber: '0754 300 032', amount: 50000, invoiceId: invB.id },
      );
      const cbPayload = buildMpesaCallbackPayload({
        checkoutId: initB.json?.data?.checkoutId,
        receiptNumber: 'QX32QUAR99',
        amount: 50000,
      });
      const stkRes = await makeRequest(
        'POST',
        '/v1/payments/stk-push/callback/mpesa',
        createSignedCallbackHeaders(cbPayload),
        cbPayload,
      );
      assert.equal(stkRes.statusCode, 409);
      assert.equal(stkRes.json?.error?.code, 'COLLISION_QUARANTINED');

      assert.equal((await reconciliationService.findInvoiceById(orgA, invA.id))?.status, InvoiceStatus.UNPAID);
      assert.equal((await reconciliationService.findInvoiceById(orgB, invB.id))?.status, InvoiceStatus.UNPAID);
    });
  });
});
