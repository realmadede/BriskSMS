import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@brisksms/db';
import {
  BillingInterval,
  BriskError,
  EvidenceSourceType,
  InvoiceStatus,
  SubscriptionStatus,
  TransactionState,
  VerificationMethod,
} from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { IngestionService } from '../src/modules/ingestion/ingestion.service.js';
import { billingRequestService } from '../src/modules/subscription/billing-request.service.js';
import {
  BILLING_INSTRUCTIONS_SETTING,
  BILLING_WORKSPACE_SETTING,
} from '../src/modules/subscription/subscription.service.js';

describe('A customer plan payment is matched, verified and activated by the normal reconciliation engine', () => {
  const reconService = new ReconciliationService();
  const ingestionService = new IngestionService(reconService);
  let billingOrgId: string;
  let financeUserId: string;
  let customerOrgId: string;
  let customerUserId: string;
  let otherOrgId: string;
  let otherUserId: string;

  const request = (planCode = 'PLAN_GROWTH', orgId = customerOrgId, userId = customerUserId, payerPhone?: string) =>
    billingRequestService.createRequest(orgId, userId, {
      planCode,
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
      payerPhone,
    });

  /** The SMS BriskSMS's own relay would receive when a customer pays. */
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

  const subscriptionOf = (orgId: string) => dbStore.getOrganizationSubscription(orgId);
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
    ({ orgId: otherOrgId, userId: otherUserId } = await mk('other@example.co.tz', 'Other Shop'));
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, billingOrgId);
    await dbStore.setPlatformSetting(BILLING_INSTRUCTIONS_SETTING, 'Pay to M-Pesa 255700000000 (BriskSMS)');
  });

  it('creates an unpaid invoice in the billing workspace with the price the customer chose', async () => {
    const r = await request('PLAN_GROWTH', customerOrgId, customerUserId, '255754999888');
    assert.equal(r.status, 'PENDING');
    assert.match(r.referenceNumber, /^SUB[A-Z2-9]{7}$/);
    assert.equal(r.instructions, 'Pay to M-Pesa 255700000000 (BriskSMS)');

    const inv = await billingInvoice(r.referenceNumber);
    assert.equal(inv.status, InvoiceStatus.UNPAID);
    assert.equal(String(inv.total_amount_cents), r.amountCents);
    assert.equal(inv.customer_phone, '255754999888');
    assert.equal(inv.customer_name, 'Customer Shop');
    assert.equal(await subscriptionOf(customerOrgId), null, 'nothing is active before payment');
  });

  it('returns the same request when asked again for the same plan, and refuses a different plan while one is open', async () => {
    const first = await request();
    const again = await request();
    assert.equal(again.referenceNumber, first.referenceNumber);
    assert.equal(await code(request('PLAN_ENTERPRISE')), 'PAYMENT_REQUEST_EXISTS');
  });

  it('fails closed without a billing workspace, and for a free plan', async () => {
    await dbStore.adminCreatePlan({
      productCode: 'PROD_PAYMENT_INTEL',
      code: 'PLAN_FREE_TEST',
      name: 'Free test',
      isPublic: true,
      prices: [{ currency: 'TZS', billingInterval: BillingInterval.MONTHLY, amountCents: 0n }],
      entitlements: {},
    });
    assert.equal(await code(request('PLAN_FREE_TEST')), 'PAYMENT_NOT_REQUIRED');
    await sql`DELETE FROM "platform_settings" WHERE "key" = ${BILLING_WORKSPACE_SETTING}`;
    assert.equal(await code(request()), 'BILLING_NOT_CONFIGURED');
  });

  it('activates the plan when the payment is matched by its reference and verified, and not before', async () => {
    const r = await request();
    const ack = await pay(billingOrgId, r.referenceNumber, BigInt(r.amountCents), 1);
    assert.equal(ack.state, TransactionState.MATCHED);
    assert.equal(await subscriptionOf(customerOrgId), null, 'a matched SMS alone never activates a plan');

    const result = await verify(ack.paymentId!);
    assert.equal(result.invoice.status, InvoiceStatus.PAID);

    const sub = await subscriptionOf(customerOrgId);
    assert.equal(sub?.status, SubscriptionStatus.ACTIVE);
    assert.equal(String(sub?.unitPriceCents), r.amountCents);
    const [row] = await sql`SELECT "status", "activated_at" FROM "billing_checkout_requests" WHERE "reference_number" = ${r.referenceNumber}`;
    assert.equal(row!.status, 'ACTIVATED');
    assert.ok(row!.activated_at);
    const invoices = await dbStore.getSubscriptionInvoices(customerOrgId);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0]!.isPaid, true);
    assert.equal(invoices[0]!.paymentProviderRef, r.referenceNumber);
  });

  it('keeps the plan inactive after an underpayment and activates it once the balance is paid', async () => {
    const r = await request();
    const part = BigInt(r.amountCents) / 4n;

    const first = await pay(billingOrgId, r.referenceNumber, part, 2);
    assert.equal((await verify(first.paymentId!)).invoice.status, InvoiceStatus.PARTIALLY_PAID);
    assert.equal(await subscriptionOf(customerOrgId), null);

    // A second SMS carries its own provider receipt id; finance attaches it to the open invoice
    const second = await pay(billingOrgId, 'RCPT2BALANCE', BigInt(r.amountCents) - part, 3);
    const invoiceId = (await billingInvoice(r.referenceNumber)).id as string;
    assert.equal((await verify(second.paymentId!, invoiceId)).invoice.status, InvoiceStatus.PAID);
    assert.equal((await subscriptionOf(customerOrgId))?.status, SubscriptionStatus.ACTIVE);
  });

  it('gives the customer the terms they requested even if the price changes before the payment is verified', async () => {
    const r = await request();
    await sql`UPDATE "plan_prices" SET "amount_cents" = "amount_cents" * 2 WHERE "currency" = 'TZS'`;
    const ack = await pay(billingOrgId, r.referenceNumber, BigInt(r.amountCents), 4);
    await verify(ack.paymentId!);
    assert.equal(String((await subscriptionOf(customerOrgId))?.unitPriceCents), r.amountCents);
  });

  it('is not fooled by a payment in the customer\'s own workspace using the same reference', async () => {
    const r = await request();
    const own = await pay(customerOrgId, r.referenceNumber, BigInt(r.amountCents), 5);
    assert.notEqual(own.state, TransactionState.MATCHED);
    assert.equal(await subscriptionOf(customerOrgId), null);
    const [row] = await sql`SELECT "status" FROM "billing_checkout_requests" WHERE "reference_number" = ${r.referenceNumber}`;
    assert.equal(row!.status, 'PENDING');
  });

  it('activates only once even if verification is attempted again', async () => {
    const r = await request();
    const ack = await pay(billingOrgId, r.referenceNumber, BigInt(r.amountCents), 6);
    await verify(ack.paymentId!);
    await assert.rejects(verify(ack.paymentId!), /ALREADY_VERIFIED|already VERIFIED/);
    assert.equal((await dbStore.getSubscriptionInvoices(customerOrgId)).length, 1);
  });

  it('lets two workspaces pay for plans at the same time without crossing', async () => {
    const a = await request('PLAN_GROWTH', customerOrgId, customerUserId);
    const b = await request('PLAN_GROWTH', otherOrgId, otherUserId);
    assert.notEqual(a.referenceNumber, b.referenceNumber);
    await verify((await pay(billingOrgId, b.referenceNumber, BigInt(b.amountCents), 7)).paymentId!);
    assert.equal((await subscriptionOf(otherOrgId))?.status, SubscriptionStatus.ACTIVE);
    assert.equal(await subscriptionOf(customerOrgId), null);
  });

  it('cancels an unpaid request, voids its invoice, and allows a new request', async () => {
    const r = await request();
    await billingRequestService.cancelRequest(customerOrgId, customerUserId);
    assert.equal((await billingInvoice(r.referenceNumber)).status, InvoiceStatus.VOID);
    assert.equal((await billingRequestService.getCurrentRequest(customerOrgId))?.status, 'CANCELLED');
    assert.equal(await code(billingRequestService.cancelRequest(customerOrgId, customerUserId)), 'NO_PENDING_REQUEST');
    const next = await request('PLAN_ENTERPRISE');
    assert.notEqual(next.referenceNumber, r.referenceNumber);
  });

  it('refuses to cancel once a payment has arrived for the request', async () => {
    const r = await request();
    await pay(billingOrgId, r.referenceNumber, BigInt(r.amountCents), 8);
    assert.equal(await code(billingRequestService.cancelRequest(customerOrgId, customerUserId)), 'PAYMENT_ALREADY_RECEIVED');
    assert.equal((await billingInvoice(r.referenceNumber)).status, InvoiceStatus.UNPAID);
  });
});
