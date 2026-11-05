import { PaymentProvider } from '../enums/payment-provider.enum.js';
import { TransactionState } from '../enums/transaction-state.enum.js';
import { CurrencyCode } from '../enums/credit-ledger.enum.js';

/**
 * Raw notification incoming from the Android relay
 */
export interface RawNotificationPayload {
  deviceId: string;
  senderAddress: string;
  body: string;
  simSlot: number;
  deviceTimestamp: string;
  signature: string;
  nonce: string;
  sequenceNumber: number;
}

/**
 * Canonical normalized payment transaction record
 */
export interface NormalizedTransaction {
  id: string;
  organizationId: string;
  deviceId: string;
  rawEvidenceId: string;
  provider: PaymentProvider;
  reference: string;
  amountCents: bigint;
  currency: CurrencyCode;
  senderPhone: string;
  senderName: string | null;
  recipientAccount: string | null;
  customerMemo: string | null;
  providerTimestamp: Date;
  state: TransactionState;
  deduplicationHash: string;
  matchedInvoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

