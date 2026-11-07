/**
 * Source Types for Universal Payment Evidence Ingestion
 */
export enum EvidenceSourceType {
  /** Ingested via BriskSMS Android NotificationListenerService */
  ANDROID_NOTIFICATION_RELAY = 'ANDROID_NOTIFICATION_RELAY',

  /** Direct official provider API webhook or push */
  DIRECT_PROVIDER_API = 'DIRECT_PROVIDER_API',

  /** Unified mobile money / payment aggregator */
  UNIFIED_AGGREGATOR = 'UNIFIED_AGGREGATOR',

  /** Bank core banking / direct host integration */
  BANK_INTEGRATION = 'BANK_INTEGRATION',

  /** Authorized merchant CSV/spreadsheet import */
  AUTHORIZED_MANUAL_IMPORT = 'AUTHORIZED_MANUAL_IMPORT',
}

/**
 * Granular Developer & Integration API Key Scopes
 */
export enum ApiKeyScope {
  SMS_SEND = 'sms:send',
  SMS_READ = 'sms:read',
  PAYMENTS_READ = 'payments:read',
  INVOICES_READ = 'invoices:read',
  INVOICES_WRITE = 'invoices:write',
  DEVICES_READ = 'devices:read',
  WEBHOOKS_MANAGE = 'webhooks:manage',
}

/**
 * System Domain Event Types for Webhook & Zapier Outbox
 */
export enum BusinessEventType {
  PAYMENT_EVIDENCE_RECEIVED = 'payment.evidence.received',
  PAYMENT_MATCHED = 'payment.matched',
  PAYMENT_NEEDS_REVIEW = 'payment.needs_review',
  PAYMENT_VERIFIED = 'payment.verified',
  PAYMENT_REJECTED = 'payment.rejected',
  INVOICE_PARTIALLY_PAID = 'invoice.partially_paid',
  INVOICE_PAID = 'invoice.paid',
  FULFILLMENT_ELIGIBLE = 'fulfillment.eligible',
  DEVICE_OFFLINE = 'device.offline',
  DEVICE_ONLINE = 'device.online',
  SMS_SENT = 'sms.sent',
  SMS_DELIVERED = 'sms.delivered',
  SMS_FAILED = 'sms.failed',
  CAMPAIGN_COMPLETED = 'campaign.completed',
  CAMPAIGN_FAILED = 'campaign.failed',
}

/**
 * Transactional Outbox Delivery Lifecycle Status
 */
export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  DEAD_LETTER = 'DEAD_LETTER',
}

/**
 * Independent Payment Verification Method
 */
export enum VerificationMethod {
  INDEPENDENT_PROVIDER_QUERY = 'INDEPENDENT_PROVIDER_QUERY',
  BANK_STATEMENT_RECONCILIATION = 'BANK_STATEMENT_RECONCILIATION',
  MANUAL_FINANCE_APPROVAL = 'MANUAL_FINANCE_APPROVAL',
  MANUAL_REJECTION = 'MANUAL_REJECTION',
}
