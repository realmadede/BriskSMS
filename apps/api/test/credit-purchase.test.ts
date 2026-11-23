import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@brisksms/db';
import {
  BriskError,
  CreditLedgerEntryType,
  EvidenceSourceType,
  InvoiceStatus,
  TransactionState,
  VerificationMethod,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { messagingService } from '../src/modules/messaging/messaging.service.js';
import { creditPackService, CreditPackDto } from '../src/modules/messaging/credit-pack.service.js';
import { creditPurchaseService } from '../src/modules/messaging/credit-purchase.service.js';
import { billingRequestService } from '../src/modules/subscription/billing-request.service.js';
import { BillingInterval } from '@brisksms/shared';
import {
  BILLING_INSTRUCTIONS_SETTING,
  BILLING_WORKSPACE_SETTING,
} from '../src/modules/subscription/subscription.service.js';

describe('A customer credit purchase is matched, verified and credited by the normal reconciliation engine', () => {
  const reconService = new ReconciliationService();
  const ingestionService = new IngestionService(reconService);
  let billingOrgId: string;
  let financeUserId: string;
  let customerOrgId: string;
  let customerUserId: string;
  let otherOrgId: string;
  let pack: CreditPackDto;
  let bigPack: CreditPackDto;

  const request = (packId = pack.id, orgId = customerOrgId, userId = customerUserId) =>
    creditPurchaseService.createRequest(orgId, userId, { packId });

  const pay = (organizationId: string, reference: string, cents: bigint, minute: number) =>
    ingestionService.ingestEvidence({
      organizationId,
      sourceType: EvidenceSourceType.DIRECT_PROVIDER_API,
      senderAddress: 'M-PESA',
      rawPayload: `${reference} Imethibitishwa. Umepokea Tsh${(Number(cents) / 100).toLocaleString('en-US')} kutoka kwa Kariakoo Owner 255754999888 tarehe 05/11/2026 saa 14:${String(minute).padStart(2, '0')}.`,
      deviceTimestamp: new Date(`2026-11-05T14:${String(minute).padStart(2, '0')}:00Z`),
    });

  const verify = (paymentId: string, invoiceId?: string) =>
    reconService.verifyPayment(billingOrgId, {
      paymentId,
      invoiceId,
      verificationMethod: VerificationMethod.MANUAL_FINANCE_APPROVAL,
      verifiedById: financeUserId,
    });

  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: unknown) => (e instanceof BriskError ? e.code : String(e)),
    );

  const balance = async (orgId: string) => (await messagingService.getAccountBalances(orgId)).creditBalance;
  const purchases = async (orgId: string) =>
    (await messagingService.listLedgerEntries(orgId)).filter((e) => e.entryType === CreditLedgerEntryType.PURCHASE);
  const billingInvoice = async (ref: string) =>
    (await sql`SELECT * FROM "invoices" WHERE "organization_id" = ${billingOrgId} AND "reference_number" = ${ref}`)[0]!;

  beforeEach(async () => {
    await dbStore.reset();
    const mk = async (email: string, org: string) => {
      const reg = await authService.register({ email, password: 'Password123!', fullName: 'Owner', organizationName: org });
      return { orgId: reg.organizationId!, userId: reg.user.id };
    };
    ({ orgId: billingOrgId, userId: financeUserId } = await mk('billing@brisksms.app', 'BriskSMS Billing'));
    ({ orgId: customerOrgId, userId: customerUserId } = await mk('customer@example.co.tz', 'Customer Shop'));
    ({ orgId: otherOrgId } = await mk('other@example.co.tz', 'Other Shop'));
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, billingOrgId);
    await dbStore.setPlatformSetting(BILLING_INSTRUCTIONS_SETTING, 'Pay to M-Pesa 255700000000 (BriskSMS)');
    pack = await creditPackService.create({ code: 'SMS_1000', name: '1,000 credits', credits: 1000, currency: 'TZS', amountCents: 2_500_000n });
    bigPack = await creditPackService.create({ code: 'SMS_5000', name: '5,000 credits', credits: 5000, currency: 'TZS', amountCents: 10_000_000n });
  });

  it('creates an unpaid invoice in the billing workspace for the pack price and adds no credits yet', async () => {
    const r = await request();
    assert.equal(r.status, 'PENDING');
    assert.match(r.referenceNumber, /^CRD[A-Z2-9]{7}$/);
    assert.equal(r.credits, 1000);
    assert.equal(r.instructions, 'Pay to M-Pesa 255700000000 (BriskSMS)');
    const inv = await billingInvoice(r.referenceNumber);
    assert.equal(inv.status, InvoiceStatus.UNPAID);
    assert.equal(String(inv.total_amount_cents), '2500000');
    assert.equal(await balance(customerOrgId), 0);
  });

  it('credits the workspace exactly once when the payment is matched and verified, and not before', async () => {
    const r = await request();
    const ack = await pay(billingOrgId, r.referenceNumber, BigInt(r.amountCents), 1);
    assert.equal(ack.state, TransactionState.MATCHED);
    assert.equal(await balance(customerOrgId), 0, 'a matched SMS alone never adds credits');

    assert.equal((await verify(ack.paymentId!)).invoice.status, InvoiceStatus.PAID);
    assert.equal(await balance(customerOrgId), 1000);
    const entries = await purchases(customerOrgId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.amountCredits, 1000);
    assert.equal(entries[0]!.balanceAfter, 1000);
    assert.equal(entries[0]!.referenceId, r.referenceNumber);

    await assert.rejects(verify(ack.paymentId!), /ALREADY_VERIFIED|already VERIFIED/);
    assert.equal(await balance(customerOrgId), 1000);
    const [row] = await sql`SELECT "status" FROM "credit_purchases" WHERE "reference_number" = ${r.referenceNumber}`;
    assert.equal(row!.status, 'ACTIVATED');
  });

  it('adds the pack on top of the existing balance', async () => {
    await messagingService.purchaseCredits(customerOrgId, 250, 'EARLIER');
    const r = await request();
    await verify((await pay(billingOrgId, r.referenceNumber, BigInt(r.amountCents), 2)).paymentId!);
    const entries = await purchases(customerOrgId);
    assert.equal(await balance(customerOrgId), 1250);
    assert.equal(entries[entries.length - 1]!.balanceAfter, 1250);
  });

  it('adds nothing after an underpayment and credits once the balance is paid', async () => {
    const r = await request();
    const part = BigInt(r.amountCents) / 4n;
    const first = await pay(billingOrgId, r.referenceNumber, part, 3);
    assert.equal((await verify(first.paymentId!)).invoice.status, InvoiceStatus.PARTIALLY_PAID);
    assert.equal(await balance(customerOrgId), 0);

    const second = await pay(billingOrgId, 'RCPT2BALANCE', BigInt(r.amountCents) - part, 4);
    const invoiceId = (await billingInvoice(r.referenceNumber)).id as string;
    assert.equal((await verify(second.paymentId!, invoiceId)).invoice.status, InvoiceStatus.PAID);
    assert.equal(await balance(customerOrgId), 1000);
    assert.equal((await purchases(customerOrgId)).length, 1);
  });

  it('keeps the terms the customer requested when the pack is edited or switched off afterwards', async () => {
    const r = await request();
    await creditPackService.update(pack.id, { code: 'SMS_1000', name: 'Renamed', credits: 10, currency: 'TZS', amountCents: 9_900_000n, isActive: false });
    assert.equal(await code(request(pack.id, otherOrgId, customerUserId)), 'PACK_UNAVAILABLE', 'a switched-off pack cannot be requested');

    await verify((await pay(billingOrgId, r.referenceNumber, 2_500_000n, 5)).paymentId!);
    assert.equal(await balance(customerOrgId), 1000, 'the customer gets what they were quoted');
  });

  it('is not fooled by a payment in the customer\'s own workspace using the same reference', async () => {
    const r = await request();
    const own = await pay(customerOrgId, r.referenceNumber, BigInt(r.amountCents), 6);
    assert.notEqual(own.state, TransactionState.MATCHED);
    assert.equal(await balance(customerOrgId), 0);
    const [row] = await sql`SELECT "status" FROM "credit_purchases" WHERE "reference_number" = ${r.referenceNumber}`;
    assert.equal(row!.status, 'PENDING');
  });

  it('credits only the workspace that asked when two buy at once', async () => {
    const a = await request(pack.id, customerOrgId, customerUserId);
    const otherUser = (await sql`SELECT "user_id" FROM "users_organizations" WHERE "organization_id" = ${otherOrgId} LIMIT 1`)[0]!.user_id as string;
    const b = await request(bigPack.id, otherOrgId, otherUser);
    assert.notEqual(a.referenceNumber, b.referenceNumber);
    await verify((await pay(billingOrgId, b.referenceNumber, BigInt(b.amountCents), 7)).paymentId!);
    assert.equal(await balance(otherOrgId), 5000);
    assert.equal(await balance(customerOrgId), 0);
  });

  it('returns the same request for the same pack and refuses another pack while one is open', async () => {
    const first = await request();
    assert.equal((await request()).referenceNumber, first.referenceNumber);
    assert.equal(await code(request(bigPack.id)), 'PURCHASE_REQUEST_EXISTS');
  });

  it('does not touch the subscription, and a plan request and a credit request can be open together', async () => {
    const credit = await request();
    const plan = await billingRequestService.createRequest(customerOrgId, customerUserId, {
      planCode: 'PLAN_GROWTH',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
    assert.notEqual(credit.referenceNumber, plan.referenceNumber);
    await verify((await pay(billingOrgId, credit.referenceNumber, BigInt(credit.amountCents), 8)).paymentId!);
    assert.equal(await balance(customerOrgId), 1000);
    assert.equal(await dbStore.getOrganizationSubscription(customerOrgId), null, 'paying for credits never activates a plan');
    const [row] = await sql`SELECT "status" FROM "billing_checkout_requests" WHERE "reference_number" = ${plan.referenceNumber}`;
    assert.equal(row!.status, 'PENDING');
  });

  it('cancels an unpaid request and voids its invoice, but not once a payment has arrived', async () => {
    const r = await request();
    await creditPurchaseService.cancelRequest(customerOrgId, customerUserId);
    assert.equal((await billingInvoice(r.referenceNumber)).status, InvoiceStatus.VOID);
    assert.equal(await code(creditPurchaseService.cancelRequest(customerOrgId, customerUserId)), 'NO_PENDING_REQUEST');

    const next = await request(bigPack.id);
    await pay(billingOrgId, next.referenceNumber, BigInt(next.amountCents), 9);
    assert.equal(await code(creditPurchaseService.cancelRequest(customerOrgId, customerUserId)), 'PAYMENT_ALREADY_RECEIVED');
  });

  it('fails closed without a billing workspace', async () => {
    await sql`DELETE FROM "platform_settings" WHERE "key" = ${BILLING_WORKSPACE_SETTING}`;
    assert.equal(await code(request()), 'BILLING_NOT_CONFIGURED');
  });

  it('validates packs and keeps codes unique', async () => {
    const base = { code: 'SMS_X', name: 'X', credits: 10, currency: 'TZS', amountCents: 100n };
    assert.equal(await code(creditPackService.create({ ...base, code: 'SMS_1000' })), 'PACK_CODE_EXISTS');
    assert.equal(await code(creditPackService.create({ ...base, credits: 0 })), 'VALIDATION_ERROR');
    assert.equal(await code(creditPackService.create({ ...base, amountCents: 0n })), 'VALIDATION_ERROR');
    assert.equal(await code(creditPackService.create({ ...base, currency: 'tz' })), 'VALIDATION_ERROR');
    assert.equal(await code(creditPackService.update(bigPack.id, { ...base, code: 'SMS_1000' })), 'PACK_CODE_EXISTS');
    assert.deepEqual((await creditPackService.list(true)).map((p) => p.code), ['SMS_1000', 'SMS_5000']);
  });
});
