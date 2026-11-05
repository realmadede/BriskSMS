/**
 * Bulk Messaging Prepaid Credit Ledger Entry Type (Product B)
 */
export enum CreditLedgerEntryType {
  /** Merchant purchased an SMS credit package */
  PURCHASE = 'PURCHASE',

  /** Credits atomically deducted for outbound SMS dispatches */
  USAGE_DEDUCTION = 'USAGE_DEDUCTION',

  /** Credits refunded due to permanent telco delivery failure */
  REFUND = 'REFUND',

  /** Administrative correction or promotional bonus */
  ADMIN_ADJUSTMENT = 'ADMIN_ADJUSTMENT',
}

/**
 * Currency ISO 4217 Codes
 */
export enum CurrencyCode {
  TZS = 'TZS',
  KES = 'KES',
  UGX = 'UGX',
  USD = 'USD',
}

