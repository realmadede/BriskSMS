import { randomUUID } from 'node:crypto';
import {
  BillingInterval,
  SubscriptionStatus,
  CheckoutSubscriptionDto,
  OrganizationSubscriptionDto,
  PlanNotFoundError,
  BriskError,
} from '@brisksms/shared';
import {
  dbStore,
  OrganizationSubscriptionRecord,
  SubscriptionBillingInvoiceRecord,
} from '../../core/store.js';
import { entitlementService } from './entitlement.service.js';

export class SubscriptionService {
  getOrganizationSubscription(organizationId: string): OrganizationSubscriptionDto | null {
    const sub = dbStore.getOrganizationSubscription(organizationId);
    if (!sub) {
      return null;
    }

    const version = dbStore.getPlanVersionById(sub.planVersionId);
    const plan = version ? dbStore.getPlanById(version.planId) : null;
    const entitlements = entitlementService.getEntitlements(organizationId);

    return {
      id: sub.id,
      organizationId: sub.organizationId,
      planVersionId: sub.planVersionId,
      planCode: plan?.code ?? 'UNKNOWN',
      planName: plan?.name ?? 'Subscription Plan',
      status: sub.status,
      currency: sub.currency,
      unitPriceCents: sub.unitPriceCents.toString(),
      billingInterval: sub.billingInterval,
      currentPeriodStart: sub.currentPeriodStart.toISOString(),
      currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
      trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
      canceledAt: sub.canceledAt ? sub.canceledAt.toISOString() : null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      entitlements,
      createdAt: sub.createdAt.toISOString(),
      updatedAt: sub.updatedAt.toISOString(),
    };
  }

  checkoutSubscription(
    organizationId: string,
    actorId: string,
    dto: CheckoutSubscriptionDto,
  ): OrganizationSubscriptionDto {
    const plan = dbStore.getPlanByCode(dto.planCode);
    if (!plan || !plan.isPublic) {
      throw new PlanNotFoundError(dto.planCode);
    }

    const currentVersion = dbStore.getActivePlanVersion(plan.id);
    if (!currentVersion) {
      throw new PlanNotFoundError(`${dto.planCode} (no active version)`);
    }

    // Resolve matching catalog price record
    const prices = dbStore.getPlanPrices(currentVersion.id);
    const matchedPrice = prices.find(
      (p) =>
        p.currency.toUpperCase() === dto.currency.toUpperCase() &&
        p.billingInterval === dto.billingInterval &&
        p.isActive,
    );

    if (!matchedPrice) {
      throw new BriskError(
        'PRICE_NOT_FOUND',
        `No active price configured for plan '${dto.planCode}' with currency '${dto.currency}' and interval '${dto.billingInterval}'.`,
        422,
        { planCode: dto.planCode, currency: dto.currency, billingInterval: dto.billingInterval },
      );
    }

    const now = new Date();
    // Compute subscription period dates
    const periodDays = dto.billingInterval === BillingInterval.ANNUALLY ? 365 : 30;
    const periodStart = now;
    const periodEnd = new Date(now.getTime() + periodDays * 24 * 3600 * 1000);

    // Snapshot exact unit price and terms immutably
    const subId = randomUUID();
    const subscriptionRecord: OrganizationSubscriptionRecord = {
      id: subId,
      organizationId,
      planVersionId: currentVersion.id,
      status: SubscriptionStatus.ACTIVE,
      currency: matchedPrice.currency,
      unitPriceCents: matchedPrice.amountCents, // Immutable price snapshot
      billingInterval: matchedPrice.billingInterval,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
      canceledAt: null,
      cancelAtPeriodEnd: false,
      createdAt: now,
      updatedAt: now,
    };

    dbStore.saveSubscription(subscriptionRecord);

    // Generate snapshot billing invoice
    const invoiceNumber = `INV-SUB-${Date.now().toString(36).toUpperCase()}-${randomUUID().substring(0, 4).toUpperCase()}`;
    const invoice: SubscriptionBillingInvoiceRecord = {
      id: randomUUID(),
      organizationId,
      subscriptionId: subId,
      invoiceNumber,
      amountCents: matchedPrice.amountCents,
      currency: matchedPrice.currency,
      periodStart,
      periodEnd,
      isPaid: true,
      paidAt: now,
      paymentProviderRef: dto.paymentMethodRef ?? 'PAID_INSTANT',
      createdAt: now,
    };
    dbStore.createSubscriptionInvoice(invoice);

    // Record audit event
    dbStore.recordAudit({
      organizationId,
      actorId,
      actorType: 'USER',
      action: 'SUBSCRIPTION_CHECKOUT_COMPLETED',
      resourceType: 'SUBSCRIPTION',
      resourceId: subId,
      metadata: {
        planCode: plan.code,
        versionNumber: currentVersion.versionNumber,
        currency: matchedPrice.currency,
        amountCents: matchedPrice.amountCents.toString(),
        invoiceNumber,
      },
    });

    return this.getOrganizationSubscription(organizationId)!;
  }

  cancelSubscription(organizationId: string, actorId: string, immediate: boolean = false): OrganizationSubscriptionDto {
    const sub = dbStore.getOrganizationSubscription(organizationId);
    if (!sub) {
      throw new BriskError('NO_ACTIVE_SUBSCRIPTION', 'Organization does not have an active subscription.', 404);
    }

    const now = new Date();
    if (immediate) {
      sub.status = SubscriptionStatus.CANCELED;
      sub.canceledAt = now;
    } else {
      sub.cancelAtPeriodEnd = true;
    }
    sub.updatedAt = now;
    dbStore.saveSubscription(sub);

    dbStore.recordAudit({
      organizationId,
      actorId,
      actorType: 'USER',
      action: immediate ? 'SUBSCRIPTION_TERMINATED_IMMEDIATE' : 'SUBSCRIPTION_CANCEL_SCHEDULED',
      resourceType: 'SUBSCRIPTION',
      resourceId: sub.id,
      metadata: { immediate },
    });

    return this.getOrganizationSubscription(organizationId)!;
  }
}

export const subscriptionService = new SubscriptionService();
