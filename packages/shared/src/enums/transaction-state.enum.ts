/**
 * Formal Financial Transaction States for BriskSMS
 * Strictly defined per docs/financial/FINANCIAL_INTEGRITY.md
 */
export enum TransactionState {
  /** Raw incoming notification payload received from registered device; persisted immutably */
  OBSERVED = 'OBSERVED',

  /** Parsed into canonical attributes (amount, reference, sender, timestamp) and validated */
  NORMALIZED = 'NORMALIZED',

  /** Identical deduplication hash detected within organization; terminal rejection */
  DUPLICATE_REJECTED = 'DUPLICATE_REJECTED',

  /** Normalized successfully, but no matching invoice found; queued for accountant review */
  UNMATCHED = 'UNMATCHED',

  /** Associated with open invoice or customer balance */
  MATCHED = 'MATCHED',

  /** Awaiting verification criteria or multi-factor checks */
  VERIFICATION_PENDING = 'VERIFICATION_PENDING',

  /** Confirmed authentic, settled, and authorized for accounting credit */
  VERIFIED = 'VERIFIED',

  /** Rejected as invalid, fraudulent, or disputed */
  REJECTED = 'REJECTED',

  /** Discrepancy detected (partial payment, overpayment, ambiguous reference); requires human review */
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',

  /** Verified transaction queued for downstream external action (MikroTik, WHMCS, Webhook) */
  FULFILLMENT_PENDING = 'FULFILLMENT_PENDING',

  /** Downstream external business action completed successfully with proof of execution */
  FULFILLED = 'FULFILLED',

  /** External integration action failed after max retries; payment remains VERIFIED */
  FULFILLMENT_FAILED = 'FULFILLMENT_FAILED',
}

/**
 * Valid state transition matrix
 * Dictates all legal transitions within the financial state machine
 */
export const VALID_TRANSACTION_TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> = {
  [TransactionState.OBSERVED]: [
    TransactionState.NORMALIZED,
    TransactionState.REJECTED,
    TransactionState.DUPLICATE_REJECTED,
  ],
  [TransactionState.NORMALIZED]: [
    TransactionState.MATCHED,
    TransactionState.UNMATCHED,
    TransactionState.REVIEW_REQUIRED,
    TransactionState.REJECTED,
  ],
  [TransactionState.DUPLICATE_REJECTED]: [], // Terminal
  [TransactionState.UNMATCHED]: [
    TransactionState.MATCHED,
    TransactionState.REVIEW_REQUIRED,
    TransactionState.REJECTED,
  ],
  [TransactionState.MATCHED]: [
    TransactionState.VERIFICATION_PENDING,
    TransactionState.VERIFIED,
    TransactionState.REVIEW_REQUIRED,
    TransactionState.REJECTED,
  ],
  [TransactionState.VERIFICATION_PENDING]: [
    TransactionState.VERIFIED,
    TransactionState.REVIEW_REQUIRED,
    TransactionState.REJECTED,
  ],
  [TransactionState.REVIEW_REQUIRED]: [
    TransactionState.VERIFIED,
    TransactionState.REJECTED,
  ],
  [TransactionState.VERIFIED]: [
    TransactionState.FULFILLMENT_PENDING,
  ],
  [TransactionState.REJECTED]: [], // Terminal
  [TransactionState.FULFILLMENT_PENDING]: [
    TransactionState.FULFILLED,
    TransactionState.FULFILLMENT_FAILED,
  ],
  [TransactionState.FULFILLED]: [], // Terminal
  [TransactionState.FULFILLMENT_FAILED]: [
    TransactionState.FULFILLMENT_PENDING, // Safe retry
  ],
};
