import { PaymentProvider, CurrencyCode } from '@brisksms/shared';

/**
 * Result of parsing a raw provider payment notification
 */
export interface ParsedPaymentResult {
  /** Identified payment provider */
  provider: PaymentProvider;

  /** Canonical transaction reference (e.g. 'QA12BC34DE') */
  reference: string;

  /** Total amount received in integer minor units (cents) */
  amountCents: bigint;

  /** Currency code */
  currency: CurrencyCode;

  /** Phone number or account of sender */
  senderPhone: string;

  /** Payer's full name if included in SMS */
  senderName: string | null;

  /** Receiving paybill/till/account number */
  recipientAccount: string | null;

  /** Transaction memo / customer reference extracted from text */
  customerMemo: string | null;

  /** Provider timestamp stated in SMS message */
  providerTimestamp: Date;

  /** The original unparsed text */
  rawText: string;
}

/**
 * Contract implemented by every payment provider parser adapter
 */
export interface IProviderAdapter {
  readonly provider: PaymentProvider;

  /** Returns true if this adapter handles the sender address or message pattern */
  canParse(senderAddress: string, body: string): boolean;

  /** Parses the text and returns structured financial result, or null if invalid */
  parse(body: string, defaultDate?: Date): ParsedPaymentResult | null;
}
