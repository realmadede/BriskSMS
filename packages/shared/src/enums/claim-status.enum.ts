/**
 * Canonical lifecycle state for global provider-reference claims.
 * Represents carrier-level platform uniqueness across all tenants.
 * Defined in docs/reports/P0_2_UNIFIED_PAYMENT_REFERENCE_CLAIM_DESIGN.md
 */
export enum ClaimStatus {
  /** Active temporary hold established by client-tier evidence (SMS) in a single organization. */
  PROVISIONAL = 'PROVISIONAL',

  /** Provisional hold window has lapsed without confirmation. Automated settlement is frozen. Not freed for cross-tenant grabbing. */
  EXPIRED = 'EXPIRED',

  /** Cryptographically authenticated carrier STK callback. Permanent, immutable carrier truth across all tenants. */
  CONFIRMED_PROVIDER = 'CONFIRMED_PROVIDER',

  /** Historical collision occupying the unique physical slot. Universal settlement lock across all channels. */
  UNRESOLVED_COLLISION = 'UNRESOLVED_COLLISION',

  /** Contested reference under cross-tenant investigation. Universal settlement lock across all channels. */
  DISPUTED = 'DISPUTED',

  /** Formally cancelled following an auditable decision proving the provider transaction never occurred. */
  RELEASED = 'RELEASED',
}

/**
 * Categorical authority tier of evidence supporting a claim.
 */
export enum ClaimEvidenceTier {
  /** Authoritative cryptographic carrier callback (STK / C2B). */
  AUTHORITATIVE_PROVIDER = 'AUTHORITATIVE_PROVIDER',

  /** Client-reported notification (Android companion SMS ingestion). */
  CLIENT_REPORTED = 'CLIENT_REPORTED',

  /** Conflicting or undetermined evidence tier (quarantine). */
  UNRESOLVED = 'UNRESOLVED',
}

/**
 * Append-only audit action logged to payment_reference_claim_events.
 */
export enum ClaimEventAction {
  PROVISIONALLY_CLAIMED = 'PROVISIONALLY_CLAIMED',
  SUPPLEMENTARY_ATTACHED = 'SUPPLEMENTARY_ATTACHED',
  EXPIRED = 'EXPIRED',
  CONFIRMED_PROVIDER = 'CONFIRMED_PROVIDER',
  SUPERSEDED_EVICTION = 'SUPERSEDED_EVICTION',
  COLLISION_QUARANTINED = 'COLLISION_QUARANTINED',
  DISPUTE_RAISED = 'DISPUTE_RAISED',
  ADJUDICATED_RESOLUTION = 'ADJUDICATED_RESOLUTION',
  RELEASED = 'RELEASED',
}
