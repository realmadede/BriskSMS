import { randomUUID } from 'node:crypto';
import {
  InvoiceStatus,
  TransactionState,
  BusinessEventType,
  MatchConfidenceTier,
} from '@brisksms/shared';
import { dbStore, InvoiceRecord, NormalizedPaymentRecord, OutboxEventRecord } from '../../core/store.js';

export interface CreateInvoiceDto {
  referenceNumber: string;
  totalAmountCents: bigint;
  currency?: string;
  customerPhone?: string | null;
  customerName?: string | null;
  dueDate?: Date | null;
}

export interface ReconciliationResult {
  paymentId: string;
  state: TransactionState;
  matchedInvoiceId: string | null;
  confidenceTier: MatchConfidenceTier | null;
  reason?: string;
}

export class ReconciliationService {
  /**
   * Creates a commercial invoice in the ledger
   */
  public createInvoice(
    organizationId: string,
    dto: CreateInvoiceDto,
  ): InvoiceRecord {
    if (dto.totalAmountCents <= 0n) {
      throw new Error('Invoice totalAmountCents must be greater than zero');
    }

    const trimmedRef = dto.referenceNumber.trim().toUpperCase();
    const key = `${organizationId}:${trimmedRef}`;
    if (dbStore.invoicesByReference.has(key)) {
      throw new Error(`Invoice with referenceNumber '${trimmedRef}' already exists in organization`);
    }

    const now = new Date();
    const invoice: InvoiceRecord = {
      id: randomUUID(),
      organizationId,
      referenceNumber: trimmedRef,
      totalAmountCents: dto.totalAmountCents,
      paidAmountCents: 0n,
      currency: dto.currency ?? 'TZS',
      status: InvoiceStatus.UNPAID,
      customerPhone: dto.customerPhone?.trim() ?? null,
      customerName: dto.customerName?.trim() ?? null,
      dueDate: dto.dueDate ?? null,
      createdAt: now,
      updatedAt: now,
    };

    dbStore.invoices.set(invoice.id, invoice);
    dbStore.invoicesByReference.set(key, invoice.id);

    return invoice;
  }

  /**
   * Retrieves an invoice by ID with strict tenant isolation
   */
  public findInvoiceById(organizationId: string, invoiceId: string): InvoiceRecord | null {
    const invoice = dbStore.invoices.get(invoiceId);
    if (!invoice || invoice.organizationId !== organizationId) {
      return null;
    }
    return invoice;
  }

  /**
   * Retrieves an invoice by reference number
   */
  public findInvoiceByReference(organizationId: string, referenceNumber: string): InvoiceRecord | null {
    const key = `${organizationId}:${referenceNumber.trim().toUpperCase()}`;
    const invoiceId = dbStore.invoicesByReference.get(key);
    if (!invoiceId) {
      return null;
    }
    return this.findInvoiceById(organizationId, invoiceId);
  }

