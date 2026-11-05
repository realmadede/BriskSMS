/**
 * Supported Tanzanian Payment Providers and Banking Channels
 */
export enum PaymentProvider {
  /** Vodacom M-Pesa Tanzania */
  MPESA = 'MPESA',

  /** Mixx by Yas (formerly Tigo Pesa) */
  MIXX = 'MIXX',

  /** Airtel Money Tanzania */
  AIRTEL_MONEY = 'AIRTEL_MONEY',

  /** HaloPesa (Halotel Tanzania) */
  HALOPESA = 'HALOPESA',

  /** TTCL Pesa (Tanzania Telecommunications Corporation) */
  TTCL_PESA = 'TTCL_PESA',

  /** CRDB Bank (SimBanking and Transactional Alerts) */
  CRDB_BANK = 'CRDB_BANK',

  /** NMB Bank (NMB Mkononi and Transactional Alerts) */
  NMB_BANK = 'NMB_BANK',

  /** Generic or Manual Bank Deposit */
  MANUAL_BANK_TRANSFER = 'MANUAL_BANK_TRANSFER',
}

/**
 * Provider category classification
 */
export enum ProviderCategory {
  MOBILE_MONEY = 'MOBILE_MONEY',
  COMMERCIAL_BANK = 'COMMERCIAL_BANK',
  MANUAL = 'MANUAL',
}

export const PROVIDER_CATEGORIES: Readonly<Record<PaymentProvider, ProviderCategory>> = {
  [PaymentProvider.MPESA]: ProviderCategory.MOBILE_MONEY,
  [PaymentProvider.MIXX]: ProviderCategory.MOBILE_MONEY,
  [PaymentProvider.AIRTEL_MONEY]: ProviderCategory.MOBILE_MONEY,
  [PaymentProvider.HALOPESA]: ProviderCategory.MOBILE_MONEY,
  [PaymentProvider.TTCL_PESA]: ProviderCategory.MOBILE_MONEY,
  [PaymentProvider.CRDB_BANK]: ProviderCategory.COMMERCIAL_BANK,
  [PaymentProvider.NMB_BANK]: ProviderCategory.COMMERCIAL_BANK,
  [PaymentProvider.MANUAL_BANK_TRANSFER]: ProviderCategory.MANUAL,
};
