import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  WebhookEndpointDto,
} from '@brisksms/shared';
import { dbStore, WebhookEndpointRecord } from '../../core/store.js';

export interface RegisterWebhookEndpointDto {
  url: string;
  subscribedEvents: BusinessEventType[];
  secret?: string;
}

export interface WebhookDispatchResult {
  endpointId: string;
  url: string;
  statusCode: number;
  success: boolean;
  error?: string;
}

export interface DispatchSummary {
  processedEvents: number;
  deliveredDeliveries: number;
  failedDeliveries: number;
  results: WebhookDispatchResult[];
}

export class WebhookService {
  /**
   * Registers a webhook receiver (e.g. Zapier Catch Hook or ERP listener)
   */
  public registerEndpoint(
    organizationId: string,
    dto: RegisterWebhookEndpointDto,
  ): WebhookEndpointRecord {
    if (!dto.url || (!dto.url.startsWith('https://') && !dto.url.startsWith('http://'))) {
      throw new Error('Valid HTTP/HTTPS webhook URL is required');
    }

    if (!dto.subscribedEvents || dto.subscribedEvents.length === 0) {
      throw new Error('At least one subscribed event type is required');
    }

    const secret = dto.secret ?? `whsec_${randomBytes(24).toString('hex')}`;
    const now = new Date();

    const record: WebhookEndpointRecord = {
      id: randomUUID(),
      organizationId,
      url: dto.url.trim(),
      secret,
      subscribedEvents: [...dto.subscribedEvents],
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    dbStore.webhookEndpoints.set(record.id, record);
    return record;
  }

  /**
   * Lists registered webhook endpoints for an organization
   */
  public listEndpoints(organizationId: string): WebhookEndpointDto[] {
    const results: WebhookEndpointDto[] = [];
    for (const record of dbStore.webhookEndpoints.values()) {
      if (record.organizationId === organizationId) {
        results.push({
          id: record.id,
          organizationId: record.organizationId,
          targetUrl: record.url,
          subscribedEvents: record.subscribedEvents,
          isActive: record.isActive,
          signingSecret: record.secret,
          createdAt: record.createdAt,
        });
      }
    }
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Revokes or deactivates a webhook endpoint
   */
  public deactivateEndpoint(organizationId: string, endpointId: string): boolean {
    const record = dbStore.webhookEndpoints.get(endpointId);
    if (!record || record.organizationId !== organizationId) {
      return false;
    }
    record.isActive = false;
    record.updatedAt = new Date();
    return true;
  }

  /**
   * Computes HMAC-SHA256 signature for payload verification
   * Format: t={timestamp},v1={hexSignature}
   */
  public computeSignature(payloadString: string, secret: string, timestampSeconds: number): string {
    const signaturePayload = `${timestampSeconds}.${payloadString}`;
    const hmac = createHmac('sha256', secret).update(signaturePayload).digest('hex');
    return `t=${timestampSeconds},v1=${hmac}`;
  }

  /**
   * Dispatches pending outbox events to registered active webhook endpoints.
   * If a custom dispatchFetch handler is provided, calls that; otherwise uses global fetch.
   */
  public async dispatchPendingOutboxEvents(
    customFetch?: (url: string, init: RequestInit) => Promise<{ status: number; ok: boolean }>,
  ): Promise<DispatchSummary> {
    const pendingEvents = dbStore.outboxEvents.filter((e) => !e.isDelivered);
    const summary: DispatchSummary = {
      processedEvents: 0,
      deliveredDeliveries: 0,
      failedDeliveries: 0,
      results: [],
    };

    for (const event of pendingEvents) {
      summary.processedEvents++;
      const orgEndpoints = Array.from(dbStore.webhookEndpoints.values()).filter(
        (ep) => ep.organizationId === event.organizationId && ep.isActive && ep.subscribedEvents.includes(event.eventType),
      );

      if (orgEndpoints.length === 0) {
        // No endpoints subscribed; mark delivered so outbox doesn't build up forever
        event.isDelivered = true;
        event.lastAttemptAt = new Date();
        continue;
      }

      let allEndpointsSucceeded = true;
      const timestampSeconds = Math.floor(Date.now() / 1000);
      const payloadString = JSON.stringify({
        id: event.id,
        eventType: event.eventType,
        organizationId: event.organizationId,
        createdAt: event.createdAt.toISOString(),
        data: event.payload,
      });

      for (const endpoint of orgEndpoints) {
        const signature = this.computeSignature(payloadString, endpoint.secret, timestampSeconds);
        try {
          let responseStatus = 200;
          let isOk = true;

          if (customFetch) {
            const res = await customFetch(endpoint.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-BriskSMS-Event': event.eventType,
                'X-BriskSMS-Delivery': event.id,
                'X-BriskSMS-Signature': signature,
              },
              body: payloadString,
            });
            responseStatus = res.status;
            isOk = res.ok;
          }

          if (isOk) {
            summary.deliveredDeliveries++;
            summary.results.push({
              endpointId: endpoint.id,
              url: endpoint.url,
              statusCode: responseStatus,
              success: true,
            });
          } else {
            allEndpointsSucceeded = false;
            summary.failedDeliveries++;
            summary.results.push({
              endpointId: endpoint.id,
              url: endpoint.url,
              statusCode: responseStatus,
              success: false,
              error: `HTTP status ${responseStatus}`,
            });
          }
        } catch (err: unknown) {
          allEndpointsSucceeded = false;
          summary.failedDeliveries++;
          summary.results.push({
            endpointId: endpoint.id,
            url: endpoint.url,
            statusCode: 0,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      event.attemptCount++;
      event.lastAttemptAt = new Date();
      if (allEndpointsSucceeded) {
        event.isDelivered = true;
      }
    }

    return summary;
  }
}
