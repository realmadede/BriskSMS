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
  CANCELED = 'CANCELED',
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
 * Gateway Deployment and Connection Mode
 */
export enum GatewayMode {
  /** Private BriskSMS dedicated SMSGate server hosted on 24/7 VPS behind Cloudflare */
  MANAGED_GATEWAY = 'MANAGED_GATEWAY',

  /** External SMSGate relay connection (api.sms-gate.app) */
  EXTERNAL_RELAY = 'EXTERNAL_RELAY',
}

/**
 * Durable Message Idempotency Lifecycle State
 */
export enum MessageIdempotencyStatus {
  PENDING = 'PENDING',
  DISPATCHING = 'DISPATCHING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  UNCERTAIN = 'UNCERTAIN',
}

/**
 * Durable Android Outbound SMSGate Job Lifecycle State
 */
export enum OutboundSmsJobStatus {
  QUEUED = 'QUEUED',
  CLAIMED = 'CLAIMED',
  DISPATCHING = 'DISPATCHING',
  SUBMITTED = 'SUBMITTED',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
  UNCERTAIN = 'UNCERTAIN',
  CANCELLED = 'CANCELLED',
}


