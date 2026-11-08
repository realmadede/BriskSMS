import { GatewayMode, CampaignStatus } from '../enums/messaging.enum.js';

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
  status: 'PENDING' | 'DISPATCHED' | 'FAILED';
  rawResponse: Record<string, unknown>;
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
