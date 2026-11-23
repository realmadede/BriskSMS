import { SqlExecutor } from '@brisksms/db';
import { messagingService } from './messaging.service.js';

/**
 * Called inside the verification transaction when an invoice in the billing workspace becomes paid.
 * If the invoice backs a pending credit purchase, the credits are written to the messaging ledger in the
 * same transaction. The request is marked ACTIVATED in the same step, and it is only ever read while
 * PENDING, so a retry can never add the credits twice. For every other invoice this finds nothing.
 */
export async function activateCreditPurchaseForInvoice(tx: SqlExecutor, invoice: { id: string }): Promise<void> {
  const rows = await tx<Record<string, any>>`
    SELECT * FROM "credit_purchases"
    WHERE "billing_invoice_id" = ${invoice.id}::uuid AND "status" = 'PENDING'
    FOR UPDATE
  `;
  const purchase = rows[0];
  if (!purchase) return;

  await messagingService.purchaseCredits(
    String(purchase.organization_id),
    Number(purchase.credits),
    String(purchase.reference_number),
    tx,
  );

  await tx`
    UPDATE "credit_purchases" SET "status" = 'ACTIVATED', "activated_at" = NOW()
    WHERE "id" = ${purchase.id}::uuid
  `;
}
