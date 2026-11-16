import { PaymentProvider } from '../enums/payment-provider.enum.js';
import { ClaimStatus, ClaimEvidenceTier } from '../enums/claim-status.enum.js';
import { PaymentVerificationState } from '../enums/payment-verification-state.enum.js';

/**
 * Validated tenant-local financial evidence for a provisional/expired claim holder.
 * Allows callers that already locked/inspected tenant books to pass explicit settlement
 * or attestation state alongside the claim service's intra-transaction DB inspection.
 */
export interface HoldingTenantFinancialState {
  verificationState?: PaymentVerificationState;
  isHumanAttested?: boolean;
  isSettled?: boolean;
  hasAccountingEntry?: boolean;
}

export interface AcquireClaimLockTarget {
  provider: PaymentProvider;
  reference: string;
}

export interface SerializationRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

export interface AcquireProvisionalClaimParams {
  provider: PaymentProvider;
  reference: string;
  organizationId: string;
  paymentId?: string;
  holdDurationMs?: number;
}

export interface AttachSupplementaryEvidenceParams {
  provider: PaymentProvider;
  reference: string;
  organizationId: string;
  amountCents: bigint;
  currency: string;
  senderPhone?: string;
  rawEvidenceId: string;
}

export interface ConfirmProviderReferenceParams {
  provider: PaymentProvider;
  reference: string;
  organizationId: string;
  checkoutId?: string;
  paymentId?: string;
  amountCents: bigint;
  currency: string;
  holdingTenantEvidence?: HoldingTenantFinancialState;
}

export interface TransferProvisionalOwnershipParams {
  provider: PaymentProvider;
  reference: string;
  newOrganizationId: string;
  newCheckoutId?: string;
  newPaymentId?: string;
  holdingTenantEvidence?: HoldingTenantFinancialState;
}

export interface AdjudicateCollisionParams {
  claimId: string;
  awardedOrganizationId?: string; // If undefined, reference is formally released
  awardedPaymentId?: string;
  awardedCheckoutId?: string;
  adjudicatorId: string;
  rationale: string;
}

export type ClaimTransitionOutcome =
  | 'CLAIM_ACQUIRED'
  | 'SUPPLEMENTARY_MATCH'
  | 'CONFIRMED'
  | 'SUPERSEDED_EVICTED'
  | 'COLLISION_LOCKED'
  | 'DISPUTE_RAISED'
  | 'RECLAIMED_IN_PLACE';

export interface ClaimTransitionResult {
  outcome: ClaimTransitionOutcome;
  claimId: string;
  status: ClaimStatus;
  paymentId?: string;
}

export interface PaymentReferenceClaimRecord {
  id: string;
  provider: PaymentProvider;
  providerReference: string;
  organizationId: string | null;
  checkoutId: string | null;
  paymentId: string | null;
  status: ClaimStatus;
  evidenceTier: ClaimEvidenceTier;
  claimedAt: Date;
  expiresAt: Date | null;
  confirmedAt: Date | null;
  confirmedById: string | null;
  releaseReason: string | null;
  version: number;
  updatedAt: Date;
}
