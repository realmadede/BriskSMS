/**
 * Commercial Product Types
 * Product A (Payment Intelligence) and Product B (Bulk Messaging) are distinct commercial products.
 */
export enum ProductType {
  PAYMENT_INTELLIGENCE = 'PAYMENT_INTELLIGENCE',
  BULK_MESSAGING = 'BULK_MESSAGING',
}

/**
 * Standard Recurring Billing Intervals
 */
export enum BillingInterval {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  SEMI_ANNUALLY = 'SEMI_ANNUALLY',
  ANNUALLY = 'ANNUALLY',
  CUSTOM = 'CUSTOM',
}

/**
 * Lifecycle states of an organization's subscription
 */
export enum SubscriptionStatus {
  TRIALING = 'TRIALING',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  SUSPENDED = 'SUSPENDED',
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
}

/**
 * Types of plan entitlement configurations
 */
export enum EntitlementType {
  NUMERIC_LIMIT = 'NUMERIC_LIMIT', // e.g., max_devices: 3, max_members: 5
  BOOLEAN_FLAG = 'BOOLEAN_FLAG',   // e.g., api_access: true, zapier: true
  TIERED_TIER = 'TIERED_TIER',     // e.g., reconciliation_depth: ADVANCED
}

/**
 * Canonical Feature Keys used in dynamic plan entitlement evaluations
 */
export enum FeatureKey {
  MAX_CONNECTED_DEVICES = 'MAX_CONNECTED_DEVICES',
  MAX_ORGANIZATION_MEMBERS = 'MAX_ORGANIZATION_MEMBERS',
  MAX_PAYMENT_ACCOUNTS = 'MAX_PAYMENT_ACCOUNTS',
  API_ACCESS = 'API_ACCESS',
  WEBHOOK_ACCESS = 'WEBHOOK_ACCESS',
  ZAPIER_INTEGRATION = 'ZAPIER_INTEGRATION',
  MIKROTIK_INTEGRATION = 'MIKROTIK_INTEGRATION',
  RECONCILIATION_AUTOMATION = 'RECONCILIATION_AUTOMATION',
  BULK_MESSAGING_ENABLED = 'BULK_MESSAGING_ENABLED',
  HISTORICAL_DATA_MONTHS = 'HISTORICAL_DATA_MONTHS',
}
