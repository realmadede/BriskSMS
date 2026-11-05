/**
 * Commercial Invoice Lifecycle Status
 */
export enum InvoiceStatus {
  /** Invoice issued; zero payment applied */
  UNPAID = 'UNPAID',

  /** Payment received < total invoice balance */
  PARTIALLY_PAID = 'PARTIALLY_PAID',

  /** Fully settled; balance == 0 */
  PAID = 'PAID',

  /** Payment received > total invoice balance; excess credit pending allocation */
  OVERPAID = 'OVERPAID',

  /** Cancelled or invalidated by administrator */
  VOID = 'VOID',

  /** Funds refunded back to customer */
  REFUNDED = 'REFUNDED',
}

/**
 * Invoice matching confidence tier
 */
export enum MatchConfidenceTier {
  /** Tier 1: Exact invoice reference or transaction memo */
  TIER_1_EXACT_REFERENCE = 'TIER_1_EXACT_REFERENCE',

  /** Tier 2: Customer phone number / unique customer identifier with 1 open invoice */
  TIER_2_CUSTOMER_IDENTIFIER = 'TIER_2_CUSTOMER_IDENTIFIER',

  /** Tier 3: Active checkout session window with matching exact amount */
  TIER_3_TIME_WINDOW_CHECKOUT = 'TIER_3_TIME_WINDOW_CHECKOUT',

  /** Tier 4: Manual human approval by accountant */
  TIER_4_MANUAL_MATCH = 'TIER_4_MANUAL_MATCH',
}
