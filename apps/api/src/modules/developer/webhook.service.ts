import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  BusinessEventType,
  OutboxStatus,
  WebhookEndpointDto,
} from '@brisksms/shared';
import { sql, withTransaction } from '@brisksms/db';
import { WebhookEndpointRecord } from '../../core/store.js';

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
  private mapEndpointRow(row: Record<string, any>): WebhookEndpointRecord {
    const rawEvents =
      typeof row.subscribed_events === 'string'
        ? JSON.parse(row.subscribed_events)
        : row.subscribed_events;
    return {
      id: row.id,
      organizationId: row.organization_id,
      url: row.url,
      secret: row.secret,
      subscribedEvents: Array.isArray(rawEvents) ? rawEvents : [],
      isActive: Boolean(row.is_active),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Registers a webhook receiver (e.g. Zapier Catch Hook or ERP listener)
   */
  public async registerEndpoint(
    organizationId: string,
    dto: RegisterWebhookEndpointDto,
  ): Promise<WebhookEndpointRecord> {
    if (!dto.url || (!dto.url.startsWith('https://') && !dto.url.startsWith('http://'))) {
      throw new Error('Valid HTTP/HTTPS webhook URL is required');
    }

    if (!dto.subscribedEvents || dto.subscribedEvents.length === 0) {
      throw new Error('At least one subscribed event type is required');
    }

    const secret = dto.secret ?? `whsec_${randomBytes(24).toString('hex')}`;
    const now = new Date();
    const id = randomUUID();
    const events = [...dto.subscribedEvents];

    const inserted = await sql<Record<string, any>>`
      INSERT INTO webhook_endpoints (
        id, organization_id, url, secret, subscribed_events, is_active, created_at, updated_at
      ) VALUES (
        ${id}, ${organizationId}, ${dto.url.trim()}, ${secret}, ${JSON.stringify(events)}::text::jsonb, true, ${now}, ${now}
      )
      RETURNING *
    `;

    return this.mapEndpointRow(inserted[0]!);
  }

  /**
   * Lists registered webhook endpoints for an organization
   */
  public async listEndpoints(organizationId: string): Promise<WebhookEndpointDto[]> {
    const rows = await sql<Record<string, any>>`
      SELECT * FROM webhook_endpoints
      WHERE organization_id = ${organizationId}
      ORDER BY created_at DESC, id DESC
    `;

    return rows.map((row) => {
      const rawEvents =
        typeof row.subscribed_events === 'string'
          ? JSON.parse(row.subscribed_events)
          : row.subscribed_events;
      return {
        id: row.id,
        organizationId: row.organization_id,
        targetUrl: row.url,
        subscribedEvents: Array.isArray(rawEvents) ? rawEvents : [],
        isActive: Boolean(row.is_active),
        signingSecret: row.secret,
        createdAt: new Date(row.created_at),
      };
    });
  }

  /**
   * Revokes or deactivates a webhook endpoint
   */
  public async deactivateEndpoint(organizationId: string, endpointId: string): Promise<boolean> {
    const now = new Date();
    const updated = await sql<Record<string, any>>`
      UPDATE webhook_endpoints
      SET is_active = false, updated_at = ${now}
      WHERE id = ${endpointId} AND organization_id = ${organizationId}
      RETURNING id
    `;
    return updated.length > 0;
  }

  /**
   * Permanently deletes a webhook endpoint
   */
  public async deleteEndpoint(organizationId: string, endpointId: string): Promise<boolean> {
    const deleted = await sql<Record<string, any>>`
      DELETE FROM webhook_endpoints
      WHERE id = ${endpointId} AND organization_id = ${organizationId}
      RETURNING id
    `;
    return deleted.length > 0;
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
   * Delivers a single persisted outbox event by ID and records WebhookDelivery audit rows.
   */
  public async deliverOutboxEventById(
    outboxEventId: string,
    organizationId: string,
    customFetch?: (url: string, init: RequestInit) => Promise<{ status: number; ok: boolean }>,
  ): Promise<{ delivered: boolean; results: WebhookDispatchResult[] }> {
    const eventRows = await sql<Record<string, any>>`
      SELECT * FROM outbox_events
      WHERE id = ${outboxEventId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
    if (eventRows.length === 0) {
      throw new Error(`Outbox event ${outboxEventId} not found for organization ${organizationId}`);
    }

    const row = eventRows[0]!;
    if (row.is_delivered || row.status === OutboxStatus.DELIVERED) {
      return { delivered: true, results: [] };
    }

    const allActiveRows = await sql<Record<string, any>>`
      SELECT * FROM webhook_endpoints
      WHERE organization_id = ${organizationId}
        AND is_active = true
    `;
    const endpointsRows = allActiveRows.filter((epRow) => {
      const mapped = this.mapEndpointRow(epRow);
      return mapped.subscribedEvents.includes(row.event_type as BusinessEventType);
    });

    const now = new Date();
    if (endpointsRows.length === 0) {
      await sql`
        UPDATE outbox_events
        SET status = ${OutboxStatus.DELIVERED}::"OutboxStatus",
            is_delivered = true,
            delivered_at = ${now},
            last_attempt_at = ${now},
            locked_at = NULL
        WHERE id = ${outboxEventId}
      `;
      return { delivered: true, results: [] };
    }

    let allEndpointsSucceeded = true;
    let lastError: string | null = null;
    const results: WebhookDispatchResult[] = [];
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const payloadObj = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const payloadString = JSON.stringify({
      id: row.id,
      eventType: row.event_type,
      organizationId: row.organization_id,
      createdAt: new Date(row.created_at).toISOString(),
      data: payloadObj,
    });

    const nextAttemptCount = Number(row.attempt_count) + 1;

    for (const epRow of endpointsRows) {
      const endpoint = this.mapEndpointRow(epRow);
      const signature = this.computeSignature(payloadString, endpoint.secret, timestampSeconds);

      try {
        let responseStatus = 200;
        let isOk = true;

        if (customFetch) {
          const res = await customFetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-BriskSMS-Event': row.event_type,
              'X-BriskSMS-Delivery': row.id,
              'X-BriskSMS-Signature': signature,
            },
            body: payloadString,
          });
          responseStatus = res.status;
          isOk = res.ok;
        }

        await sql`
          INSERT INTO webhook_deliveries (
            id, organization_id, endpoint_id, outbox_event_id, event_type,
            payload, response_status, response_body, attempt_number,
            status, next_retry_at, delivered_at, created_at
          ) VALUES (
            ${randomUUID()}, ${organizationId}, ${endpoint.id}, ${row.id}, ${row.event_type},
            ${JSON.stringify(payloadObj)}::jsonb, ${responseStatus}, NULL, ${nextAttemptCount},
            ${isOk ? 'DELIVERED' : 'FAILED'}, NULL, ${now}, ${now}
          )
        `;

        if (isOk) {
          results.push({
            endpointId: endpoint.id,
            url: endpoint.url,
            statusCode: responseStatus,
            success: true,
          });
        } else {
          allEndpointsSucceeded = false;
          lastError = `HTTP status ${responseStatus}`;
          results.push({
            endpointId: endpoint.id,
            url: endpoint.url,
            statusCode: responseStatus,
            success: false,
            error: lastError,
          });
        }
      } catch (err: unknown) {
        allEndpointsSucceeded = false;
        lastError = err instanceof Error ? err.message : String(err);

        await sql`
          INSERT INTO webhook_deliveries (
            id, organization_id, endpoint_id, outbox_event_id, event_type,
            payload, response_status, response_body, attempt_number,
            status, next_retry_at, delivered_at, created_at
          ) VALUES (
            ${randomUUID()}, ${organizationId}, ${endpoint.id}, ${row.id}, ${row.event_type},
            ${JSON.stringify(payloadObj)}::jsonb, 0, ${lastError}, ${nextAttemptCount},
            'FAILED', NULL, ${now}, ${now}
          )
        `;

        results.push({
          endpointId: endpoint.id,
          url: endpoint.url,
          statusCode: 0,
          success: false,
          error: lastError,
        });
      }
    }

    const maxAttempts = Number(row.max_attempts || 5);
    if (allEndpointsSucceeded) {
      await sql`
        UPDATE outbox_events
        SET status = ${OutboxStatus.DELIVERED}::"OutboxStatus",
            is_delivered = true,
            attempt_count = ${nextAttemptCount},
            last_attempt_at = ${now},
            delivered_at = ${now},
            locked_at = NULL,
            last_error = NULL
        WHERE id = ${outboxEventId}
      `;
    } else {
      const nextStatus = nextAttemptCount >= maxAttempts ? OutboxStatus.DEAD_LETTER : OutboxStatus.FAILED;
      const backoffMs = Math.min(60_000, 1000 * Math.pow(2, nextAttemptCount));
      const nextAttemptAt = new Date(now.getTime() + backoffMs);
      await sql`
        UPDATE outbox_events
        SET status = ${nextStatus}::"OutboxStatus",
            is_delivered = false,
            attempt_count = ${nextAttemptCount},
            last_attempt_at = ${now},
            next_attempt_at = ${nextAttemptAt},
            locked_at = NULL,
            last_error = ${lastError}
        WHERE id = ${outboxEventId}
      `;
    }

    return { delivered: allEndpointsSucceeded, results };
  }

  /**
   * Dispatches pending outbox events to registered active webhook endpoints using FOR UPDATE SKIP LOCKED.
   * Also recovers stuck PROCESSING events older than 5 minutes.
   */
  public async dispatchPendingOutboxEvents(
    customFetch?: (url: string, init: RequestInit) => Promise<{ status: number; ok: boolean }>,
  ): Promise<DispatchSummary> {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const now = new Date();

    const claimedEvents = await withTransaction(async (tx) => {
      const rows = await tx<Record<string, any>>`
        SELECT * FROM outbox_events
        WHERE is_delivered = false
          AND (
            status IN ('PENDING', 'FAILED')
            OR (status = 'PROCESSING' AND locked_at < ${staleThreshold})
          )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
      `;

      for (const row of rows) {
        await tx`
          UPDATE outbox_events
          SET status = ${OutboxStatus.PROCESSING}::"OutboxStatus", locked_at = ${now}
          WHERE id = ${row.id}
        `;
      }
      return rows;
    });

    const summary: DispatchSummary = {
      processedEvents: 0,
      deliveredDeliveries: 0,
      failedDeliveries: 0,
      results: [],
    };

    for (const eventRow of claimedEvents) {
      summary.processedEvents++;
      const { results } = await this.deliverOutboxEventById(
        eventRow.id,
        eventRow.organization_id,
        customFetch,
      );
      for (const r of results) {
        summary.results.push(r);
        if (r.success) {
          summary.deliveredDeliveries++;
        } else {
          summary.failedDeliveries++;
        }
      }
    }

    return summary;
  }
}
