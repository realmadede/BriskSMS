export interface WebhookEventPayload<T = unknown> {
  id: string;
  organizationId: string;
  eventType: string;
  timestamp: string;
  apiVersion: string;
  data: T;
}

export interface WebhookEndpointConfig {
  id: string;
  organizationId: string;
  url: string;
  secret: string;
  subscribedEvents: string[];
  isActive: boolean;
  createdAt: Date;
}
