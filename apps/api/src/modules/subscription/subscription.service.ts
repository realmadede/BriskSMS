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

      // Serialize concurrent subscription checkouts for the same organization
      await tx`
        SELECT "id" FROM "organizations"
        WHERE "id" = ${organizationId}::uuid
        FOR UPDATE
      `;

      const existingSub = await dbStore.getOrganizationSubscription(organizationId, tx);
      const now = new Date();
      const periodDays = dto.billingInterval === BillingInterval.ANNUALLY ? 365 : 30;
      const periodStart = now;

      let status: SubscriptionStatus;
      let periodEnd: Date;
      let trialEndsAt: Date | null = null;
      let isPaid = false;
      let paidAt: Date | null = null;
      let verifiedPaymentProviderRef: string | null = null;

      if (matchedPrice.amountCents === 0n) {
        status = SubscriptionStatus.ACTIVE;
        periodEnd = new Date(now.getTime() + periodDays * 24 * 3600 * 1000);
        isPaid = true;
        paidAt = now;
        verifiedPaymentProviderRef = 'FREE_TIER';
      } else if (dto.paymentMethodRef && dto.paymentMethodRef.trim().length > 0) {
        const refNorm = dto.paymentMethodRef.trim();
        // Verify settled/verified payment evidence inside the same organization and currency,
        // locking matching rows FOR UPDATE and excluding customer-invoice or disputed claims.
        const verifiedStkRows = await tx<{
          id: string;
          provider_reference: string | null;
          settled_payment_id: string | null;
        }>`
          SELECT s."id", s."provider_reference", s."settled_payment_id"
          FROM "stk_push_transactions" s
          WHERE s."organization_id" = ${organizationId}
            AND s."status" = 'SUCCESS'::"StkPushStatus"
            AND s."invoice_id" IS NULL
            AND s."currency" = ${matchedPrice.currency}
            AND s."amount_cents" >= ${matchedPrice.amountCents.toString()}::bigint
            AND (
              s."provider_reference" = ${refNorm}
              OR s."id"::text = ${refNorm}
              OR s."settled_payment_id"::text = ${refNorm}
            )
            AND (
              s."settled_payment_id" IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM "invoice_payments" ip
                WHERE ip."payment_id" = s."settled_payment_id"
              )
            )
          LIMIT 1
          FOR UPDATE OF s
        `;
        const verifiedNormRows =
          verifiedStkRows.length === 0
            ? await tx<{ id: string; reference: string }>`
                SELECT np."id", np."reference"
                FROM "normalized_payments" np
                WHERE np."organization_id" = ${organizationId}
                  AND np."state" = 'VERIFIED'::"TransactionState"
                  AND np."currency" = ${matchedPrice.currency}
                  AND np."amount_cents" >= ${matchedPrice.amountCents.toString()}::bigint
                  AND (np."reference" = ${refNorm} OR np."id"::text = ${refNorm})
                  AND NOT EXISTS (
                    SELECT 1 FROM "invoice_payments" ip
                    WHERE ip."payment_id" = np."id"
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM "stk_push_transactions" s2
                    WHERE s2."settled_payment_id" = np."id"
                      AND s2."invoice_id" IS NOT NULL
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM "payment_reference_claims" prc
                    WHERE prc."payment_id" = np."id"
                      AND prc."status" IN ('DISPUTED'::"claim_status", 'UNRESOLVED_COLLISION'::"claim_status")
                  )
                LIMIT 1
                FOR UPDATE OF np
              `
            : [];

        if (verifiedStkRows.length === 0 && verifiedNormRows.length === 0) {
          throw new BriskError(
            'PAYMENT_VERIFICATION_REQUIRED',
            `Payment reference '${refNorm}' has not been verified for ${matchedPrice.currency} ${matchedPrice.amountCents.toString()} minor units.`,
            402,
            { planCode: dto.planCode, paymentMethodRef: refNorm },
          );
        }

        const matchedEvidenceId = verifiedStkRows[0]?.id ?? verifiedNormRows[0]?.id ?? refNorm;
        const settledPaymentId = verifiedStkRows[0]?.settled_payment_id ?? verifiedNormRows[0]?.id ?? matchedEvidenceId;
        const canonicalRef =
          verifiedStkRows[0]?.provider_reference ?? verifiedNormRows[0]?.reference ?? refNorm;

        // Serialize checkouts targeting the same provider reference or internal evidence ID
        await tx`SELECT pg_advisory_xact_lock(hashtext('sub_pay_ref:' || ${canonicalRef}))`;
        await tx`SELECT pg_advisory_xact_lock(hashtext('sub_pay_id:' || ${matchedEvidenceId}))`;
        await tx`SELECT pg_advisory_xact_lock(hashtext('sub_pay_settled:' || ${settledPaymentId}))`;

        const alreadyUsedRows = await tx<{ id: string }>`
          SELECT "id"
          FROM "subscription_billing_invoices"
          WHERE "is_paid" = true
            AND "payment_provider_ref" IN (${canonicalRef}, ${refNorm}, ${matchedEvidenceId}, ${settledPaymentId})
          LIMIT 1
        `;
        if (alreadyUsedRows.length > 0) {
          throw new BriskError(
            'PAYMENT_REFERENCE_ALREADY_USED',
            `Payment reference '${refNorm}' has already been applied to a subscription invoice.`,
            409,
            { planCode: dto.planCode, paymentMethodRef: refNorm },
          );
        }

        status = SubscriptionStatus.ACTIVE;
        periodEnd = new Date(now.getTime() + periodDays * 24 * 3600 * 1000);
        isPaid = true;
        paidAt = now;
        verifiedPaymentProviderRef = canonicalRef;
      } else if (
        currentVersion.trialPeriodDays > 0 &&
        (!existingSub || (existingSub.status === SubscriptionStatus.TRIALING && (!existingSub.trialEndsAt || existingSub.trialEndsAt > now)))
      ) {
        const computedTrialEnd =
          existingSub?.status === SubscriptionStatus.TRIALING && existingSub.trialEndsAt
            ? existingSub.trialEndsAt
            : new Date(now.getTime() + currentVersion.trialPeriodDays * 24 * 3600 * 1000);
        status = SubscriptionStatus.TRIALING;
        trialEndsAt = computedTrialEnd;
        periodEnd = computedTrialEnd;
        isPaid = false;
        paidAt = null;
        verifiedPaymentProviderRef = null;
      } else {
        throw new BriskError(
          'PAYMENT_VERIFICATION_REQUIRED',
          `Verified payment reference is required to activate paid plan '${dto.planCode}'.`,
          402,
          { planCode: dto.planCode, currency: matchedPrice.currency, billingInterval: dto.billingInterval },
        );
      }

      const subId = existingSub?.id ?? randomUUID();
      const subscriptionRecord: OrganizationSubscriptionRecord = {
        id: subId,
        organizationId,
        planVersionId: currentVersion.id,
        status,
        currency: matchedPrice.currency,
        unitPriceCents: matchedPrice.amountCents,
        billingInterval: matchedPrice.billingInterval,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        trialEndsAt,
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
          ${status}::"SubscriptionStatus",
          ${matchedPrice.amountCents.toString()}::bigint,
          ${matchedPrice.currency},
          ${matchedPrice.billingInterval}::"BillingInterval",
          ${actorId},
          ${JSON.stringify({ planCode: plan.code, versionNumber: currentVersion.versionNumber })}::jsonb
        )
      `;

      // Generate immutable snapshot billing invoice reflecting real payment settlement status
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
        isPaid,
        paidAt,
        paymentProviderRef: verifiedPaymentProviderRef,
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

  async listSubscriptionInvoices(organizationId: string): Promise<Array<{
    id: string;
    organizationId: string;
    subscriptionId: string;
    invoiceNumber: string;
    amountCents: string;
    currency: string;
    periodStart: string;
    periodEnd: string;
    isPaid: boolean;
    paidAt: string | null;
    paymentProviderRef: string | null;
    createdAt: string;
  }>> {
    const rows = await sql`
      SELECT *
      FROM "subscription_billing_invoices"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" DESC
      LIMIT 100
    `;
    return rows.map((r: any) => ({
      id: String(r.id),
      organizationId: String(r.organization_id),
      subscriptionId: String(r.subscription_id),
      invoiceNumber: String(r.invoice_number),
      amountCents: BigInt(r.amount_cents).toString(),
      currency: String(r.currency),
      periodStart: new Date(r.period_start).toISOString(),
      periodEnd: new Date(r.period_end).toISOString(),
      isPaid: Boolean(r.is_paid),
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      paymentProviderRef: r.payment_provider_ref ? String(r.payment_provider_ref) : null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}

export const subscriptionService = new SubscriptionService();
