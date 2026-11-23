import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from '@brisksms/db';
import { BillingInterval, BriskError } from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { subscriptionService, BILLING_WORKSPACE_SETTING } from '../src/modules/subscription/subscription.service.js';

describe('Subscription payments are verified in the billing workspace, not the customer workspace', () => {
  let billingOrgId: string;
  let customerOrgId: string;
  let customerUserId: string;
  let otherOrgId: string;
  let otherUserId: string;

  const seedStk = async (organizationId: string, providerRef: string, amountCents: number) => {
    await sql`
      INSERT INTO "stk_push_transactions" (
        "id", "organization_id", "provider", "phone_number",
        "amount_cents", "currency", "status", "provider_reference"
      )
      VALUES (
        ${randomUUID()}, ${organizationId}, 'MPESA'::"PaymentProvider", '255754000001',
        ${amountCents}, 'TZS', 'SUCCESS'::"StkPushStatus", ${providerRef}
      )
    `;
  };

  const checkout = (organizationId: string, userId: string, ref: string) =>
    subscriptionService.checkoutSubscription(organizationId, userId, {
      planCode: 'PLAN_GROWTH',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
      paymentMethodRef: ref,
    });

  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (e: unknown) => (e instanceof BriskError ? e.code : String(e)),
    );

  beforeEach(async () => {
    await dbStore.reset();
    const mk = async (email: string, org: string) => {
      const reg = await authService.register({
        email,
        password: 'Password123!',
        fullName: 'Owner',
        organizationName: org,
      });
      return { orgId: reg.organizationId!, userId: reg.user.id };
    };
    billingOrgId = (await mk('billing@brisksms.app', 'BriskSMS Billing')).orgId;
    ({ orgId: customerOrgId, userId: customerUserId } = await mk('customer@example.co.tz', 'Customer Shop'));
    ({ orgId: otherOrgId, userId: otherUserId } = await mk('other@example.co.tz', 'Other Shop'));
  });

  it('fails closed with a clear error when no billing workspace is configured', async () => {
    await seedStk(customerOrgId, 'PAY-NOCONFIG-1', 6500000);
    assert.equal(await outcome(checkout(customerOrgId, customerUserId, 'PAY-NOCONFIG-1')), 'BILLING_NOT_CONFIGURED');
  });

  it("rejects evidence that sits in the paying customer's own workspace", async () => {
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, billingOrgId);
    await seedStk(customerOrgId, 'PAY-OWN-1', 6500000);
    assert.equal(await outcome(checkout(customerOrgId, customerUserId, 'PAY-OWN-1')), 'PAYMENT_VERIFICATION_REQUIRED');
    assert.equal(await dbStore.getOrganizationSubscription(customerOrgId), null);
  });

  it('activates the plan from evidence received by the billing workspace', async () => {
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, billingOrgId);
    await seedStk(billingOrgId, 'PAY-BILL-1', 6500000);
    const sub = await checkout(customerOrgId, customerUserId, 'PAY-BILL-1');
    assert.equal(sub.status, 'ACTIVE');
  });

  it('rejects an underpayment', async () => {
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, billingOrgId);
    await seedStk(billingOrgId, 'PAY-LOW-1', 100);
    assert.equal(await outcome(checkout(customerOrgId, customerUserId, 'PAY-LOW-1')), 'PAYMENT_VERIFICATION_REQUIRED');
  });

  it('lets one payment fund only one workspace', async () => {
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, billingOrgId);
    await seedStk(billingOrgId, 'PAY-ONCE-1', 6500000);
    assert.equal(await outcome(checkout(customerOrgId, customerUserId, 'PAY-ONCE-1')), 'OK');
    assert.equal(await outcome(checkout(otherOrgId, otherUserId, 'PAY-ONCE-1')), 'PAYMENT_REFERENCE_ALREADY_USED');
  });

  it('activates exactly one of two concurrent checkouts on the same payment', async () => {
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, billingOrgId);
    await seedStk(billingOrgId, 'PAY-RACE-1', 6500000);
    const results = await Promise.all([
      outcome(checkout(customerOrgId, customerUserId, 'PAY-RACE-1')),
      outcome(checkout(otherOrgId, otherUserId, 'PAY-RACE-1')),
    ]);
    assert.deepEqual([...results].sort(), ['OK', 'PAYMENT_REFERENCE_ALREADY_USED']);
  });
});
