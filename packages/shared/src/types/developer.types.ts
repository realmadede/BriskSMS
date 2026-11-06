import { ApiKeyScope, BusinessEventType } from '../enums/ingestion-source.enum.js';

/**
 * Scoped API Key Entity DTO
 */
export interface ApiKeyDto {
  id: string;
  organizationId: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt?: Date | null;
  createdAt: Date;
  revokedAt?: Date | null;
}

/**
 * Create API Key Request DTO
 */
export interface CreateApiKeyDto {
  organizationId: string;
  name: string;
  scopes: ApiKeyScope[];
}

/**
 * Newly Issued API Key with One-Time Secret Display
 */
export interface CreatedApiKeyResult {
  apiKey: ApiKeyDto;
  plainTextSecret: string;
}

/**
 * Webhook Target Subscription DTO
 */
export interface WebhookEndpointDto {
  id: string;
  organizationId: string;
  targetUrl: string;
  subscribedEvents: BusinessEventType[];
  isActive: boolean;
  signingSecret: string;
  createdAt: Date;
}

/**
 * Create Webhook Target Request DTO
 */
export interface CreateWebhookEndpointDto {
  organizationId: string;
  targetUrl: string;
  subscribedEvents: BusinessEventType[];
}

/**
 * Transactional Outbox Event DTO
 */
export interface OutboxEventRecordDto {
  id: string;
  organizationId: string;
  eventType: BusinessEventType;
  payload: Record<string, unknown>;
  isDelivered: boolean;
  attemptCount: number;
  lastAttemptAt?: Date | null;
  createdAt: Date;
}
