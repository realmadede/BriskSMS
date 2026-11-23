import { randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  ClaimStatus,
  InvoiceStatus,
  MatchConfidenceTier,
  PaymentVerificationState,
  ReconciliationMatchResult,
  TransactionState,
  VerificationMethod,
} from '@brisksms/shared';
import {
  dbStore,
  InvoiceRecord,
  NormalizedPaymentRecord,
  PaymentVerificationRecord,
  InvoicePaymentRecord,
  mapInvoiceRow,
  mapNormalizedPaymentRow,
} from '../../core/store.js';
import { HttpException } from '../../core/http.js';
import {
  PaymentReferenceClaimService,
  paymentReferenceClaimService,
} from './payment-reference-claim.service.js';
import { assertTenantContext, sql, SqlExecutor, withTransaction } from '@brisksms/db';
import { activateBillingRequestForInvoice } from '../subscription/billing-activation.js';
import { activateCreditPurchaseForInvoice } from '../messaging/credit-activation.js';

export interface CreateInvoiceDto {
  referenceNumber: string;
  totalAmountCents: bigint;
  currency?: string;
  customerId?: string;
  customerPhone?: string;
  customerName?: string;
  dueDate?: Date;
  metadata?: Record<string, unknown>;
}

export interface VerifyPaymentDto {
  paymentId: string;
  invoiceId?: string;
  verificationMethod: VerificationMethod;
  verifiedById?: string;
  externalVerificationRef?: string;
  notes?: string;
  isProviderAuthenticated?: boolean;
  requireAuditMetadata?: boolean;
}

export interface RejectPaymentDto {
  paymentId: string;
  verifiedById: string;
  notes: string;
}

export interface VerificationSettlementResult {
  payment: NormalizedPaymentRecord;
  verification: PaymentVerificationRecord;
  invoice: InvoiceRecord;
  invoicePayment: InvoicePaymentRecord;
  fulfillmentEligible: boolean;
  verificationState: PaymentVerificationState;
  claimId: string;
  claimStatus: ClaimStatus;
}

export interface CandidateMatchSuggestion {
  invoiceId: string;
  referenceNumber: string;
  totalAmountCents: bigint;
  balanceCents: bigint;
  currency: string;
  status: InvoiceStatus;
  customerName: string | null;
  customerPhone: string | null;
  dueDate: Date | null;
  confidenceScore: number;
  confidenceTier: string;
  matchReasons: string[];
}

/**
 * Multi-Tier Deterministic Reconciliation Engine
 *
 * CRITICAL FINANCIAL INVARIANT (Section 3.C):
 * Receiving an Android payment notification is NOT proof of final settlement.
 * 1. `reconcilePayment()` evaluates candidate invoice matches (`MATCHED`, `REVIEW_REQUIRED`, `UNMATCHED`)
 *    without marking the payment `VERIFIED` or settling the invoice's verified balance (`PAID`).
 * 2. `verifyPayment()` performs independent or manual finance verification inside an ACID PostgreSQL
 *    transaction with row-level locks (`SELECT ... FOR UPDATE`), records an immutable `PaymentVerification`
 *    and `InvoicePayment`, updates the invoice balance and status (`PARTIALLY_PAID`, `PAID`, `OVERPAID`),
 *    and determines fulfillment eligibility.
 */
export class ReconciliationService {
  constructor(
    private readonly claimService: PaymentReferenceClaimService = paymentReferenceClaimService,
  ) {}
  /**
   * Creates an open invoice for a tenant organization in PostgreSQL.
   */
  async createInvoice(
    organizationId: string,
    dto: CreateInvoiceDto,
    tx: SqlExecutor = sql,
  ): Promise<InvoiceRecord> {
    assertTenantContext({ organizationId });
    const id = randomUUID();
    const refNorm = dto.referenceNumber.trim().toUpperCase();
    const currency = dto.currency || 'TZS';

    const rows = await tx`
      INSERT INTO "invoices" (
        "id", "organization_id", "customer_id", "reference_number",
        "total_amount_cents", "paid_amount_cents", "balance_cents",
        "currency", "status", "customer_phone", "customer_name", "due_date", "metadata"
      )
      VALUES (
        ${id},
        ${organizationId},
        ${dto.customerId ?? null},
        ${refNorm},
        ${dto.totalAmountCents.toString()}::bigint,
        0,
        ${dto.totalAmountCents.toString()}::bigint,
        ${currency},
        ${InvoiceStatus.UNPAID}::"InvoiceStatus",
        ${dto.customerPhone ?? null},
        ${dto.customerName ?? null},
        ${dto.dueDate ?? null},
        ${dto.metadata ? JSON.stringify(dto.metadata) : null}::jsonb
      )
      RETURNING *
    `;

    return mapInvoiceRow(rows[0]!);
  }

