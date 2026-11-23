import { BillingInterval, SubscriptionStatus } from '@brisksms/shared';
import { SqlExecutor } from '@brisksms/db';
import { dbStore } from '../../core/store.js';
import { subscriptionService } from './subscription.service.js';

/**
 * Called inside the verification transaction when an invoice in the billing workspace becomes paid.
 * If the invoice backs a pending plan request, the subscription is activated on the terms the
 * customer requested, in the same transaction, so a verified payment can never be left unactivated.
 * For every other invoice this is one indexed lookup that finds nothing.
 */
export async function activateBillingRequestForInvoice(tx: SqlExecutor, invoice: { id: string }): Promise<void> {
  const rows = await tx<Record<string, any>>`
    SELECT * FROM "billing_checkout_requests"
    WHERE "billing_invoice_id" = ${invoice.id}::uuid AND "status" = 'PENDING'
    FOR UPDATE
  `;
  const request = rows[0];
  if (!request) return;

  const organizationId = String(request.organization_id);
  await tx`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;

  const version = (await dbStore.getPlanVersionById(String(request.plan_version_id), tx))!;
  const plan = (await dbStore.getPlanById(version.planId, tx))!;
  const existingSub = await dbStore.getOrganizationSubscription(organizationId, tx);

  const now = new Date();
  const interval = request.billing_interval as BillingInterval;
  const periodDays = interval === BillingInterval.ANNUALLY ? 365 : 30;

  await subscriptionService.persistSubscription(tx, {
    organizationId,
    actorId: String(request.created_by_id ?? request.id),
    actorType: 'SYSTEM',
    plan,
    version,
    price: { currency: String(request.currency), amountCents: BigInt(request.amount_cents), billingInterval: interval },
    existingSub,
    status: SubscriptionStatus.ACTIVE,
    periodStart: now,
    periodEnd: new Date(now.getTime() + periodDays * 24 * 3600 * 1000),
    trialEndsAt: null,
    isPaid: true,
    paidAt: now,
    paymentProviderRef: String(request.reference_number),
  });

  await tx`
    UPDATE "billing_checkout_requests" SET "status" = 'ACTIVATED', "activated_at" = ${now}
    WHERE "id" = ${request.id}::uuid
  `;
}
