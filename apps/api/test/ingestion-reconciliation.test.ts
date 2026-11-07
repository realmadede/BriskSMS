import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  EvidenceSourceType,
  TransactionState,
  InvoiceStatus,
  DeviceStatus,
  DeviceIngestionMode,
  VerificationMethod,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';

describe('Universal Ingestion & Financial Reconciliation Engine', () => {
  let reconciliationService: ReconciliationService;
  let ingestionService: IngestionService;
  const orgId = randomUUID();
  const deviceId = randomUUID();

  beforeEach(async () => {
    await dbStore.reset();
    reconciliationService = new ReconciliationService();
    ingestionService = new IngestionService(reconciliationService);

    await dbStore.seedOrganizationDirect({
      id: orgId,
      name: 'Alpha Traders Ltd',
      slug: `alpha-traders-${orgId.slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
    });

    await dbStore.registerDevice({
      id: deviceId,
      organizationId: orgId,
      label: 'Samsung Galaxy A54 Relay',
      deviceModel: 'SM-A546E',
      manufacturer: 'Samsung',
      androidVersion: '14.0',
      appVersion: '1.0.0',
      publicKeyPem: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...',
      status: DeviceStatus.ACTIVE,
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
      tokenHash: `token_hash_${deviceId}`,
    });
  });

  it('ingests M-Pesa notification into MATCHED candidate state (never settling invoice on notification alone) and updates invoice balance only upon independent/manual verification', async () => {
    // 1. Create open invoice
    const invoice = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'QA8921KL90',
      totalAmountCents: 15000000n, // 150,000 TZS
      customerPhone: '+255754000111',
      customerName: 'Juma Baraka',
    });

    assert.equal(invoice.status, InvoiceStatus.UNPAID);
    assert.equal(invoice.paidAmountCents, 0n);

    // 2. Relay M-Pesa payment notification from Android companion
    const rawPayload = 'QA8921KL90 Imethibitishwa. Umepokea Tsh150,000 kutoka kwa Juma Baraka 255754000111 tarehe 05/11/2026 saa 14:30. Salio lako jipya ni Tsh500,000.';

    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'M-PESA',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T14:30:00Z'),
    });

    assert.equal(ack.acknowledged, true);
    assert.equal(ack.status, 'OBSERVED');
    assert.equal(ack.state, TransactionState.MATCHED);
    assert.equal(ack.matchedInvoiceId, invoice.id);

    // 3. CRITICAL INVARIANT: Notification alone must NOT mark the invoice PAID or payment VERIFIED
    const invoiceBeforeVerification = await reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(invoiceBeforeVerification?.status, InvoiceStatus.UNPAID);
    assert.equal(invoiceBeforeVerification?.paidAmountCents, 0n);

    // 4. Independent/manual verification transitions payment to VERIFIED and settles the invoice balance
    const verificationResult = await reconciliationService.verifyPayment(orgId, {
      paymentId: ack.paymentId!,
      invoiceId: invoice.id,
      verificationMethod: VerificationMethod.INDEPENDENT_PROVIDER_QUERY,
      externalVerificationRef: 'VODACOM-STMT-QA8921KL90',
      notes: 'Verified against Vodacom merchant statement',
    });

    assert.equal(verificationResult.payment.state, TransactionState.VERIFIED);
    assert.equal(verificationResult.invoice.status, InvoiceStatus.PAID);
    assert.equal(verificationResult.invoice.paidAmountCents, 15000000n);
    assert.equal(verificationResult.fulfillmentEligible, true);

    // 5. Verify outbox events were emitted across the full lifecycle
    const outbox = await dbStore.getOutboxEventsByOrg(orgId);
    assert.equal(outbox.some((e) => e.eventType === 'payment.evidence.received'), true);
    assert.equal(outbox.some((e) => e.eventType === 'payment.matched'), true);
    assert.equal(outbox.some((e) => e.eventType === 'payment.verified'), true);
    assert.equal(outbox.some((e) => e.eventType === 'invoice.paid'), true);
    assert.equal(outbox.some((e) => e.eventType === 'fulfillment.eligible'), true);
  });

  it('rejects duplicate payment notifications idempotently without duplicate settlement', async () => {
    await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'QA8921KL90',
      totalAmountCents: 15000000n,
    });

    const rawPayload = 'QA8921KL90 Imethibitishwa. Umepokea Tsh150,000 kutoka kwa Juma Baraka 255754000111 tarehe 05/11/2026 saa 14:30.';

    // First ingestion
    const ack1 = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'M-PESA',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T14:30:00Z'),
    });
    assert.equal(ack1.status, 'OBSERVED');

    // Duplicate replay attempt
    const ack2 = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'M-PESA',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T14:30:00Z'),
    });

    assert.equal(ack2.status, 'DUPLICATE');
    assert.equal(ack2.state, TransactionState.DUPLICATE_REJECTED);
    assert.equal(ack2.paymentId, ack1.paymentId);

    // Verify raw evidence log is append-only (persists both attempts for forensic audit)
    const rawLogs = await dbStore.getRawEvidencesByOrg(orgId);
    assert.equal(rawLogs.length, 2);

    // Verify normalized payment was NOT duplicated
    const payments = await dbStore.getNormalizedPaymentsByOrg(orgId);
    assert.equal(payments.length, 1);
  });

  it('performs Tier 2 customer phone heuristic matching when reference is not in memo', async () => {
    const invoice = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-OCT-9901',
      totalAmountCents: 5000000n, // 50,000 TZS
      customerPhone: '+255713888999',
      customerName: 'Amina Salum',
    });

    const rawPayload = 'Umepokea Tsh 50,000 kutoka kwa AMINA SALUM (255713888999). Kumbukumbu namba: 98765432101. Tarehe 05/11/2026 15:45.';

    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'MIXX',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T16:00:00Z'),
    });

    assert.equal(ack.acknowledged, true);
    assert.equal(ack.state, TransactionState.MATCHED);
    assert.equal(ack.matchedInvoiceId, invoice.id);

    // Verify candidate match after independent verification settles invoice
    await reconciliationService.verifyPayment(orgId, {
      paymentId: ack.paymentId!,
      verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
    });

    const updatedInvoice = await reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(updatedInvoice?.status, InvoiceStatus.PAID);
  });

  it('handles underpayment by marking candidate MATCHED and transitioning invoice to PARTIALLY_PAID upon verification', async () => {
    const invoice = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'QA44DD55EE',
      totalAmountCents: 10000000n, // 100,000 TZS
    });

    // Customer pays only 40,000 TZS
    const rawPayload = 'QA44DD55EE Imethibitishwa. Umepokea Tsh40,000 kutoka kwa Baraka John 255754111222 tarehe 05/11/2026 saa 12:00.';

    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'M-PESA',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T12:00:00Z'),
    });

    assert.equal(ack.state, TransactionState.MATCHED);

    await reconciliationService.verifyPayment(orgId, {
      paymentId: ack.paymentId!,
      verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
    });

    const updatedInvoice = await reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(updatedInvoice?.status, InvoiceStatus.PARTIALLY_PAID);
    assert.equal(updatedInvoice?.paidAmountCents, 4000000n);
  });

  it('routes overpayment to REVIEW_REQUIRED without silent settlement', async () => {
    const invoice = await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'QA66FF77GG',
      totalAmountCents: 3000000n, // 30,000 TZS
    });

    // Customer overpays 50,000 TZS
    const rawPayload = 'QA66FF77GG Imethibitishwa. Umepokea Tsh50,000 kutoka kwa Baraka John 255754111222 tarehe 05/11/2026 saa 12:00.';

    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'M-PESA',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T12:00:00Z'),
    });

    assert.equal(ack.state, TransactionState.REVIEW_REQUIRED);

    // Invoice remains UNPAID until a human finance reviewer explicitly verifies/allocates the overpayment
    const invoiceBeforeReview = await reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(invoiceBeforeReview?.status, InvoiceStatus.UNPAID);

    // Verify outbox emitted review required event
    const outbox = await dbStore.getOutboxEventsByOrg(orgId);
    assert.equal(outbox.some((e) => e.eventType === 'payment.needs_review'), true);
  });

  it('routes ambiguous multiple open invoices for the same phone to REVIEW_REQUIRED', async () => {
    await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-A-101',
      totalAmountCents: 2000000n,
      customerPhone: '+255754999000',
    });
    await reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-B-202',
      totalAmountCents: 2000000n,
      customerPhone: '+255754999000',
    });

    const rawPayload = 'QA88HH99II Imethibitishwa. Umepokea Tsh20,000 kutoka kwa Hamisi Ally 255754999000 tarehe 05/11/2026 saa 12:00.';

    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'M-PESA',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T12:00:00Z'),
    });

    assert.equal(ack.state, TransactionState.REVIEW_REQUIRED);
    assert.equal(ack.matchedInvoiceId, undefined);
  });
});
