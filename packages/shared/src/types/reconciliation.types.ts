import { InvoiceStatus, MatchConfidenceTier } from '../enums/invoice-status.enum.js';
import { CurrencyCode } from '../enums/credit-ledger.enum.js';

export interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: bigint;
  totalPriceCents: bigint;
}

export interface InvoiceDto {
  id: string;
  organizationId: string;
  customerId: string;
  referenceNumber: string;
  totalAmountCents: bigint;
  balanceCents: bigint;
  currency: CurrencyCode;
  status: InvoiceStatus;
  dueDate: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReconciliationMatchResult {
  isMatched: boolean;
  matchedInvoiceId: string | null;
  confidenceTier: MatchConfidenceTier | null;
  varianceCents: bigint;
  requiresReview: boolean;
  reviewReason: string | null;
}

