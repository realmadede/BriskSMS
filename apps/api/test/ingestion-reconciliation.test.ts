import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  EvidenceSourceType,
  TransactionState,
  InvoiceStatus,
  DeviceStatus,
  DeviceIngestionMode,
} from '@brisksms/shared';
import { dbStore, OrganizationRecord, DeviceRecord } from '../src/core/store.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';

describe('Universal Ingestion & Financial Reconciliation Engine', () => {
  let reconciliationService: ReconciliationService;
  let ingestionService: IngestionService;
  const orgId = randomUUID();
  const deviceId = randomUUID();

  beforeEach(() => {
    dbStore.reset();
    reconciliationService = new ReconciliationService();
    ingestionService = new IngestionService(reconciliationService);

    // Seed test organization
    const org: OrganizationRecord = {
      id: orgId,
      name: 'Alpha Traders Ltd',
      slug: 'alpha-traders',
      countryCode: 'TZ',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    dbStore.organizations.set(orgId, org);

    // Seed active Android device
    const device: DeviceRecord = {
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
      deviceTokenHash: 'token_hash_a54',
      lastSyncAt: new Date(),
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    dbStore.devices.set(deviceId, device);
  });

  it('ingests M-Pesa notification and achieves Tier 1 Exact Reference reconciliation', async () => {
    // 1. Create open invoice
    const invoice = reconciliationService.createInvoice(orgId, {
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

    // 3. Verify invoice is fully paid and ledger settled
    const updatedInvoice = reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(updatedInvoice?.status, InvoiceStatus.PAID);
    assert.equal(updatedInvoice?.paidAmountCents, 15000000n);

    // 4. Verify outbox events were emitted
    const outbox = dbStore.outboxEvents.filter((e) => e.organizationId === orgId);
    assert.equal(outbox.some((e) => e.eventType === 'payment.evidence.received'), true);
    assert.equal(outbox.some((e) => e.eventType === 'payment.matched'), true);
    assert.equal(outbox.some((e) => e.eventType === 'invoice.paid'), true);
  });

  it('rejects duplicate payment notifications idempotently without duplicate settlement', async () => {
    reconciliationService.createInvoice(orgId, {
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
    const rawLogs = dbStore.rawEvidences.filter((e) => e.organizationId === orgId);
    assert.equal(rawLogs.length, 2);

    // Verify normalized payment was NOT duplicated
    const payments = dbStore.normalizedPayments;
    assert.equal(payments.size, 1);
  });

  it('performs Tier 2 customer phone heuristic matching when reference is not in memo', async () => {
    const invoice = reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-OCT-9901',
      totalAmountCents: 5000000n, // 50,000 TZS
      customerPhone: '+255713888999',
      customerName: 'Amina Salum',
    });

    // Notification contains different provider reference (Mixx 98765432101), but matching customer phone & exact balance
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

    const updatedInvoice = reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(updatedInvoice?.status, InvoiceStatus.PAID);
  });

  it('handles underpayment by marking invoice PARTIALLY_PAID', async () => {
    const invoice = reconciliationService.createInvoice(orgId, {
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

    const updatedInvoice = reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(updatedInvoice?.status, InvoiceStatus.PARTIALLY_PAID);
    assert.equal(updatedInvoice?.paidAmountCents, 4000000n);
  });

  it('routes overpayment to REVIEW_REQUIRED without silent settlement', async () => {
    const invoice = reconciliationService.createInvoice(orgId, {
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

    const updatedInvoice = reconciliationService.findInvoiceById(orgId, invoice.id);
    assert.equal(updatedInvoice?.status, InvoiceStatus.OVERPAID);

    // Verify outbox emitted review required event
    const outbox = dbStore.outboxEvents.filter((e) => e.organizationId === orgId);
    assert.equal(outbox.some((e) => e.eventType === 'payment.needs_review'), true);
  });

  it('routes ambiguous multiple open invoices for the same phone to REVIEW_REQUIRED', async () => {
    // Two distinct open invoices for the same customer phone
    reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-A-101',
      totalAmountCents: 2000000n,
      customerPhone: '+255754999000',
    });
    reconciliationService.createInvoice(orgId, {
      referenceNumber: 'INV-B-202',
      totalAmountCents: 2000000n,
      customerPhone: '+255754999000',
    });

    // Notification does not specify invoice reference
    const rawPayload = 'QA88HH99II Imethibitishwa. Umepokea Tsh20,000 kutoka kwa Hamisi Ally 255754999000 tarehe 05/11/2026 saa 12:00.';

    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.ANDROID_NOTIFICATION_RELAY,
      deviceId,
      senderAddress: 'M-PESA',
      rawPayload,
      deviceTimestamp: new Date('2026-11-05T12:00:00Z'),
    });

    // Strict non-guesswork rule: Must route to REVIEW_REQUIRED
    assert.equal(ack.state, TransactionState.REVIEW_REQUIRED);
    assert.equal(ack.matchedInvoiceId, undefined);
  });
});
