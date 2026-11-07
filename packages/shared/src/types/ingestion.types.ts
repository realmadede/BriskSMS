import { EvidenceSourceType } from '../enums/ingestion-source.enum.js';
import { TransactionState } from '../enums/transaction-state.enum.js';
import { PaymentProvider } from '../enums/payment-provider.enum.js';

/**
 * Common Evidence Ingestion Payload Envelope
 */
export interface IngestEvidenceDto {
  organizationId: string;
  sourceType: EvidenceSourceType;
  deviceId?: string;
  senderAddress: string;
  rawPayload: string;
  simSlot?: number;
  deviceTimestamp: Date;
  signature?: string;
  nonce?: string;
  sequenceNumber?: bigint;
}

/**
 * Universal Ingestion Acknowledgement
 */
export interface IngestionAckResult {
  acknowledged: boolean;
  evidenceId: string;
  deduplicationHash?: string;
  status: 'OBSERVED' | 'DUPLICATE' | 'PARSE_FAILED';
  matchedInvoiceId?: string | null;
  candidateInvoiceId?: string | null;
  paymentId?: string;
  amountCents?: string;
  reference?: string;
  parserVersion?: string;
  state?: TransactionState;
}

/**
 * Normalized Payment Record DTO
 */
export interface NormalizedPaymentRecordDto {
  id: string;
  organizationId: string;
  deviceId?: string | null;
  rawEvidenceId: string;
  provider: PaymentProvider;
  reference: string;
  amountCents: bigint;
  currency: string;
  senderPhone: string;
  senderName: string | null;
  recipientAccount: string | null;
  customerMemo: string | null;
  providerTimestamp: Date;
  parserVersion?: string;
  state: TransactionState;
  deduplicationHash: string;
  candidateInvoiceId?: string | null;
  matchedInvoiceId: string | null;
  verifiedAt?: Date | null;
  verifiedById?: string | null;
  createdAt: Date;
}