  /**
   * Lists invoices for an organization, optionally filtered by status
   */
  public listInvoices(organizationId: string, status?: InvoiceStatus): InvoiceRecord[] {
    const results: InvoiceRecord[] = [];
    for (const inv of dbStore.invoices.values()) {
      if (inv.organizationId === organizationId) {
        if (!status || inv.status === status) {
          results.push(inv);
        }
      }
    }
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Deterministic Reconciliation Waterfall:
   * Tier 1: Exact reference match against invoice referenceNumber
   * Tier 2: Customer phone + exact balance match
   * Tier 3/4: Underpayment / Overpayment / Ambiguous -> REVIEW_REQUIRED / UNMATCHED
   */
  public reconcilePayment(payment: NormalizedPaymentRecord): ReconciliationResult {
    const orgId = payment.organizationId;

    // 1. Emit evidence received event
    this.enqueueOutboxEvent(orgId, BusinessEventType.PAYMENT_EVIDENCE_RECEIVED, {
      paymentId: payment.id,
      provider: payment.provider,
      reference: payment.reference,
      amountCents: payment.amountCents.toString(),
      currency: payment.currency,
      senderPhone: payment.senderPhone,
      senderName: payment.senderName,
      receivedAt: payment.createdAt.toISOString(),
    });

    // Tier 1: Look for exact reference match (case-insensitive)
    let candidateInvoice = this.findInvoiceByReference(orgId, payment.reference);

    // If not found by payment.reference, check customer memo if present
    if (!candidateInvoice && payment.customerMemo) {
      candidateInvoice = this.findInvoiceByReference(orgId, payment.customerMemo);
    }

    if (candidateInvoice) {
      return this.applyPaymentToInvoice(
        payment,
        candidateInvoice,
        MatchConfidenceTier.TIER_1_EXACT_REFERENCE,
      );
    }

    // Tier 2: Customer Phone heuristic with open invoices
    const openInvoicesForPhone = this.findOpenInvoicesByPhone(orgId, payment.senderPhone);

    if (openInvoicesForPhone.length === 1) {
      const singleInvoice = openInvoicesForPhone[0]!;
      const balanceDue = singleInvoice.totalAmountCents - singleInvoice.paidAmountCents;

      // Exact amount match on single open invoice
      if (payment.amountCents === balanceDue) {
        return this.applyPaymentToInvoice(
          payment,
          singleInvoice,
          MatchConfidenceTier.TIER_2_CUSTOMER_IDENTIFIER,
        );
      }

      // Single open invoice, but partial or overpayment amount
      if (payment.amountCents < balanceDue) {
        return this.applyPaymentToInvoice(
          payment,
          singleInvoice,
          MatchConfidenceTier.TIER_2_CUSTOMER_IDENTIFIER,
        );
      }

      // Overpayment on single open invoice
      return this.applyPaymentToInvoice(
        payment,
        singleInvoice,
        MatchConfidenceTier.TIER_2_CUSTOMER_IDENTIFIER,
      );
    }

    if (openInvoicesForPhone.length > 1) {
      // Ambiguous: multiple open invoices exist for this phone number
      payment.state = TransactionState.REVIEW_REQUIRED;
      payment.updatedAt = new Date();

      this.enqueueOutboxEvent(orgId, BusinessEventType.PAYMENT_NEEDS_REVIEW, {
        paymentId: payment.id,
        reference: payment.reference,
        amountCents: payment.amountCents.toString(),
        senderPhone: payment.senderPhone,
        reason: 'Multiple open invoices found for phone number; manual review required',
        candidateInvoiceIds: openInvoicesForPhone.map((i) => i.id),
      });

      return {
        paymentId: payment.id,
        state: TransactionState.REVIEW_REQUIRED,
        matchedInvoiceId: null,
        confidenceTier: null,
        reason: 'Ambiguous multiple invoices for phone number',
      };
    }

    // Unmatched: No open invoice found
    payment.state = TransactionState.UNMATCHED;
    payment.updatedAt = new Date();

    return {
      paymentId: payment.id,
      state: TransactionState.UNMATCHED,
      matchedInvoiceId: null,
      confidenceTier: null,
      reason: 'No open invoice matching reference or phone',
    };
  }

  /**
   * Applies payment amount to the invoice within deterministic rules
   */
  private applyPaymentToInvoice(
    payment: NormalizedPaymentRecord,
    invoice: InvoiceRecord,
    confidenceTier: MatchConfidenceTier,
  ): ReconciliationResult {
    const previousPaid = invoice.paidAmountCents;
    const newPaid = previousPaid + payment.amountCents;
    const now = new Date();

    invoice.paidAmountCents = newPaid;
    invoice.updatedAt = now;

    payment.matchedInvoiceId = invoice.id;
    payment.updatedAt = now;

    if (newPaid === invoice.totalAmountCents) {
      // Exactly settled
      invoice.status = InvoiceStatus.PAID;
      payment.state = TransactionState.MATCHED;

      this.enqueueOutboxEvent(payment.organizationId, BusinessEventType.PAYMENT_MATCHED, {
        paymentId: payment.id,
        invoiceId: invoice.id,
        invoiceReference: invoice.referenceNumber,
        amountCents: payment.amountCents.toString(),
        totalAmountCents: invoice.totalAmountCents.toString(),
        confidenceTier,
      });

      this.enqueueOutboxEvent(payment.organizationId, BusinessEventType.INVOICE_PAID, {
        invoiceId: invoice.id,
        invoiceReference: invoice.referenceNumber,
        totalAmountCents: invoice.totalAmountCents.toString(),
        settledAt: now.toISOString(),
      });

      return {
        paymentId: payment.id,
        state: TransactionState.MATCHED,
        matchedInvoiceId: invoice.id,
        confidenceTier,
      };
    }

    if (newPaid < invoice.totalAmountCents) {
      // Underpayment / Partial settlement
      invoice.status = InvoiceStatus.PARTIALLY_PAID;
      payment.state = TransactionState.MATCHED;

      this.enqueueOutboxEvent(payment.organizationId, BusinessEventType.PAYMENT_MATCHED, {
        paymentId: payment.id,
        invoiceId: invoice.id,
        invoiceReference: invoice.referenceNumber,
        amountCents: payment.amountCents.toString(),
        balanceRemainingCents: (invoice.totalAmountCents - newPaid).toString(),
        status: InvoiceStatus.PARTIALLY_PAID,
        confidenceTier,
      });

      return {
        paymentId: payment.id,
        state: TransactionState.MATCHED,
        matchedInvoiceId: invoice.id,
        confidenceTier,
        reason: 'Partially paid invoice balance',
      };
    }

    // newPaid > invoice.totalAmountCents: Overpayment
    invoice.status = InvoiceStatus.OVERPAID;
    payment.state = TransactionState.REVIEW_REQUIRED;

    const overpaymentCents = newPaid - invoice.totalAmountCents;

    this.enqueueOutboxEvent(payment.organizationId, BusinessEventType.PAYMENT_MATCHED, {
      paymentId: payment.id,
      invoiceId: invoice.id,
      invoiceReference: invoice.referenceNumber,
      amountCents: payment.amountCents.toString(),
      confidenceTier,
      status: InvoiceStatus.OVERPAID,
    });

    this.enqueueOutboxEvent(payment.organizationId, BusinessEventType.INVOICE_PAID, {
      invoiceId: invoice.id,
      invoiceReference: invoice.referenceNumber,
      totalAmountCents: invoice.totalAmountCents.toString(),
      settledAt: now.toISOString(),
    });

    this.enqueueOutboxEvent(payment.organizationId, BusinessEventType.PAYMENT_NEEDS_REVIEW, {
      paymentId: payment.id,
      invoiceId: invoice.id,
      reason: `Overpayment of ${overpaymentCents.toString()} cents requires accountant excess credit allocation`,
    });

    return {
      paymentId: payment.id,
      state: TransactionState.REVIEW_REQUIRED,
      matchedInvoiceId: invoice.id,
      confidenceTier,
      reason: `Overpaid by ${overpaymentCents.toString()} cents`,
    };
  }

  /**
   * Helper to find active open invoices by customer phone
   */
  private findOpenInvoicesByPhone(organizationId: string, phone: string): InvoiceRecord[] {
    if (!phone) return [];
    const normalizedTarget = phone.replace(/\D/g, '');
    const results: InvoiceRecord[] = [];

    for (const inv of dbStore.invoices.values()) {
      if (
        inv.organizationId === organizationId &&
        (inv.status === InvoiceStatus.UNPAID || inv.status === InvoiceStatus.PARTIALLY_PAID) &&
        inv.customerPhone
      ) {
        const invPhone = inv.customerPhone.replace(/\D/g, '');
        if (invPhone && (invPhone.endsWith(normalizedTarget) || normalizedTarget.endsWith(invPhone))) {
          results.push(inv);
        }
      }
    }

    return results;
  }

  /**
   * Appends an event to the Transactional Outbox
   */
  public enqueueOutboxEvent(
    organizationId: string,
    eventType: BusinessEventType,
    payload: Record<string, unknown>,
  ): OutboxEventRecord {
    const event: OutboxEventRecord = {
      id: randomUUID(),
      organizationId,
      eventType,
      payload,
      isDelivered: false,
      attemptCount: 0,
      createdAt: new Date(),
    };
    dbStore.outboxEvents.push(event);
    return event;
  }
}
