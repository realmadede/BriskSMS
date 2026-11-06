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
 * Normalized Gateway Delivery Event
 */
export interface NormalizedDeliveryEvent {
  providerMessageId: string;
  eventType: 'SENT' | 'DELIVERED' | 'FAILED';
  failureReason?: string;
  carrierTimestamp: Date;
}

/**
 * Gateway Connection Credentials
 */
export interface GatewayCredentials {
  mode: GatewayMode;
  baseUrl: string;
  apiToken: string;
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
  apiToken?: string;
  defaultSimSlot?: number;
}
