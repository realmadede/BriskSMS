import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BillingInterval,
  CreditLedgerEntryType,
  EvidenceSourceType,
  FeatureKey,
  InvoiceStatus,
  TransactionState,
  VerificationMethod,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { MessagingService } from '../src/modules/messaging/messaging.service.js';
import { SubscriptionService } from '../src/modules/subscription/subscription.service.js';
import { CatalogService } from '../src/modules/subscription/catalog.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';

describe('Milestone 1: Concurrency Safety, Ledger Separation & Financial Invariants', () => {
  const authService = new AuthService();
  const messagingService = new MessagingService();
  const subService = new SubscriptionService();
  const catalogService = new CatalogService();
  const reconService = new ReconciliationService();
  const ingestionService = new IngestionService(reconService);

  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    await dbStore.reset();
    const reg = await authService.register({
      email: 'finance-lead@dar-isp.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Finance Lead',
      organizationName: 'Dar Fiber Telecom',
    });
    orgId = reg.organizationId!;
    userId = reg.user.id;
  });

  it('prevents double-spending under concurrent SMS credit reservations (SELECT ... FOR UPDATE serialization)', async () => {
    // Organization purchases 100 prepaid SMS credits
    await messagingService.purchaseCredits(orgId, 100, 'TOPUP-100');

    // Launch 5 concurrent reservation requests of 30 credits each (total requested = 150, available = 100)
    // At most 3 requests (90 credits) may succeed; 2 requests MUST fail with InsufficientCreditsError
    const results = await Promise.allSettled([
      messagingService.reserveCredits(orgId, 30, 'CONCURRENT-RES-1'),
      messagingService.reserveCredits(orgId, 30, 'CONCURRENT-RES-2'),
      messagingService.reserveCredits(orgId, 30, 'CONCURRENT-RES-3'),
      messagingService.reserveCredits(orgId, 30, 'CONCURRENT-RES-4'),
      messagingService.reserveCredits(orgId, 30, 'CONCURRENT-RES-5'),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(succeeded.length, 3, 'Exactly 3 reservations of 30 credits should succeed out of 100 available');
    assert.equal(rejected.length, 2, '2 reservations must be rejected due to insufficient credits');

    const balances = await messagingService.getAccountBalances(orgId);
    assert.equal(balances.creditBalance, 10, 'Remaining available credit balance must be exactly 10');
    assert.equal(balances.reservedCredits, 90, 'Reserved credits must be exactly 90');
  });

  it('maintains exact ledger accounting across purchase, reservation, release, commit, and refund', async () => {
    await messagingService.purchaseCredits(orgId, 50, 'PURCHASE-50');
    await messagingService.reserveCredits(orgId, 20, 'RESERVE-20');

    let bal = await messagingService.getAccountBalances(orgId);
    assert.equal(bal.creditBalance, 30);
    assert.equal(bal.reservedCredits, 20);

    // Release 5 reserved credits back to available balance
    await messagingService.releaseReservedCredits(orgId, 5, 'RELEASE-5');
    bal = await messagingService.getAccountBalances(orgId);
    assert.equal(bal.creditBalance, 35);
    assert.equal(bal.reservedCredits, 15);

    // Commit 15 reserved credits as usage deduction
    await messagingService.commitReservedCredits(orgId, 15, 'COMMIT-15');
    bal = await messagingService.getAccountBalances(orgId);
    assert.equal(bal.creditBalance, 35);
    assert.equal(bal.reservedCredits, 0);

    // Refund 5 credits
    await messagingService.refundCredits(orgId, 5, 'REFUND-5');
    bal = await messagingService.getAccountBalances(orgId);
    assert.equal(bal.creditBalance, 40);

    const ledger = await messagingService.listLedgerEntries(orgId);
    assert.equal(ledger.length, 5);
    assert.deepEqual(
      ledger.map((e) => e.entryType),
      [
        CreditLedgerEntryType.PURCHASE,
        CreditLedgerEntryType.RESERVATION,
        CreditLedgerEntryType.RELEASE,
        CreditLedgerEntryType.USAGE_DEDUCTION,
        CreditLedgerEntryType.REFUND,
      ],
    );
  });

  it('enforces complete ledger separation between SaaS subscriptions and prepaid SMS credits', async () => {
    // Purchase 500 SMS credits
    await messagingService.purchaseCredits(orgId, 500, 'SMS-PACK-500');

    // Checkout Growth SaaS subscription
    await subService.checkoutSubscription(orgId, userId, {
      planCode: 'PLAN_GROWTH',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
      paymentMethodRef: 'SUB-PAY-001',
    });

    // SMS credit balance and ledger must remain untouched by SaaS subscription checkout
    assert.equal(await messagingService.getCreditBalance(orgId), 500);
    const smsLedger = await messagingService.listLedgerEntries(orgId);
    assert.equal(smsLedger.length, 1);

    // Historical subscription invoice snapshot remains immutable when plan prices change
    const subInvoicesBefore = await dbStore.getSubscriptionInvoices(orgId);
    assert.equal(subInvoicesBefore.length, 1);
    assert.equal(subInvoicesBefore[0]!.amountCents, 6500000n);

    await catalogService.adminCreateNewPlanVersion('PLAN_GROWTH', {
      prices: [{ currency: 'TZS', amountCents: '9500000', billingInterval: BillingInterval.MONTHLY }],
      entitlements: { [FeatureKey.MAX_CONNECTED_DEVICES]: '5' },
    });

    const subInvoicesAfter = await dbStore.getSubscriptionInvoices(orgId);
    assert.equal(subInvoicesAfter[0]!.amountCents, 6500000n, 'Historical billing invoice snapshot must never change');
  });

  it('enforces the 6-stage Payment Intelligence lifecycle and supports auditable rejection of fraudulent notifications', async () => {
    const invoice = await reconService.createInvoice(orgId, {
      referenceNumber: 'QA88FIN202',
      totalAmountCents: 25000000n, // 250,000 TZS
    });

    // Stage 1 & 2 & 3: Notification ingested -> OBSERVED -> NORMALIZED -> MATCHED candidate
    const ack = await ingestionService.ingestEvidence({
      organizationId: orgId,
      sourceType: EvidenceSourceType.DIRECT_PROVIDER_API,
      senderAddress: 'M-PESA',
      rawPayload: 'QA88FIN202 Imethibitishwa. Umepokea Tsh250,000 kutoka kwa Suspect Sender 255754999888 tarehe 05/11/2026 saa 14:00.',
      deviceTimestamp: new Date('2026-11-05T14:00:00Z'),
    });

    assert.equal(ack.state, TransactionState.MATCHED);

    // Invoice MUST still be UNPAID prior to independent/manual verification
    const checkUnpaid = await reconService.findInvoiceById(orgId, invoice.id);
    assert.equal(checkUnpaid?.status, InvoiceStatus.UNPAID);
    assert.equal(checkUnpaid?.paidAmountCents, 0n);

    // Finance officer rejects the unverified payment after bank statement check fails
    const rejection = await reconService.rejectPayment(orgId, {
      paymentId: ack.paymentId!,
      verifiedById: userId,
      notes: 'Transaction reference not found on official M-Pesa statement',
    });

    assert.equal(rejection.payment.state, TransactionState.REJECTED);
    assert.equal(rejection.verification.decision, 'REJECTED');

    // Rejected payment cannot subsequently be verified
    await assert.rejects(
      () =>
        reconService.verifyPayment(orgId, {
          paymentId: ack.paymentId!,
          invoiceId: invoice.id,
          verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
          verifiedById: userId,
        }),
      /cannot be verified from terminal state 'REJECTED'/,
    );
  });
});
