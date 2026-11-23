import { randomUUID } from 'node:crypto';
import { BillingInterval, FeatureKey, SubscriptionStatus } from '@brisksms/shared';
import { dbStore } from '../../src/core/store.js';

const TEST_PLAN_CODE = 'PLAN_TEST_DEVELOPER';

/**
 * Gives one workspace an active plan that includes the API, webhooks and Zapier, so tests that
 * use API keys or OAuth do not depend on (or change) the shared feature defaults.
 */
export async function grantDeveloperPlan(organizationId: string): Promise<void> {
  let plan = await dbStore.getPlanByCode(TEST_PLAN_CODE);
  if (!plan) {
    await dbStore.adminCreatePlan({
      productCode: 'PROD_PAYMENT_INTEL',
      code: TEST_PLAN_CODE,
      name: 'Test developer plan',
      isPublic: false,
      prices: [{ currency: 'TZS', amountCents: 0n, billingInterval: BillingInterval.MONTHLY }],
      entitlements: {
        [FeatureKey.API_ACCESS]: 'true',
        [FeatureKey.WEBHOOK_ACCESS]: 'true',
        [FeatureKey.ZAPIER_INTEGRATION]: 'true',
      },
    });
    plan = await dbStore.getPlanByCode(TEST_PLAN_CODE);
  }
  const version = await dbStore.getActivePlanVersion(plan!.id);
  const now = new Date();
  await dbStore.saveSubscription({
    id: randomUUID(),
    organizationId,
    planVersionId: version!.id,
    status: SubscriptionStatus.ACTIVE,
    currency: 'TZS',
    unitPriceCents: 0n,
    billingInterval: BillingInterval.MONTHLY,
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
    trialEndsAt: null,
    canceledAt: null,
    cancelAtPeriodEnd: false,
    createdAt: now,
    updatedAt: now,
  });
}
