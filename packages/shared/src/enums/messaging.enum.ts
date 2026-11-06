/**
 * SMS Message Delivery Status
 */
export enum SmsStatus {
  QUEUED = 'QUEUED',
  SUBMITTED = 'SUBMITTED',
  DELIVERED = 'DELIVERED',
  UNDELIVERED = 'UNDELIVERED',
  FAILED = 'FAILED',
}

/**
 * Bulk Campaign Lifecycle Status
 */
export enum CampaignStatus {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
  DISPATCHING = 'DISPATCHING',
  COMPLETED = 'COMPLETED',
  PAUSED = 'PAUSED',
  CANCELLED = 'CANCELLED',
}

/**
 * TCRA Alphanumeric Sender ID Verification Status
 */
export enum SenderIdStatus {
  PENDING_DOCUMENTS = 'PENDING_DOCUMENTS',
  SUBMITTED_TO_TCRA = 'SUBMITTED_TO_TCRA',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * Upstream SMS Gateway / Relay Provider Channel
 */
export enum SmsGatewayProvider {
  SMSGATE_SERVER = 'SMSGATE_SERVER',
  SMSGATE_CLOUD = 'SMSGATE_CLOUD',
  BEEM_AFRICA = 'BEEM_AFRICA',
  DARSMS = 'DARSMS',
  EHUB_FASTHUB = 'EHUB_FASTHUB',
  MOCK_TEST_GATEWAY = 'MOCK_TEST_GATEWAY',
}

/**
 * Gateway Deployment and Connection Mode
 */
export enum GatewayMode {
  /** Private BriskSMS dedicated gateway hosted on 24/7 VPS behind Cloudflare */
  MANAGED_GATEWAY = 'MANAGED_GATEWAY',

  /** External gateway relay connection */
  EXTERNAL_RELAY = 'EXTERNAL_RELAY',

  /** Direct telco aggregator connection (e.g. Beem Africa, DARSMS) */
  TELCO_AGGREGATOR = 'TELCO_AGGREGATOR',
}

