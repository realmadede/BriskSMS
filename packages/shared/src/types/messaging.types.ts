import {
  GatewayMode,
  CampaignStatus,
  MessageIdempotencyStatus,
  OutboundSmsJobStatus,
} from '../enums/messaging.enum.js';

/**
 * Message Dispatch Request Payload
 */
export interface MessageDispatchPayload {
  organizationId: string;
  campaignId?: string;
  from?: string;
  to: string;
  content: string;
  idempotencyKey: string;
  simSlot?: number;
  scheduledAt?: Date;
}

/**
 * Provider Message Dispatch Result
 */
export interface MessageDispatchResult {
  providerMessageId: string;
  status: 'PENDING' | 'DISPATCHED' | 'FAILED' | 'UNCERTAIN';
  rawResponse: Record<string, unknown>;
}

/**
 * Durable Message Idempotency Record
 */
export interface MessageIdempotencyRecord {
  id: string;
  organizationId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: MessageIdempotencyStatus;
  messageId: string | null;
  responsePayload?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Explicit Gateway Authentication Types
 */
export type GatewayAuthType = 'BASIC' | 'BEARER';

export interface BasicGatewayAuth {
  type: 'BASIC';
  username: string;
  password: string;
}

export interface BearerGatewayAuth {
  type: 'BEARER';
  token: string;
}

export type GatewayAuthCredentials = BasicGatewayAuth | BearerGatewayAuth;

/**
 * Normalized Gateway Delivery Event
 */
export interface NormalizedDeliveryEvent {
  providerMessageId: string;
  eventType: 'SENT' | 'DELIVERED' | 'FAILED';
  failureReason?: string;
  carrierTimestamp: Date;
  rawTimestamp?: string;
  deviceId?: string;
  upstreamEventId?: string;
  simNumber?: number;
  recipient?: string;
  rawEvent?: string;
}

/**
 * Gateway Connection Credentials
 */
export interface GatewayCredentials {
  mode: GatewayMode;
  baseUrl: string;
  auth?: GatewayAuthCredentials;
  apiToken?: string;
  defaultSimSlot?: number;
}

/**
 * Ingested Campaign Recipient Row
 */
export interface CampaignRecipientRow {
  phoneNumber: string;
  variables: Record<string, string>;
  rawRowIndex: number;
}

/**
 * Recipient Ingestion Validation Result
 */
export interface RecipientValidationResult {
  validRecipients: CampaignRecipientRow[];
  invalidCount: number;
  duplicateCount: number;
  totalParsed: number;
}

/**
 * Campaign Dispatch Summary
 */
export interface CampaignDispatchSummary {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  totalRecipients: number;
  creditsDeducted: number;
  dispatchedAt: Date;
}

/**
 * Messaging Account DTO
 */
export interface MessagingAccountDto {
  organizationId: string;
  creditBalance: number;
  gatewayMode: GatewayMode;
  gatewayBaseUrl?: string;
  defaultSimSlot: number;
  isActive: boolean;
}

/**
 * Gateway Configuration Update DTO
 */
export interface UpdateGatewayConfigDto {
  gatewayMode: GatewayMode;
  gatewayBaseUrl?: string;
  auth?: GatewayAuthCredentials;
  apiToken?: string;
  defaultSimSlot?: number;
}

export type OutboundSmsDispatchOutcome = 'SUBMITTED' | 'DELIVERED' | 'FAILED' | 'UNCERTAIN';

export interface OutboundSmsJob {
  id: string;
  organizationId: string;
  messageId: string;
  assignedDeviceId: string | null;
  claimedByDeviceId: string | null;
  idempotencyKey: string | null;
  recipientPhone: string;
  messageText: string;
  simSlot: number;
  status: OutboundSmsJobStatus;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  expiresAt: string;
  attemptCount: number;
  maxAttempts: number;
  claimedAt: string | null;
  dispatchStartedAt: string | null;
  submittedAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  gatewayReference: string | null;
  radioResultCode: number | null;
  failureCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueOutboundSmsJobRequest {
  to: string;
  content: string;
  simSlot?: number;
  deviceId?: string;
  isPromotional?: boolean;
  campaignId?: string;
  idempotencyKey?: string;
  ttlSeconds?: number;
  maxAttempts?: number;
}

export interface AcquireOutboundSmsJobsRequest {
  limit?: number;
  leaseSeconds?: number;
  availableSimSlots?: number[];
}

export interface StartOutboundSmsDispatchRequest {
  leaseToken: string;
  simSlot?: number;
}

export interface ReportOutboundSmsJobResultRequest {
  leaseToken: string;
  outcome: OutboundSmsDispatchOutcome;
  simSlot?: number;
  partsCount?: number;
  radioResultCode?: number;
  gatewayReference?: string;
  errorMessage?: string;
  failureCode?: string;
  preRadioFailure?: boolean;
  carrierTimestamp?: string;
}

export interface OutboundSmsJobResultResponse {
  accepted: boolean;
  idempotentReplay: boolean;
  job: OutboundSmsJob;
}
