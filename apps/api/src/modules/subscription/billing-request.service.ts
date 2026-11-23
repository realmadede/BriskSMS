import { randomInt, randomUUID } from 'node:crypto';
import { BillingInterval, BriskError } from '@brisksms/shared';
import { SqlExecutor, withTransaction } from '@brisksms/db';
import { dbStore } from '../../core/store.js';
import { reconciliationService } from '../reconciliation/reconciliation.service.js';
import {
  BILLING_INSTRUCTIONS_SETTING,
  BILLING_WORKSPACE_SETTING,
  subscriptionService,
} from './subscription.service.js';

export interface PaymentRequestDto {
  id: string;
  status: 'PENDING' | 'ACTIVATED' | 'CANCELLED';
  referenceNumber: string;
  planCode: string;
  planName: string;
  amountCents: string;
  currency: string;
  billingInterval: BillingInterval;
  instructions: string | null;
  createdAt: string;
}

// No 0, O, 1, I or L, so a reference read off a screen is hard to mistype
const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newReference(prefix = 'SUB'): string {
  let out = prefix;
  for (let i = 0; i < 7; i++) out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return out;
}

async function toDto(tx: SqlExecutor, row: Record<string, any>): Promise<PaymentRequestDto> {
  const version = (await dbStore.getPlanVersionById(String(row.plan_version_id), tx))!;
  const plan = (await dbStore.getPlanById(version.planId, tx))!;
  return {
    id: String(row.id),
    status: row.status,
    referenceNumber: String(row.reference_number),
    planCode: plan.code,
    planName: plan.name,
    amountCents: String(row.amount_cents),
    currency: String(row.currency),
    billingInterval: row.billing_interval as BillingInterval,
    instructions: (await dbStore.getPlatformSetting(BILLING_INSTRUCTIONS_SETTING, tx)) || null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * A customer's request to pay for a paid plan. Each request is an ordinary invoice in the billing
 * workspace, so the payment is matched and verified by the normal reconciliation engine, and the
 * subscription is activated when that invoice is paid (see billing-activation.ts).
 */
export class BillingRequestService {
  async createRequest(
    organizationId: string,
    actorId: string,
    dto: { planCode: string; currency: string; billingInterval: BillingInterval; payerPhone?: string },
  ): Promise<PaymentRequestDto> {
    return withTransaction(async (tx) => {
      const billingOrganizationId = await dbStore.getPlatformSetting(BILLING_WORKSPACE_SETTING, tx);
      if (!billingOrganizationId) {
        throw new BriskError(
          'BILLING_NOT_CONFIGURED',
          'Paid plans cannot be activated yet because the platform billing workspace is not configured.',
          503,
        );
      }

      const { plan, version, price } = await subscriptionService.resolvePlanPrice(
        dto.planCode,
        dto.currency,
        dto.billingInterval,
        tx,
      );
      if (price.amountCents === 0n) {
        throw new BriskError('PAYMENT_NOT_REQUIRED', 'This plan is free, so there is nothing to pay.', 422);
      }

      // One open request per workspace at a time
      await tx`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
      const payer = (await dbStore.findOrgById(organizationId, tx))!;

      const pendingRows = await tx<Record<string, any>>`
        SELECT * FROM "billing_checkout_requests"
        WHERE "organization_id" = ${organizationId}::uuid AND "status" = 'PENDING' FOR UPDATE
      `;
      const pending = pendingRows[0];
      if (pending) {
        const pendingVersion = (await dbStore.getPlanVersionById(String(pending.plan_version_id), tx))!;
        const same =
          pendingVersion.planId === plan.id &&
          String(pending.currency).toUpperCase() === price.currency.toUpperCase() &&
          pending.billing_interval === price.billingInterval;
        if (!same) {
          throw new BriskError(
            'PAYMENT_REQUEST_EXISTS',
            'You already have a payment request open for another plan. Cancel it before choosing a different plan.',
            409,
          );
        }
        return toDto(tx, pending);
      }

      let referenceNumber = newReference();
      for (let i = 0; i < 5; i++) {
        const taken = await tx`
          SELECT 1 FROM "invoices"
          WHERE "organization_id" = ${billingOrganizationId}::uuid AND "reference_number" = ${referenceNumber}
        `;
        if (taken.length === 0) break;
        referenceNumber = newReference();
      }

      const requestId = randomUUID();
      const invoice = await reconciliationService.createInvoice(
        billingOrganizationId,
        {
          referenceNumber,
          totalAmountCents: price.amountCents,
          currency: price.currency,
          customerPhone: dto.payerPhone,
          customerName: payer.name,
          metadata: {
            kind: 'SUBSCRIPTION_CHECKOUT',
            requestId,
            payingOrganizationId: organizationId,
            planCode: plan.code,
          },
        },
        tx,
      );

      const rows = await tx<Record<string, any>>`
        INSERT INTO "billing_checkout_requests" (
          "id", "organization_id", "billing_organization_id", "billing_invoice_id", "reference_number",
          "plan_version_id", "currency", "billing_interval", "amount_cents", "created_by_id"
        ) VALUES (
          ${requestId}, ${organizationId}, ${billingOrganizationId}, ${invoice.id}, ${invoice.referenceNumber},
          ${version.id}, ${price.currency}, ${price.billingInterval}::"BillingInterval",
          ${price.amountCents.toString()}::bigint, ${actorId}
        ) RETURNING *
      `;

      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'SUBSCRIPTION_PAYMENT_REQUESTED',
          resourceType: 'BILLING_CHECKOUT_REQUEST',
          resourceId: requestId,
          metadata: { planCode: plan.code, referenceNumber: invoice.referenceNumber },
        },
        tx,
      );

      return toDto(tx, rows[0]!);
    });
  }

  /** The workspace's most recent request, or null. */
  async getCurrentRequest(organizationId: string): Promise<PaymentRequestDto | null> {
    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM "billing_checkout_requests"
        WHERE "organization_id" = ${organizationId}::uuid
        ORDER BY "created_at" DESC LIMIT 1
      `;
      return rows[0] ? toDto(tx, rows[0]) : null;
    });
  }

  /** Abandons the open request. Refused once any payment has been received against it. */
  async cancelRequest(organizationId: string, actorId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM "billing_checkout_requests"
        WHERE "organization_id" = ${organizationId}::uuid AND "status" = 'PENDING' FOR UPDATE
      `;
      const request = rows[0];
      if (!request) {
        throw new BriskError('NO_PENDING_REQUEST', 'There is no open payment request to cancel.', 404);
      }

      const invoiceRows = await tx<Record<string, any>>`
        SELECT * FROM "invoices" WHERE "id" = ${request.billing_invoice_id}::uuid FOR UPDATE
      `;
      const inProgress = await tx`
        SELECT 1 FROM "normalized_payments"
        WHERE "organization_id" = ${request.billing_organization_id}::uuid
          AND ("candidate_invoice_id" = ${request.billing_invoice_id}::uuid OR "matched_invoice_id" = ${request.billing_invoice_id}::uuid)
          AND "state" NOT IN ('REJECTED', 'DUPLICATE_REJECTED')
        LIMIT 1
      `;
      if (invoiceRows[0]!.status !== 'UNPAID' || inProgress.length > 0) {
        throw new BriskError(
          'PAYMENT_ALREADY_RECEIVED',
          'A payment for this request has already arrived and is being checked, so it cannot be cancelled.',
          409,
        );
      }

      await tx`UPDATE "invoices" SET "status" = 'VOID'::"InvoiceStatus", "updated_at" = NOW() WHERE "id" = ${request.billing_invoice_id}::uuid`;
      await tx`UPDATE "billing_checkout_requests" SET "status" = 'CANCELLED', "cancelled_at" = NOW() WHERE "id" = ${request.id}::uuid`;
      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'SUBSCRIPTION_PAYMENT_REQUEST_CANCELLED',
          resourceType: 'BILLING_CHECKOUT_REQUEST',
          resourceId: String(request.id),
          metadata: { referenceNumber: String(request.reference_number) },
        },
        tx,
      );
    });
  }
}

export const billingRequestService = new BillingRequestService();