  /**
   * Finds an invoice by ID strictly scoped to the tenant organization.
   */
  async findInvoiceById(
    organizationId: string,
    invoiceId: string,
    tx: SqlExecutor = sql,
  ): Promise<InvoiceRecord | null> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "invoices"
      WHERE "id" = ${invoiceId} AND "organization_id" = ${organizationId}
      LIMIT 1
    `;
    return rows[0] ? mapInvoiceRow(rows[0]) : null;
  }

  /**
   * Lists all invoices belonging to the tenant organization.
   */
  async listInvoices(organizationId: string, tx: SqlExecutor = sql): Promise<InvoiceRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "invoices"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" DESC
    `;
    return rows.map(mapInvoiceRow);
  }

  /**
   * Step 3 of Payment Lifecycle: Candidate Match Evaluation.
   * Associates a normalized payment with a candidate open invoice or routes it to REVIEW_REQUIRED / UNMATCHED.
   * NEVER marks a payment as VERIFIED or an invoice as PAID upon notification ingestion alone.
   */
  async reconcilePayment(
    payment: NormalizedPaymentRecord,
    existingTx?: SqlExecutor,
  ): Promise<ReconciliationMatchResult> {
    assertTenantContext({ organizationId: payment.organizationId });

    return withTransaction(async (tx) => {
      // Tier 1: Exact Reference / Customer Memo Match
      const lookupRef = (payment.customerMemo || payment.reference).trim().toUpperCase();
      const tier1Rows = await tx`
        SELECT * FROM "invoices"
        WHERE "organization_id" = ${payment.organizationId}
          AND "reference_number" = ${lookupRef}
          AND "status" IN ('UNPAID', 'PARTIALLY_PAID')
        FOR UPDATE
      `;
      const exactInvoice = tier1Rows[0] ? mapInvoiceRow(tier1Rows[0]) : null;

      if (exactInvoice) {
        return this.recordCandidateMatch(
          tx,
          payment,
          exactInvoice,
          MatchConfidenceTier.TIER_1_EXACT_REFERENCE,
        );
      }

      // Tier 2: Customer Phone Heuristic Match
      const normalizedSenderPhone = this.normalizePhone(payment.senderPhone);
      if (normalizedSenderPhone) {
        const openRows = await tx`
          SELECT * FROM "invoices"
          WHERE "organization_id" = ${payment.organizationId}
            AND "status" IN ('UNPAID', 'PARTIALLY_PAID')
            AND "customer_phone" IS NOT NULL
          FOR UPDATE
        `;
        const openInvoices = openRows
          .map(mapInvoiceRow)
          .filter((inv) => this.normalizePhone(inv.customerPhone || '') === normalizedSenderPhone);

        if (openInvoices.length === 1) {
          const candidate = openInvoices[0]!;
          const openBalance = candidate.balanceCents;

          if (payment.amountCents === openBalance) {
            return this.recordCandidateMatch(
              tx,
              payment,
              candidate,
              MatchConfidenceTier.TIER_2_CUSTOMER_IDENTIFIER,
            );
          }

          // Amount mismatch on heuristic phone match -> REVIEW_REQUIRED
          await tx`
            UPDATE "normalized_payments"
            SET
              "state" = ${TransactionState.REVIEW_REQUIRED}::"TransactionState",
              "confidence_tier" = ${MatchConfidenceTier.TIER_2_CUSTOMER_IDENTIFIER},
              "candidate_invoice_id" = ${candidate.id},
              "matched_invoice_id" = ${candidate.id},
              "review_reason" = 'Customer phone matched open invoice, but payment amount differs from open balance',
              "updated_at" = NOW()
            WHERE "id" = ${payment.id} AND "organization_id" = ${payment.organizationId}
          `;

          await dbStore.insertOutboxEvent(
            {
              organizationId: payment.organizationId,
              eventType: BusinessEventType.PAYMENT_NEEDS_REVIEW,
              payload: {
                paymentId: payment.id,
                candidateInvoiceId: candidate.id,
                reference: payment.reference,
                amountCents: payment.amountCents.toString(),
                reason: 'TIER_2_AMOUNT_MISMATCH',
              },
            },
            tx,
          );

          return {
            isMatched: false,
            matchedInvoiceId: candidate.id,
            confidenceTier: MatchConfidenceTier.TIER_2_CUSTOMER_IDENTIFIER,
            varianceCents: payment.amountCents - openBalance,
            requiresReview: true,
            reviewReason: 'Customer phone matched open invoice, but payment amount differs from open balance',
          };
        }

        if (openInvoices.length > 1) {
          // Ambiguous multiple open invoices -> REVIEW_REQUIRED without guessing
          await tx`
            UPDATE "normalized_payments"
            SET
              "state" = ${TransactionState.REVIEW_REQUIRED}::"TransactionState",
              "matched_invoice_id" = NULL,
              "candidate_invoice_id" = NULL,
              "review_reason" = 'Multiple open invoices found for customer phone; manual allocation required',
              "updated_at" = NOW()
            WHERE "id" = ${payment.id} AND "organization_id" = ${payment.organizationId}
          `;

          await dbStore.insertOutboxEvent(
            {
              organizationId: payment.organizationId,
              eventType: BusinessEventType.PAYMENT_NEEDS_REVIEW,
              payload: {
                paymentId: payment.id,
                reference: payment.reference,
                amountCents: payment.amountCents.toString(),
                reason: 'AMBIGUOUS_MULTIPLE_OPEN_INVOICES',
              },
            },
            tx,
          );

          return {
            isMatched: false,
            matchedInvoiceId: null,
            confidenceTier: null,
            varianceCents: 0n,
            requiresReview: true,
            reviewReason: 'Multiple open invoices found for customer phone; manual allocation required',
          };
        }
      }

      // Unmatched Fallback
      await tx`
        UPDATE "normalized_payments"
        SET
          "state" = ${TransactionState.UNMATCHED}::"TransactionState",
          "review_reason" = 'No matching open invoice found by reference or customer phone',
          "updated_at" = NOW()
        WHERE "id" = ${payment.id} AND "organization_id" = ${payment.organizationId}
      `;

      await dbStore.insertOutboxEvent(
        {
          organizationId: payment.organizationId,
          eventType: BusinessEventType.PAYMENT_NEEDS_REVIEW,
          payload: {
            paymentId: payment.id,
            reference: payment.reference,
            amountCents: payment.amountCents.toString(),
            senderPhone: payment.senderPhone,
            reason: 'UNMATCHED_PAYMENT',
          },
        },
        tx,
      );

      return {
        isMatched: false,
        matchedInvoiceId: null,
        confidenceTier: null,
        varianceCents: 0n,
        requiresReview: true,
        reviewReason: 'No matching open invoice found by reference or customer phone',
      };
    }, existingTx);
  }

  /**
   * Records a candidate match on `normalized_payments` without settling or marking the invoice PAID.
   * Exact amount matches enter `MATCHED` (awaiting independent/manual verification).
   * Underpayments and overpayments enter `REVIEW_REQUIRED`.
   */
  private async recordCandidateMatch(
    tx: SqlExecutor,
    payment: NormalizedPaymentRecord,
    invoice: InvoiceRecord,
    tier: MatchConfidenceTier,
  ): Promise<ReconciliationMatchResult> {
    const openBalance = invoice.balanceCents;
    const varianceCents = payment.amountCents - openBalance;

    // Overpayment -> REVIEW_REQUIRED
    if (payment.amountCents > openBalance) {
      const reason = `Overpayment detected: received ${payment.amountCents.toString()} cents against open balance ${openBalance.toString()} cents`;
      await tx`
        UPDATE "normalized_payments"
        SET
          "state" = ${TransactionState.REVIEW_REQUIRED}::"TransactionState",
          "confidence_tier" = ${tier},
          "candidate_invoice_id" = ${invoice.id},
          "matched_invoice_id" = ${invoice.id},
          "review_reason" = ${reason},
          "updated_at" = NOW()
        WHERE "id" = ${payment.id} AND "organization_id" = ${payment.organizationId}
      `;

      await dbStore.insertOutboxEvent(
        {
          organizationId: payment.organizationId,
          eventType: BusinessEventType.PAYMENT_NEEDS_REVIEW,
          payload: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            reference: payment.reference,
            amountCents: payment.amountCents.toString(),
            varianceCents: varianceCents.toString(),
            reason: 'OVERPAYMENT_DETECTED',
          },
        },
        tx,
      );

      return {
        isMatched: true,
        matchedInvoiceId: invoice.id,
        confidenceTier: tier,
        varianceCents,
        requiresReview: true,
        reviewReason: reason,
      };
    }

    // Underpayment -> candidate match recorded, flagged as partial / awaiting verification
    if (payment.amountCents < openBalance) {
      const reason = `Partial payment candidate: received ${payment.amountCents.toString()} cents, remaining balance ${ (openBalance - payment.amountCents).toString() } cents`;
      await tx`
        UPDATE "normalized_payments"
        SET
          "state" = ${TransactionState.MATCHED}::"TransactionState",
          "confidence_tier" = ${tier},
          "candidate_invoice_id" = ${invoice.id},
          "matched_invoice_id" = ${invoice.id},
          "review_reason" = ${reason},
          "updated_at" = NOW()
        WHERE "id" = ${payment.id} AND "organization_id" = ${payment.organizationId}
      `;

      await dbStore.insertOutboxEvent(
        {
          organizationId: payment.organizationId,
          eventType: BusinessEventType.PAYMENT_MATCHED,
          payload: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            invoiceReference: invoice.referenceNumber,
            paymentReference: payment.reference,
            amountCents: payment.amountCents.toString(),
            confidenceTier: tier,
            verificationRequired: true,
            isPartialCandidate: true,
          },
        },
        tx,
      );

      return {
        isMatched: true,
        matchedInvoiceId: invoice.id,
        confidenceTier: tier,
        varianceCents,
        requiresReview: false,
        reviewReason: reason,
      };
    }

    // Exact Candidate Match -> state = MATCHED (awaiting verification; invoice is NOT marked PAID yet!)
    await tx`
      UPDATE "normalized_payments"
      SET
        "state" = ${TransactionState.MATCHED}::"TransactionState",
        "confidence_tier" = ${tier},
        "candidate_invoice_id" = ${invoice.id},
        "matched_invoice_id" = ${invoice.id},
        "review_reason" = NULL,
        "updated_at" = NOW()
      WHERE "id" = ${payment.id} AND "organization_id" = ${payment.organizationId}
    `;

    await dbStore.insertOutboxEvent(
      {
        organizationId: payment.organizationId,
        eventType: BusinessEventType.PAYMENT_MATCHED,
        payload: {
          paymentId: payment.id,
          invoiceId: invoice.id,
          invoiceReference: invoice.referenceNumber,
          paymentReference: payment.reference,
          amountCents: payment.amountCents.toString(),
          confidenceTier: tier,
          verificationRequired: true,
        },
      },
      tx,
    );

    return {
      isMatched: true,
      matchedInvoiceId: invoice.id,
      confidenceTier: tier,
      varianceCents: 0n,
      requiresReview: false,
      reviewReason: null,
    };
  }

  /**
   * Steps 4, 5, & 6 of Payment Lifecycle: Independent or Manual Finance Verification & Invoice Settlement.
   * Executes inside an ACID PostgreSQL transaction with `SELECT ... FOR UPDATE` row-level locks.
   * 4. Records an immutable `PaymentVerification` record and transitions payment to `VERIFIED`.
   * 5. Updates the invoice's `paid_amount_cents`, `balance_cents`, and `status` (`PARTIALLY_PAID`, `PAID`, `OVERPAID`).
   * 6. Evaluates fulfillment eligibility and commits `payment.verified`, `invoice.paid` / `invoice.partially_paid`,
   *    and `fulfillment.eligible` outbox events atomically.
   */
  async verifyPayment(
    organizationId: string,
    dto: VerifyPaymentDto,
    existingTx?: SqlExecutor,
  ): Promise<VerificationSettlementResult> {
    assertTenantContext({ organizationId });

    if (dto.requireAuditMetadata) {
      if (!dto.externalVerificationRef || dto.externalVerificationRef.trim().length < 6) {
        throw new HttpException(
          400,
          'INVALID_EXTERNAL_VERIFICATION_REF',
          'externalVerificationRef must be at least 6 characters for manual reconciliation.',
        );
      }
      if (!dto.notes || dto.notes.trim().length < 10) {
        throw new HttpException(
          400,
          'INVALID_VERIFICATION_NOTES',
          'notes must be at least 10 characters for manual reconciliation.',
        );
      }
    } else {
      if (dto.externalVerificationRef !== undefined && dto.externalVerificationRef.trim().length < 6) {
        throw new HttpException(
          400,
          'INVALID_EXTERNAL_VERIFICATION_REF',
          'externalVerificationRef must be at least 6 characters when provided.',
        );
      }
      if (dto.notes !== undefined && dto.notes.trim().length < 10) {
        throw new HttpException(
          400,
          'INVALID_VERIFICATION_NOTES',
          'notes must be at least 10 characters when provided.',
        );
      }
    }

    const executeVerification = async (tx: SqlExecutor): Promise<VerificationSettlementResult> => {
      // Unlocked pre-lookup to derive canonical (provider, reference) BEFORE acquiring Level 4 payment lock
      const previewRows = await tx`
        SELECT "id", "provider", "reference", "device_id"
        FROM "normalized_payments"
        WHERE "id" = ${dto.paymentId} AND "organization_id" = ${organizationId}
      `;
      if (!previewRows[0]) {
        throw new HttpException(404, 'PAYMENT_NOT_FOUND', `Payment '${dto.paymentId}' not found in organization`);
      }

      // Lock Order Level 1 -> Level 2: Advisory reference lock + global claim verification/refresh
      const claimResult = await this.claimService.verifyOrRefreshManualClaim(tx, {
        provider: previewRows[0].provider,
        reference: previewRows[0].reference,
        organizationId,
        paymentId: dto.paymentId,
        verifiedById: dto.verifiedById ?? null,
        allowConfirmedClaimSameOrg: Boolean(dto.isProviderAuthenticated),
      });

      // Lock Order Level 4: Lock payment row
      const payRows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "id" = ${dto.paymentId} AND "organization_id" = ${organizationId}
        FOR UPDATE
      `;
      if (!payRows[0]) {
        throw new HttpException(404, 'PAYMENT_NOT_FOUND', `Payment '${dto.paymentId}' not found in organization`);
      }
      const payment = mapNormalizedPaymentRow(payRows[0]);

      if (payment.state === TransactionState.VERIFIED) {
        throw new HttpException(409, 'ALREADY_VERIFIED', `Payment '${dto.paymentId}' is already VERIFIED`);
      }
      if (payment.state === TransactionState.REJECTED || payment.state === TransactionState.DUPLICATE_REJECTED) {
        throw new HttpException(
          409,
          'TERMINAL_PAYMENT_STATE',
          `Payment '${dto.paymentId}' cannot be verified from terminal state '${payment.state}'`,
        );
      }

      // Enforce Separation of Duties on manual/human reconciliation:
      // The verifier cannot be the same user who paired the ingesting Android relay device.
      if (!dto.isProviderAuthenticated && payment.deviceId && dto.verifiedById) {
        const pairingRows = await tx`
          SELECT "created_by_id" FROM "pairing_tokens"
          WHERE "organization_id" = ${organizationId}
            AND "used_by_device_id" = ${payment.deviceId}
          LIMIT 1
        `;
        if (pairingRows[0]?.created_by_id === dto.verifiedById) {
          throw new HttpException(
            403,
            'SEPARATION_OF_DUTIES_VIOLATION',
            'Separation of duties violation: a user cannot verify a payment relayed by a device they paired.',
          );
        }
      }

      const targetInvoiceId = dto.invoiceId ?? payment.matchedInvoiceId ?? payment.candidateInvoiceId;
      if (!targetInvoiceId) {
        throw new HttpException(400, 'MISSING_INVOICE_ID', `Cannot verify payment '${dto.paymentId}' without a target invoiceId`);
      }

      // Lock Order Level 5: Lock target invoice row
      const invRows = await tx`
        SELECT * FROM "invoices"
        WHERE "id" = ${targetInvoiceId} AND "organization_id" = ${organizationId}
        FOR UPDATE
      `;
      if (!invRows[0]) {
        throw new HttpException(404, 'INVOICE_NOT_FOUND', `Target invoice '${targetInvoiceId}' not found in organization`);
      }
      const invoice = mapInvoiceRow(invRows[0]);

      const verificationState =
        dto.isProviderAuthenticated && claimResult.status === ClaimStatus.CONFIRMED_PROVIDER
          ? PaymentVerificationState.PROVIDER_AUTHENTICATED
          : PaymentVerificationState.HUMAN_ATTESTED;

      const previousPaymentState = payment.state;
      const previousInvoiceStatus = invoice.status;
      const previousPaidCents = invoice.paidAmountCents;
      const previousBalanceCents = invoice.balanceCents;

      const newPaidCents = previousPaidCents + payment.amountCents;
      const newBalanceCents =
        newPaidCents >= invoice.totalAmountCents ? 0n : invoice.totalAmountCents - newPaidCents;

      let newInvoiceStatus: InvoiceStatus;
      if (newPaidCents === invoice.totalAmountCents) {
        newInvoiceStatus = InvoiceStatus.PAID;
      } else if (newPaidCents > invoice.totalAmountCents) {
        newInvoiceStatus = InvoiceStatus.OVERPAID;
      } else {
        newInvoiceStatus = InvoiceStatus.PARTIALLY_PAID;
      }

      // 4. Create immutable PaymentVerification record
      const verificationId = randomUUID();
      const verRows = await tx`
        INSERT INTO "payment_verifications" (
          "id", "organization_id", "payment_id", "invoice_id",
          "verification_method", "decision", "verified_by_id",
          "external_verification_ref", "notes", "previous_state", "new_state"
        )
        VALUES (
          ${verificationId},
          ${organizationId},
          ${payment.id},
          ${invoice.id},
          ${dto.verificationMethod}::"VerificationMethod",
          'APPROVED',
          ${dto.verifiedById ?? null},
          ${dto.externalVerificationRef ?? null},
          ${dto.notes ?? null},
          ${previousPaymentState}::"TransactionState",
          ${TransactionState.VERIFIED}::"TransactionState"
        )
        RETURNING *
      `;
      const vr = verRows[0]!;
      const verification: PaymentVerificationRecord = {
        id: vr.id,
        organizationId: vr.organization_id,
        paymentId: vr.payment_id,
        invoiceId: vr.invoice_id ?? null,
        verificationMethod: vr.verification_method as VerificationMethod,
        decision: 'APPROVED',
        verifiedById: vr.verified_by_id ?? null,
        externalVerificationRef: vr.external_verification_ref ?? null,
        notes: vr.notes ?? null,
        previousState: vr.previous_state as TransactionState,
        newState: vr.new_state as TransactionState,
        createdAt: new Date(vr.created_at),
      };

      // Update NormalizedPayment to VERIFIED
      const updatedPayRows = await tx`
        UPDATE "normalized_payments"
        SET
          "state" = ${TransactionState.VERIFIED}::"TransactionState",
          "matched_invoice_id" = ${invoice.id},
          "candidate_invoice_id" = ${invoice.id},
          "verified_at" = NOW(),
          "verified_by_id" = ${dto.verifiedById ?? null},
          "updated_at" = NOW()
        WHERE "id" = ${payment.id} AND "organization_id" = ${organizationId}
        RETURNING *
      `;
      const updatedPayment = mapNormalizedPaymentRow(updatedPayRows[0]!);

      // 5. Record InvoicePayment & update Invoice balance atomically
      const invoicePaymentId = randomUUID();
      const ipRows = await tx`
        INSERT INTO "invoice_payments" (
          "id", "organization_id", "invoice_id", "payment_id", "verification_id", "applied_amount_cents"
        )
        VALUES (
          ${invoicePaymentId},
          ${organizationId},
          ${invoice.id},
          ${payment.id},
          ${verificationId},
          ${payment.amountCents.toString()}::bigint
        )
        RETURNING *
      `;
      const ipr = ipRows[0]!;
      const invoicePayment: InvoicePaymentRecord = {
        id: ipr.id,
        organizationId: ipr.organization_id,
        invoiceId: ipr.invoice_id,
        paymentId: ipr.payment_id,
        verificationId: ipr.verification_id ?? null,
        appliedAmountCents: BigInt(ipr.applied_amount_cents),
        createdAt: new Date(ipr.created_at),
      };

      const updatedInvRows = await tx`
        UPDATE "invoices"
        SET
          "paid_amount_cents" = ${newPaidCents.toString()}::bigint,
          "balance_cents" = ${newBalanceCents.toString()}::bigint,
          "status" = ${newInvoiceStatus}::"InvoiceStatus",
          "updated_at" = NOW()
        WHERE "id" = ${invoice.id} AND "organization_id" = ${organizationId}
        RETURNING *
      `;
      const updatedInvoice = mapInvoiceRow(updatedInvRows[0]!);

      // 6. Determine fulfillment eligibility & record immutable AuditLog + OutboxEvents
      const fulfillmentEligible =
        newInvoiceStatus === InvoiceStatus.PAID || newInvoiceStatus === InvoiceStatus.OVERPAID;

      await dbStore.recordAudit(
        {
          organizationId,
          actorId: dto.verifiedById ?? payment.id,
          actorType: dto.verifiedById ? 'USER' : 'SYSTEM',
          action: 'payment.verified',
          resourceType: 'normalized_payments',
          resourceId: payment.id,
          previousState: {
            paymentState: previousPaymentState,
            invoiceStatus: previousInvoiceStatus,
            paidAmountCents: previousPaidCents.toString(),
            balanceCents: previousBalanceCents.toString(),
          },
          newState: {
            paymentState: TransactionState.VERIFIED,
            verificationState,
            claimStatus: claimResult.status,
            invoiceStatus: newInvoiceStatus,
            paidAmountCents: newPaidCents.toString(),
            balanceCents: newBalanceCents.toString(),
            fulfillmentEligible,
          },
          metadata: {
            verificationId,
            verificationMethod: dto.verificationMethod,
            verificationState,
            claimId: claimResult.claimId,
            claimStatus: claimResult.status,
            externalVerificationRef: dto.externalVerificationRef ?? null,
            notes: dto.notes ?? null,
          },
        },
        tx,
      );

      await dbStore.insertOutboxEvent(
        {
          organizationId,
          eventType: BusinessEventType.PAYMENT_VERIFIED,
          payload: {
            paymentId: payment.id,
            verificationId,
            invoiceId: invoice.id,
            verificationMethod: dto.verificationMethod,
            verificationState,
            claimId: claimResult.claimId,
            claimStatus: claimResult.status,
            amountCents: payment.amountCents.toString(),
          },
        },
        tx,
      );

      if (newInvoiceStatus === InvoiceStatus.PAID || newInvoiceStatus === InvoiceStatus.OVERPAID) {
        await dbStore.insertOutboxEvent(
          {
            organizationId,
            eventType: BusinessEventType.INVOICE_PAID,
            payload: {
              invoiceId: invoice.id,
              referenceNumber: invoice.referenceNumber,
              totalAmountCents: invoice.totalAmountCents.toString(),
              paidAmountCents: newPaidCents.toString(),
              paymentId: payment.id,
              verificationId,
            },
          },
          tx,
        );

        await dbStore.insertOutboxEvent(
          {
            organizationId,
            eventType: BusinessEventType.FULFILLMENT_ELIGIBLE,
            payload: {
              invoiceId: invoice.id,
              referenceNumber: invoice.referenceNumber,
              paymentId: payment.id,
              verificationId,
            },
          },
          tx,
        );
        // A paid invoice in the billing workspace may be a customer's plan or credit payment: activate it atomically
        await activateBillingRequestForInvoice(tx, updatedInvoice);
        await activateCreditPurchaseForInvoice(tx, updatedInvoice);
      } else if (newInvoiceStatus === InvoiceStatus.PARTIALLY_PAID) {
        await dbStore.insertOutboxEvent(
          {
            organizationId,
            eventType: BusinessEventType.INVOICE_PARTIALLY_PAID,
            payload: {
              invoiceId: invoice.id,
              referenceNumber: invoice.referenceNumber,
              paidAmountCents: newPaidCents.toString(),
              remainingCents: newBalanceCents.toString(),
              paymentId: payment.id,
              verificationId,
            },
          },
          tx,
        );
      }

      return {
        payment: updatedPayment,
        verification,
        invoice: updatedInvoice,
        invoicePayment,
        fulfillmentEligible,
        verificationState,
        claimId: claimResult.claimId,
        claimStatus: claimResult.status,
      };
    };

    if (existingTx) {
      return executeVerification(existingTx);
    }

    return this.claimService.executeWithSerializationRetry(executeVerification);
  }

  /**
   * Rejects an unverified or flagged payment with an immutable audit & verification trail.
   */
  async rejectPayment(
    organizationId: string,
    dto: RejectPaymentDto,
    existingTx?: SqlExecutor,
  ): Promise<{ payment: NormalizedPaymentRecord; verification: PaymentVerificationRecord }> {
    assertTenantContext({ organizationId });

    return withTransaction(async (tx) => {
      const payRows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "id" = ${dto.paymentId} AND "organization_id" = ${organizationId}
        FOR UPDATE
      `;
      if (!payRows[0]) {
        throw new HttpException(404, 'PAYMENT_NOT_FOUND', `Payment '${dto.paymentId}' not found in organization`);
      }
      const payment = mapNormalizedPaymentRow(payRows[0]);
      if (payment.state === TransactionState.VERIFIED) {
        throw new HttpException(409, 'ALREADY_VERIFIED', `Cannot reject an already VERIFIED payment '${dto.paymentId}'`);
      }

      const previousState = payment.state;
      const verificationId = randomUUID();
      const verRows = await tx`
        INSERT INTO "payment_verifications" (
          "id", "organization_id", "payment_id", "invoice_id",
          "verification_method", "decision", "verified_by_id", "notes", "previous_state", "new_state"
        )
        VALUES (
          ${verificationId},
          ${organizationId},
          ${payment.id},
          ${payment.matchedInvoiceId ?? null},
          ${VerificationMethod.MANUAL_REJECTION}::"VerificationMethod",
          'REJECTED',
          ${dto.verifiedById},
          ${dto.notes},
          ${previousState}::"TransactionState",
          ${TransactionState.REJECTED}::"TransactionState"
        )
        RETURNING *
      `;
      const vr = verRows[0]!;
      const verification: PaymentVerificationRecord = {
        id: vr.id,
        organizationId: vr.organization_id,
        paymentId: vr.payment_id,
        invoiceId: vr.invoice_id ?? null,
        verificationMethod: vr.verification_method as VerificationMethod,
        decision: 'REJECTED',
        verifiedById: vr.verified_by_id ?? null,
        externalVerificationRef: null,
        notes: vr.notes ?? null,
        previousState: vr.previous_state as TransactionState,
        newState: vr.new_state as TransactionState,
        createdAt: new Date(vr.created_at),
      };

      const updatedPayRows = await tx`
        UPDATE "normalized_payments"
        SET
          "state" = ${TransactionState.REJECTED}::"TransactionState",
          "matched_invoice_id" = NULL,
          "review_reason" = ${dto.notes},
          "verified_by_id" = ${dto.verifiedById},
          "updated_at" = NOW()
        WHERE "id" = ${payment.id} AND "organization_id" = ${organizationId}
        RETURNING *
      `;
      const updatedPayment = mapNormalizedPaymentRow(updatedPayRows[0]!);

      await dbStore.recordAudit(
        {
          organizationId,
          actorId: dto.verifiedById,
          actorType: 'USER',
          action: 'payment.rejected',
          resourceType: 'normalized_payments',
          resourceId: payment.id,
          previousState: { state: previousState },
          newState: { state: TransactionState.REJECTED },
          metadata: { verificationId, notes: dto.notes },
        },
        tx,
      );

      await dbStore.insertOutboxEvent(
        {
          organizationId,
          eventType: BusinessEventType.PAYMENT_REJECTED,
          payload: {
            paymentId: payment.id,
            verificationId,
            reason: dto.notes,
          },
        },
        tx,
      );

      return { payment: updatedPayment, verification };
    }, existingTx);
  }

  async getPaymentVerifications(organizationId: string, paymentId: string): Promise<PaymentVerificationRecord[]> {
    assertTenantContext({ organizationId });
    const rows = await sql`
      SELECT * FROM "payment_verifications"
      WHERE "organization_id" = ${organizationId} AND "payment_id" = ${paymentId}
      ORDER BY "created_at" ASC
    `;
    return rows.map((vr) => ({
      id: vr.id,
      organizationId: vr.organization_id,
      paymentId: vr.payment_id,
      invoiceId: vr.invoice_id ?? null,
      verificationMethod: vr.verification_method as VerificationMethod,
      decision: vr.decision as 'APPROVED' | 'REJECTED',
      verifiedById: vr.verified_by_id ?? null,
      externalVerificationRef: vr.external_verification_ref ?? null,
      notes: vr.notes ?? null,
      previousState: vr.previous_state as TransactionState,
      newState: vr.new_state as TransactionState,
      createdAt: new Date(vr.created_at),
    }));
  }

  /**
   * Lists normalized payments for a tenant with optional filtering.
   */
  async listPayments(
    organizationId: string,
    filters?: { state?: TransactionState; provider?: string },
    tx: SqlExecutor = sql,
  ): Promise<NormalizedPaymentRecord[]> {
    assertTenantContext({ organizationId });
    if (filters?.state && filters?.provider) {
      const rows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${organizationId}
          AND "state" = ${filters.state}::"TransactionState"
          AND "provider" = ${filters.provider}::"PaymentProvider"
        ORDER BY "created_at" DESC
      `;
      return rows.map(mapNormalizedPaymentRow);
    }
    if (filters?.state) {
      const rows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${organizationId}
          AND "state" = ${filters.state}::"TransactionState"
        ORDER BY "created_at" DESC
      `;
      return rows.map(mapNormalizedPaymentRow);
    }
    if (filters?.provider) {
      const rows = await tx`
        SELECT * FROM "normalized_payments"
        WHERE "organization_id" = ${organizationId}
          AND "provider" = ${filters.provider}::"PaymentProvider"
        ORDER BY "created_at" DESC
      `;
      return rows.map(mapNormalizedPaymentRow);
    }
    const rows = await tx`
      SELECT * FROM "normalized_payments"
      WHERE "organization_id" = ${organizationId}
      ORDER BY "created_at" DESC
    `;
    return rows.map(mapNormalizedPaymentRow);
  }

  /**
   * Finds a normalized payment by ID strictly scoped to the tenant organization.
   */
  async findPaymentById(
    organizationId: string,
    paymentId: string,
    tx: SqlExecutor = sql,
  ): Promise<NormalizedPaymentRecord | null> {
    assertTenantContext({ organizationId });
    const rows = await tx`
      SELECT * FROM "normalized_payments"
      WHERE "id" = ${paymentId} AND "organization_id" = ${organizationId}
      LIMIT 1
    `;
    return rows[0] ? mapNormalizedPaymentRow(rows[0]) : null;
  }

  /**
   * Discovers candidate invoice matches for payments routed to REVIEW_REQUIRED or UNMATCHED.
   * Provides non-authoritative ranking to assist human finance operators without guessing.
   */
  async findCandidateInvoicesForPayment(
    organizationId: string,
    paymentId: string,
    tx: SqlExecutor = sql,
  ): Promise<CandidateMatchSuggestion[]> {
    assertTenantContext({ organizationId });

    const payment = await this.findPaymentById(organizationId, paymentId, tx);
    if (!payment) {
      return [];
    }

    const openRows = await tx`
      SELECT * FROM "invoices"
      WHERE "organization_id" = ${organizationId}
        AND "status" IN ('UNPAID', 'PARTIALLY_PAID')
      ORDER BY "created_at" DESC
      LIMIT 50
    `;
    const openInvoices = openRows.map(mapInvoiceRow);

    const payRef = (payment.customerMemo || payment.reference).trim().toUpperCase();
    const payPhone = this.normalizePhone(payment.senderPhone || '');
    const payName = (payment.senderName || '').trim().toLowerCase();

    const suggestions: CandidateMatchSuggestion[] = [];

    for (const inv of openInvoices) {
      let score = 0;
      const reasons: string[] = [];
      let tier = 'HEURISTIC';

      // 1. Reference check
      if (inv.referenceNumber.toUpperCase() === payRef) {
        score += 90;
        reasons.push('Exact reference match with payment memo');
        tier = MatchConfidenceTier.TIER_1_EXACT_REFERENCE;
      }

      // 2. Phone check
      const invPhone = this.normalizePhone(inv.customerPhone || '');
      if (payPhone && invPhone && payPhone === invPhone) {
        score += 45;
        reasons.push('Customer phone matches payment sender');
        if (score >= 90) {
          tier = MatchConfidenceTier.TIER_2_CUSTOMER_IDENTIFIER;
        }
      }

      // 3. Amount check
      if (inv.balanceCents === payment.amountCents) {
        score += 40;
        reasons.push('Payment amount exactly matches open invoice balance');
      } else if (inv.totalAmountCents === payment.amountCents) {
        score += 25;
        reasons.push('Payment amount matches total invoice amount');
      }

      // 4. Name check
      const invName = (inv.customerName || '').trim().toLowerCase();
      if (payName && invName && (payName === invName || payName.includes(invName) || invName.includes(payName))) {
        score += 20;
        reasons.push('Customer name matches payment sender');
      }

      if (score > 0) {
        suggestions.push({
          invoiceId: inv.id,
          referenceNumber: inv.referenceNumber,
          totalAmountCents: inv.totalAmountCents,
          balanceCents: inv.balanceCents,
          currency: inv.currency,
          status: inv.status,
          customerName: inv.customerName ?? null,
          customerPhone: inv.customerPhone ?? null,
          dueDate: inv.dueDate ?? null,
          confidenceScore: Math.min(100, score),
          confidenceTier: tier,
          matchReasons: reasons,
        });
      }
    }

    return suggestions.sort((a, b) => b.confidenceScore - a.confidenceScore);
  }

  private normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.startsWith('0') && digits.length === 10) {
      return `255${digits.slice(1)}`;
    }
    return digits;
  }
}

export const reconciliationService = new ReconciliationService();
