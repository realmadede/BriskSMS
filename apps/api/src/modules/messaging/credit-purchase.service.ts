import { randomUUID } from 'node:crypto';
import { BriskError } from '@brisksms/shared';
import { SqlExecutor, withTransaction } from '@brisksms/db';
import { dbStore } from '../../core/store.js';
import { reconciliationService } from '../reconciliation/reconciliation.service.js';
import { BILLING_INSTRUCTIONS_SETTING, BILLING_WORKSPACE_SETTING } from '../subscription/subscription.service.js';
import { newReference } from '../subscription/billing-request.service.js';
import { creditPackService } from './credit-pack.service.js';

export interface CreditPurchaseDto {
  id: string;
  status: 'PENDING' | 'ACTIVATED' | 'CANCELLED';
  referenceNumber: string;
  packName: string;
  credits: number;
  amountCents: string;
  currency: string;
  instructions: string | null;
  createdAt: string;
}

async function toDto(tx: SqlExecutor, row: Record<string, any>): Promise<CreditPurchaseDto> {
  const pack = await creditPackService.getById(String(row.pack_id), tx);
  return {
    id: String(row.id),
    status: row.status,
    referenceNumber: String(row.reference_number),
    packName: pack?.name ?? '',
    credits: Number(row.credits),
    amountCents: String(row.amount_cents),
    currency: String(row.currency),
    instructions: (await dbStore.getPlatformSetting(BILLING_INSTRUCTIONS_SETTING, tx)) || null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * A customer's request to buy a pack of SMS credits. Each request is an ordinary invoice in the billing
 * workspace, so the payment is matched and verified by the normal reconciliation engine, and the credits
 * are added when that invoice is paid (see credit-activation.ts).
 */
export class CreditPurchaseService {
  async createRequest(
    organizationId: string,
    actorId: string,
    dto: { packId: string; payerPhone?: string },
  ): Promise<CreditPurchaseDto> {
    return withTransaction(async (tx) => {
      const billingOrganizationId = await dbStore.getPlatformSetting(BILLING_WORKSPACE_SETTING, tx);
      if (!billingOrganizationId) {
        throw new BriskError(
          'BILLING_NOT_CONFIGURED',
          'Credits cannot be bought yet because the platform billing workspace is not configured.',
          503,
        );
      }

      const pack = await creditPackService.getById(dto.packId, tx);
      if (!pack || !pack.isActive) {
        throw new BriskError('PACK_UNAVAILABLE', 'This credit pack is not available.', 404);
      }

      // One open purchase per workspace at a time
      await tx`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
      const payer = (await dbStore.findOrgById(organizationId, tx))!;

      const pendingRows = await tx<Record<string, any>>`
        SELECT * FROM "credit_purchases"
        WHERE "organization_id" = ${organizationId}::uuid AND "status" = 'PENDING' FOR UPDATE
      `;
      const pending = pendingRows[0];
      if (pending) {
        if (String(pending.pack_id) !== pack.id) {
          throw new BriskError(
            'PURCHASE_REQUEST_EXISTS',
            'You already have a credit purchase open for another pack. Cancel it before choosing a different pack.',
            409,
          );
        }
        return toDto(tx, pending);
      }

      let referenceNumber = newReference('CRD');
      for (let i = 0; i < 5; i++) {
        const taken = await tx`
          SELECT 1 FROM "invoices"
          WHERE "organization_id" = ${billingOrganizationId}::uuid AND "reference_number" = ${referenceNumber}
        `;
        if (taken.length === 0) break;
        referenceNumber = newReference('CRD');
      }

      const purchaseId = randomUUID();
      const invoice = await reconciliationService.createInvoice(
        billingOrganizationId,
        {
          referenceNumber,
          totalAmountCents: BigInt(pack.amountCents),
          currency: pack.currency,
          customerPhone: dto.payerPhone,
          customerName: payer.name,
          metadata: {
            kind: 'CREDIT_PURCHASE',
            purchaseId,
            payingOrganizationId: organizationId,
            packCode: pack.code,
          },
        },
        tx,
      );

      const rows = await tx<Record<string, any>>`
        INSERT INTO "credit_purchases" (
          "id", "organization_id", "billing_organization_id", "billing_invoice_id", "reference_number",
          "pack_id", "credits", "currency", "amount_cents", "created_by_id"
        ) VALUES (
          ${purchaseId}, ${organizationId}, ${billingOrganizationId}, ${invoice.id}, ${invoice.referenceNumber},
          ${pack.id}, ${pack.credits}, ${pack.currency}, ${pack.amountCents}::bigint, ${actorId}
        ) RETURNING *
      `;

      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'CREDIT_PURCHASE_REQUESTED',
          resourceType: 'CREDIT_PURCHASE',
          resourceId: purchaseId,
          metadata: { packCode: pack.code, credits: pack.credits, referenceNumber: invoice.referenceNumber },
        },
        tx,
      );

      return toDto(tx, rows[0]!);
    });
  }

  /** The workspace's most recent purchase request, or null. */
  async getCurrentRequest(organizationId: string): Promise<CreditPurchaseDto | null> {
    return withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM "credit_purchases"
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
        SELECT * FROM "credit_purchases"
        WHERE "organization_id" = ${organizationId}::uuid AND "status" = 'PENDING' FOR UPDATE
      `;
      const request = rows[0];
      if (!request) {
        throw new BriskError('NO_PENDING_REQUEST', 'There is no open credit purchase to cancel.', 404);
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
          'A payment for this purchase has already arrived and is being checked, so it cannot be cancelled.',
          409,
        );
      }

      await tx`UPDATE "invoices" SET "status" = 'VOID'::"InvoiceStatus", "updated_at" = NOW() WHERE "id" = ${request.billing_invoice_id}::uuid`;
      await tx`UPDATE "credit_purchases" SET "status" = 'CANCELLED', "cancelled_at" = NOW() WHERE "id" = ${request.id}::uuid`;
      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'CREDIT_PURCHASE_CANCELLED',
          resourceType: 'CREDIT_PURCHASE',
          resourceId: String(request.id),
          metadata: { referenceNumber: String(request.reference_number) },
        },
        tx,
      );
    });
  }
}

export const creditPurchaseService = new CreditPurchaseService();
