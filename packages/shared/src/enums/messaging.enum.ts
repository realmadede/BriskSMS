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
 * Upstream SMS Aggregator Gateway Channel
 */
export enum SmsGatewayProvider {
  BEEM_AFRICA = 'BEEM_AFRICA',
  DARSMS = 'DARSMS',
  EHUB_FASTHUB = 'EHUB_FASTHUB',
  MOCK_TEST_GATEWAY = 'MOCK_TEST_GATEWAY',
}

