/**
 * Tenant-local payment verification state for financial accounting.
 * Strictly decoupled from global carrier-level claim lifecycle.
 * Defined in docs/reports/P0_2_UNIFIED_PAYMENT_REFERENCE_CLAIM_DESIGN.md
 */
export enum PaymentVerificationState {
  /** Ingested payment pending verification. */
  UNVERIFIED = 'UNVERIFIED',

  /** Verified by tenant finance user with mandatory external reference and notes under tenant policy safeguards. */
  HUMAN_ATTESTED = 'HUMAN_ATTESTED',

  /** Cryptographically authenticated by carrier callback. */
  PROVIDER_AUTHENTICATED = 'PROVIDER_AUTHENTICATED',

  /** Rejected as invalid, fraudulent, or mismatched. */
  REJECTED = 'REJECTED',

  /** Discrepancy detected (partial payment, overpayment, collision quarantine); requires human review. */
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
}
