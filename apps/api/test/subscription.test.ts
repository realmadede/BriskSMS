import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dbStore } from '../src/core/store.js';
import { catalogService } from '../src/modules/subscription/catalog.service.js';
import { subscriptionService } from '../src/modules/subscription/subscription.service.js';
import { entitlementService } from '../src/modules/subscription/entitlement.service.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { deviceService } from '../src/modules/device/device.service.js';
import {
  BillingInterval,
  SubscriptionStatus,
  FeatureKey,
  QuotaExceededError,
  PlanNotFoundError,
} from '@brisksms/shared';

describe('Phase 2: Dynamic Subscription Catalog & Entitlements Engine', () => {
  beforeEach(() => {
    dbStore.reset();
  });

  it('should dynamically retrieve public commercial catalog with multi-currency prices and entitlements', async () => {
    const products = catalogService.getPublicCatalog();

    assert.ok(products.length >= 2, 'Should contain at least Product A and Product B');
    const paymentProduct = products.find((p) => p.code === 'PROD_PAYMENT_INTEL');
    assert.ok(paymentProduct, 'Payment Intelligence product must exist');
    assert.equal(paymentProduct.isActive, true);

    // Verify plans under Product A
    assert.ok(paymentProduct.plans && paymentProduct.plans.length >= 3, 'Must contain Starter, Growth, Enterprise plans');
    const starterPlan = paymentProduct.plans.find((p) => p.code === 'PLAN_STARTER');
    assert.ok(starterPlan, 'Starter plan must exist');
    assert.equal(starterPlan.name, 'Starter Business');

    // Verify multi-currency prices (TZS and USD in integer minor units)
    const prices = starterPlan.currentVersion?.prices;
    assert.ok(prices && prices.length >= 2, 'Must have at least TZS and USD prices');

    const tzsMonthly = prices.find((p) => p.currency === 'TZS' && p.billingInterval === BillingInterval.MONTHLY);
    assert.ok(tzsMonthly);
    assert.equal(tzsMonthly.amountCents, '2500000'); // TZS 25,000.00

    const usdMonthly = prices.find((p) => p.currency === 'USD' && p.billingInterval === BillingInterval.MONTHLY);
    assert.ok(usdMonthly);
    assert.equal(usdMonthly.amountCents, '1000'); // $10.00

    // Verify entitlements
    const entitlements = starterPlan.currentVersion?.entitlements;
    assert.ok(entitlements && entitlements.length > 0);
    const maxDevices = entitlements.find((e) => e.featureKey === FeatureKey.MAX_CONNECTED_DEVICES);
    assert.equal(maxDevices?.value, '1');

    const apiAccess = entitlements.find((e) => e.featureKey === FeatureKey.API_ACCESS);
    assert.equal(apiAccess?.value, 'false');
  });

  it('should checkout a subscription and immutably snapshot the unit price and billing interval', async () => {
    const ownerRes = await authService.register({
      email: 'founder@kinondoni-shop.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Kinondoni Shopkeeper',
      organizationName: 'Kinondoni Retail Mart',
    });
    const orgId = ownerRes.organizationId!;

    // Checkout Growth Plan (TZS, Monthly)
    const subscription = subscriptionService.checkoutSubscription(orgId, ownerRes.user.id, {
      planCode: 'PLAN_GROWTH',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
      paymentMethodRef: 'MPESA-PAY-98124',
    });

    assert.equal(subscription.organizationId, orgId);
    assert.equal(subscription.planCode, 'PLAN_GROWTH');
    assert.equal(subscription.status, SubscriptionStatus.ACTIVE);
    assert.equal(subscription.currency, 'TZS');
    assert.equal(subscription.unitPriceCents, '6500000'); // TZS 65,000.00
    assert.equal(subscription.billingInterval, BillingInterval.MONTHLY);

    // Verify snapshot billing invoice was created with exact amount
    const invoices = dbStore.getSubscriptionInvoices(orgId);
    assert.equal(invoices.length, 1);
    const firstInvoice = invoices[0];
    assert.ok(firstInvoice);
    assert.equal(firstInvoice.amountCents, 6500000n);
    assert.equal(firstInvoice.currency, 'TZS');
    assert.equal(firstInvoice.isPaid, true);
    assert.equal(firstInvoice.paymentProviderRef, 'MPESA-PAY-98124');
  });

  it('should preserve active subscription terms when catalog price or plan version is updated', async () => {
    const ownerRes = await authService.register({
      email: 'supermarket@arusha.co.tz',
      password: 'SuperPassword123!',
      fullName: 'Arusha Market Owner',
      organizationName: 'Arusha Fresh Supermarket',
    });
    const orgId = ownerRes.organizationId!;

    // 1. Subscribe to Starter Plan at TZS 25,000.00
    const subInitial = subscriptionService.checkoutSubscription(orgId, ownerRes.user.id, {
      planCode: 'PLAN_STARTER',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
    assert.equal(subInitial.unitPriceCents, '2500000');

    // 2. Admin creates Version 2 of PLAN_STARTER with increased price (TZS 35,000.00)
    catalogService.adminCreateNewPlanVersion('PLAN_STARTER', {
      prices: [
        { currency: 'TZS', amountCents: '3500000', billingInterval: BillingInterval.MONTHLY },
        { currency: 'USD', amountCents: '1500', billingInterval: BillingInterval.MONTHLY },
      ],
      entitlements: {
        [FeatureKey.MAX_CONNECTED_DEVICES]: '1',
        [FeatureKey.MAX_ORGANIZATION_MEMBERS]: '3',
      },
    });

    // 3. Verify public catalog reflects Version 2
    const updatedPlan = catalogService.getPlanByCode('PLAN_STARTER');
    assert.equal(updatedPlan.currentVersion.versionNumber, 2);
    const newPrice = updatedPlan.prices.find((p) => p.currency === 'TZS' && p.billingInterval === BillingInterval.MONTHLY);
    assert.equal(newPrice?.amountCents, '3500000');

    // 4. Verify existing active subscription STILL retains its original snapshot terms (Version 1 price)
    const existingSub = subscriptionService.getOrganizationSubscription(orgId);
    assert.ok(existingSub);
    assert.equal(existingSub.unitPriceCents, '2500000', 'Active subscription price must NOT change when catalog is updated');
  });

  it('should dynamically enforce device quotas and allow scaling upon plan upgrade', async () => {
    const ownerRes = await authService.register({
      email: 'tech@fastnet.co.tz',
      password: 'TechPassword123!',
      fullName: 'FastNet ISP Admin',
      organizationName: 'FastNet ISP Ltd',
    });
    const orgId = ownerRes.organizationId!;

    // Subscribe to Starter Plan (MAX_CONNECTED_DEVICES = 1)
    subscriptionService.checkoutSubscription(orgId, ownerRes.user.id, {
      planCode: 'PLAN_STARTER',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });

    // Device 1: Pairing should succeed
    const pair1 = await deviceService.createPairingToken(orgId, ownerRes.user.id);
    await deviceService.pairDevice({
      enrollmentToken: pair1.pairingToken,
      deviceModel: 'Samsung Galaxy A15',
      manufacturer: 'Samsung',
      androidVersion: '14',
      appVersion: '1.0.0',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...\n-----END PUBLIC KEY-----',
    });

    // Device 2: Attempting to pair a second device must be rejected with QuotaExceededError
    await assert.rejects(
      deviceService.createPairingToken(orgId, ownerRes.user.id),
      (err: unknown) => {
        assert.ok(err instanceof QuotaExceededError);
        assert.equal(err.statusCode, 429);
        assert.match(err.message, /Maximum allowed: 1/);
        return true;
      },
    );

    // Organization upgrades to Growth Plan (MAX_CONNECTED_DEVICES = 3)
    subscriptionService.checkoutSubscription(orgId, ownerRes.user.id, {
      planCode: 'PLAN_GROWTH',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });

    // Device 2: Pairing token generation should now succeed under new quota
    const pair2 = await deviceService.createPairingToken(orgId, ownerRes.user.id);
    assert.ok(pair2.pairingToken, 'Pairing token must be issued after plan upgrade');
  });

  it('should dynamically resolve boolean feature entitlements across tiers', async () => {
    const ownerRes = await authService.register({
      email: 'director@agrotrade.co.tz',
      password: 'DirectorPass123!',
      fullName: 'Agro Director',
      organizationName: 'Agro Trade TZ',
    });
    const orgId = ownerRes.organizationId!;

    // On Free/Default tier: Zapier and API access are disabled
    assert.equal(entitlementService.isFeatureEnabled(orgId, FeatureKey.API_ACCESS), false);
    assert.equal(entitlementService.isFeatureEnabled(orgId, FeatureKey.ZAPIER_INTEGRATION), false);

    // Upgrade to Growth Plan: API and Zapier access are enabled
    subscriptionService.checkoutSubscription(orgId, ownerRes.user.id, {
      planCode: 'PLAN_GROWTH',
      currency: 'USD',
      billingInterval: BillingInterval.MONTHLY,
    });

    assert.equal(entitlementService.isFeatureEnabled(orgId, FeatureKey.API_ACCESS), true);
    assert.equal(entitlementService.isFeatureEnabled(orgId, FeatureKey.ZAPIER_INTEGRATION), true);
    assert.equal(entitlementService.isFeatureEnabled(orgId, FeatureKey.MIKROTIK_INTEGRATION), true);

    // Bulk messaging is still disabled on Growth
    assert.equal(entitlementService.isFeatureEnabled(orgId, FeatureKey.BULK_MESSAGING_ENABLED), false);

    // Upgrade to Enterprise: Bulk messaging is enabled
    subscriptionService.checkoutSubscription(orgId, ownerRes.user.id, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'USD',
      billingInterval: BillingInterval.ANNUALLY,
    });

    assert.equal(entitlementService.isFeatureEnabled(orgId, FeatureKey.BULK_MESSAGING_ENABLED), true);
  });

  it('should isolate subscriptions across tenants', async () => {
    const orgA = await authService.register({
      email: 'tenantA@test.co.tz',
      password: 'PassTenantA123!',
      fullName: 'Tenant A',
      organizationName: 'Tenant A Corp',
    });
    const orgB = await authService.register({
      email: 'tenantB@test.co.tz',
      password: 'PassTenantB123!',
      fullName: 'Tenant B',
      organizationName: 'Tenant B Corp',
    });

    subscriptionService.checkoutSubscription(orgA.organizationId!, orgA.user.id, {
      planCode: 'PLAN_GROWTH',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });

    const subA = subscriptionService.getOrganizationSubscription(orgA.organizationId!);
    const subB = subscriptionService.getOrganizationSubscription(orgB.organizationId!);

    assert.ok(subA);
    assert.equal(subA.planCode, 'PLAN_GROWTH');
    assert.equal(subB, null, 'Tenant B must not see Tenant A subscription');
  });

  it('should reject checkout for non-existent plans', async () => {
    const ownerRes = await authService.register({
      email: 'user@test.co.tz',
      password: 'UserPass123!',
      fullName: 'Test User',
      organizationName: 'Test Org',
    });

    await assert.rejects(
      async () => {
        subscriptionService.checkoutSubscription(ownerRes.organizationId!, ownerRes.user.id, {
          planCode: 'NON_EXISTENT_PLAN',
          currency: 'TZS',
          billingInterval: BillingInterval.MONTHLY,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof PlanNotFoundError);
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });
});
