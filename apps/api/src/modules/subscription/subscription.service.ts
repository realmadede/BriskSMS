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
import { SqlExecutor, sql, withTransaction } from '@brisksms/db';

export class SubscriptionService {
  async getOrganizationSubscription(
    organizationId: string,
    tx: SqlExecutor = sql,
  ): Promise<OrganizationSubscriptionDto | null> {
    const sub = await dbStore.getOrganizationSubscription(organizationId, tx);
    if (!sub) {
      return null;
    }

    const version = await dbStore.getPlanVersionById(sub.planVersionId, tx);
    const plan = version ? await dbStore.getPlanById(version.planId, tx) : null;
    const entitlements = await entitlementService.getEntitlements(organizationId, tx);

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

  async checkoutSubscription(
    organizationId: string,
    actorId: string,
    dto: CheckoutSubscriptionDto,
  ): Promise<OrganizationSubscriptionDto> {
    return withTransaction(async (tx) => {
      const plan = await dbStore.getPlanByCode(dto.planCode, tx);
      if (!plan || !plan.isPublic) {
        throw new PlanNotFoundError(dto.planCode);
      }

      const currentVersion = await dbStore.getActivePlanVersion(plan.id, tx);
      if (!currentVersion) {
        throw new PlanNotFoundError(`${dto.planCode} (no active version)`);
      }

      const prices = await dbStore.getPlanPrices(currentVersion.id, tx);
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

      const existingSub = await dbStore.getOrganizationSubscription(organizationId, tx);
      const now = new Date();
      const periodDays = dto.billingInterval === BillingInterval.ANNUALLY ? 365 : 30;
      const periodStart = now;
      const periodEnd = new Date(now.getTime() + periodDays * 24 * 3600 * 1000);

      const subId = existingSub?.id ?? randomUUID();
      const subscriptionRecord: OrganizationSubscriptionRecord = {
        id: subId,
        organizationId,
        planVersionId: currentVersion.id,
        status: SubscriptionStatus.ACTIVE,
        currency: matchedPrice.currency,
        unitPriceCents: matchedPrice.amountCents,
        billingInterval: matchedPrice.billingInterval,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        trialEndsAt: null,
        canceledAt: null,
        cancelAtPeriodEnd: false,
        createdAt: existingSub?.createdAt ?? now,
        updatedAt: now,
      };

      const savedSub = await dbStore.saveSubscription(subscriptionRecord, tx);

      // Persist immutable subscription history event
      await tx`
        INSERT INTO "subscription_history" (
          "id", "organization_id", "subscription_id", "plan_version_id",
          "event_type", "previous_status", "new_status", "unit_price_cents",
          "currency", "billing_interval", "actor_id", "metadata"
        )
        VALUES (
          ${randomUUID()},
          ${organizationId},
          ${savedSub.id},
          ${currentVersion.id},
          ${existingSub ? 'UPGRADED' : 'CREATED'},
          ${existingSub ? existingSub.status : null}::"SubscriptionStatus",
          ${SubscriptionStatus.ACTIVE}::"SubscriptionStatus",
          ${matchedPrice.amountCents.toString()}::bigint,
          ${matchedPrice.currency},
          ${matchedPrice.billingInterval}::"BillingInterval",
          ${actorId},
          ${JSON.stringify({ planCode: plan.code, versionNumber: currentVersion.versionNumber })}::jsonb
        )
      `;

      // Generate immutable snapshot billing invoice
      const invoiceNumber = `INV-SUB-${Date.now().toString(36).toUpperCase()}-${randomUUID().substring(0, 4).toUpperCase()}`;
      const invoice: SubscriptionBillingInvoiceRecord = {
        id: randomUUID(),
        organizationId,
        subscriptionId: savedSub.id,
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
      await dbStore.createSubscriptionInvoice(invoice, tx);

      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'SUBSCRIPTION_CHECKOUT_COMPLETED',
          resourceType: 'SUBSCRIPTION',
          resourceId: savedSub.id,
          metadata: {
            planCode: plan.code,
            versionNumber: currentVersion.versionNumber,
            currency: matchedPrice.currency,
            amountCents: matchedPrice.amountCents.toString(),
            invoiceNumber,
          },
        },
        tx,
      );

      return (await this.getOrganizationSubscription(organizationId, tx))!;
    });
  }

  async cancelSubscription(
    organizationId: string,
    actorId: string,
    immediate: boolean = false,
  ): Promise<OrganizationSubscriptionDto> {
    return withTransaction(async (tx) => {
      const sub = await dbStore.getOrganizationSubscription(organizationId, tx);
      if (!sub) {
        throw new BriskError('NO_ACTIVE_SUBSCRIPTION', 'Organization does not have an active subscription.', 404);
      }

      const previousStatus = sub.status;
      const now = new Date();
      if (immediate) {
        sub.status = SubscriptionStatus.CANCELED;
        sub.canceledAt = now;
      } else {
        sub.cancelAtPeriodEnd = true;
      }
      sub.updatedAt = now;
      await dbStore.saveSubscription(sub, tx);

      await tx`
        INSERT INTO "subscription_history" (
          "id", "organization_id", "subscription_id", "plan_version_id",
          "event_type", "previous_status", "new_status", "unit_price_cents",
          "currency", "billing_interval", "actor_id", "metadata"
        )
        VALUES (
          ${randomUUID()},
          ${organizationId},
          ${sub.id},
          ${sub.planVersionId},
          ${immediate ? 'CANCELED_IMMEDIATE' : 'CANCEL_SCHEDULED'},
          ${previousStatus}::"SubscriptionStatus",
          ${sub.status}::"SubscriptionStatus",
          ${sub.unitPriceCents.toString()}::bigint,
          ${sub.currency},
          ${sub.billingInterval}::"BillingInterval",
          ${actorId},
          ${JSON.stringify({ immediate })}::jsonb
        )
      `;

      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: immediate ? 'SUBSCRIPTION_TERMINATED_IMMEDIATE' : 'SUBSCRIPTION_CANCEL_SCHEDULED',
          resourceType: 'SUBSCRIPTION',
          resourceId: sub.id,
          metadata: { immediate },
        },
        tx,
      );

      return (await this.getOrganizationSubscription(organizationId, tx))!;
    });
  }
}

export const subscriptionService = new SubscriptionService();
