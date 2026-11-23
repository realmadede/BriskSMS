import { randomUUID } from 'node:crypto';
import { sql, withTransaction } from '@brisksms/db';
import {
  BillingInterval,
  BriskError,
  DeviceStatus,
  OrganizationSubscriptionDto,
  PlanNotFoundError,
  SubscriptionStatus,
  UserRole,
} from '@brisksms/shared';
import { HttpException } from '../../core/http.js';
import { dbStore, OrganizationSubscriptionRecord } from '../../core/store.js';
import { subscriptionService } from '../subscription/subscription.service.js';

export interface MerchantSummary {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  ownerEmail: string | null;
  memberCount: number;
  activeDeviceCount: number;
  planCode: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  createdAt: string;
}

export interface MerchantDetail {
  merchant: MerchantSummary;
  members: Array<{ userId: string; fullName: string; email: string; role: UserRole; isActive: boolean }>;
  devices: Array<{
    id: string;
    label: string;
    deviceModel: string;
    status: DeviceStatus;
    lastSyncAt: string | null;
    createdAt: string;
    revokedAt: string | null;
  }>;
  subscription: OrganizationSubscriptionDto | null;
  apiKeys: Array<{
    id: string;
    keyPrefix: string;
    label: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  }>;
  recentActivity: Array<{ action: string; resourceType: string; createdAt: string }>;
}

const PAGE_LIMIT_MAX = 100;

function requireReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 3 || text.length > 500) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'A reason between 3 and 500 characters is required.');
  }
  return text;
}

function mapSummary(row: Record<string, any>): MerchantSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    isActive: Boolean(row.is_active),
    ownerEmail: row.owner_email ? String(row.owner_email) : null,
    memberCount: Number(row.member_count),
    activeDeviceCount: Number(row.active_device_count),
    planCode: row.plan_code ? String(row.plan_code) : null,
    planName: row.plan_name ? String(row.plan_name) : null,
    subscriptionStatus: row.subscription_status ? String(row.subscription_status) : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Platform-wide merchant management. Every method here reads across organizations, so callers
 * must have passed assertPlatformAdmin(); each change is written to that organization's audit log.
 */
export class AdminService {
  async listMerchants(options: {
    id?: string;
    search?: string;
    status?: 'active' | 'suspended';
    limit?: number;
    offset?: number;
  }): Promise<{ merchants: MerchantSummary[]; total: number }> {
    const id = options.id ?? null;
    const search = options.search?.trim() ?? '';
    const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const activeFilter = options.status === 'active' ? true : options.status === 'suspended' ? false : null;
    const limit = Math.min(Math.max(Number(options.limit) || 25, 1), PAGE_LIMIT_MAX);
    const offset = Math.max(Number(options.offset) || 0, 0);

    const rows = await sql<Record<string, any>>`
      SELECT
        o."id", o."name", o."slug", o."is_active", o."created_at",
        (SELECT COUNT(*) FROM "users_organizations" uo WHERE uo."organization_id" = o."id") AS "member_count",
        (SELECT COUNT(*) FROM "devices" d WHERE d."organization_id" = o."id" AND d."status" = 'ACTIVE') AS "active_device_count",
        (SELECT u."email" FROM "users_organizations" uo JOIN "users" u ON u."id" = uo."user_id"
          WHERE uo."organization_id" = o."id" AND uo."role" = 'OWNER'
          ORDER BY uo."created_at" ASC LIMIT 1) AS "owner_email",
        sp."code" AS "plan_code", sp."name" AS "plan_name", os."status" AS "subscription_status",
        COUNT(*) OVER () AS "total"
      FROM "organizations" o
      LEFT JOIN "organization_subscriptions" os ON os."organization_id" = o."id"
      LEFT JOIN "plan_versions" pv ON pv."id" = os."plan_version_id"
      LEFT JOIN "subscription_plans" sp ON sp."id" = pv."plan_id"
      WHERE (${id}::uuid IS NULL OR o."id" = ${id}::uuid)
        AND (${search} = '' OR o."name" ILIKE ${pattern} OR o."slug" ILIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM "users_organizations" uo JOIN "users" u ON u."id" = uo."user_id"
          WHERE uo."organization_id" = o."id" AND u."email" ILIKE ${pattern}
        ))
        AND (${activeFilter}::boolean IS NULL OR o."is_active" = ${activeFilter}::boolean)
      ORDER BY o."created_at" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return {
      merchants: rows.map(mapSummary),
      total: rows.length > 0 ? Number(rows[0]!.total) : 0,
    };
  }

  async getMerchant(organizationId: string): Promise<MerchantDetail> {
    const merchant = await this.getSummary(organizationId);
    const [members, devices, subscription, keyRows, activityRows] = await Promise.all([
      dbStore.getOrgMembers(organizationId),
      dbStore.getOrgDevices(organizationId),
      subscriptionService.getOrganizationSubscription(organizationId),
      sql<Record<string, any>>`
        SELECT "id", "key_prefix", "label", "last_used_at", "revoked_at", "created_at"
        FROM "api_keys" WHERE "organization_id" = ${organizationId}::uuid
        ORDER BY "created_at" DESC LIMIT 100
      `,
      sql<Record<string, any>>`
        SELECT "action", "resource_type", "created_at"
        FROM "audit_logs" WHERE "organization_id" = ${organizationId}::uuid
        ORDER BY "created_at" DESC LIMIT 20
      `,
    ]);

    return {
      merchant,
      members: members.map(({ user, role }) => ({
        userId: user.id,
        fullName: user.fullName,
        email: user.email,
        role,
        isActive: user.isActive,
      })),
      devices: devices.map((d) => ({
        id: d.id,
        label: d.label,
        deviceModel: d.deviceModel,
        status: d.status,
        lastSyncAt: d.lastSyncAt ? d.lastSyncAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
        revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
      })),
      subscription,
      apiKeys: keyRows.map((k) => ({
        id: String(k.id),
        keyPrefix: String(k.key_prefix),
        label: String(k.label),
        lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
        revokedAt: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
        createdAt: new Date(k.created_at).toISOString(),
      })),
      recentActivity: activityRows.map((a) => ({
        action: String(a.action),
        resourceType: String(a.resource_type),
        createdAt: new Date(a.created_at).toISOString(),
      })),
    };
  }

  /** Suspending blocks the organization's sessions, API keys and devices on their next request. */
  async setMerchantActive(
    organizationId: string,
    active: boolean,
    actorId: string,
    reason: unknown,
  ): Promise<MerchantSummary> {
    const why = requireReason(reason);
    await withTransaction(async (tx) => {
      const rows = await tx<{ is_active: boolean }>`
        SELECT "is_active" FROM "organizations" WHERE "id" = ${organizationId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new HttpException(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
      }
      const wasActive = Boolean(rows[0]!.is_active);
      if (wasActive === active) {
        throw new HttpException(
          409,
          active ? 'MERCHANT_ALREADY_ACTIVE' : 'MERCHANT_ALREADY_SUSPENDED',
          active ? 'Merchant is already active' : 'Merchant is already suspended',
        );
      }

      await tx`
        UPDATE "organizations" SET "is_active" = ${active}, "updated_at" = NOW()
        WHERE "id" = ${organizationId}::uuid
      `;
      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: active ? 'ORGANIZATION_REACTIVATED' : 'ORGANIZATION_SUSPENDED',
          resourceType: 'ORGANIZATION',
          resourceId: organizationId,
          previousState: { isActive: wasActive },
          newState: { isActive: active },
          metadata: { platformAdmin: true, reason: why },
        },
        tx,
      );
    });
    return this.getSummary(organizationId);
  }

  async revokeMerchantDevice(
    organizationId: string,
    deviceId: string,
    actorId: string,
    reason: unknown,
  ): Promise<{ id: string; status: DeviceStatus }> {
    const why = requireReason(reason);
    const devices = await dbStore.getOrgDevices(organizationId);
    const device = devices.find((d) => d.id === deviceId);
    if (!device) {
      throw new HttpException(404, 'DEVICE_NOT_FOUND', 'Device not found for this merchant');
    }
    if (device.status === DeviceStatus.REVOKED) {
      throw new HttpException(409, 'DEVICE_ALREADY_REVOKED', 'Device is already revoked');
    }
    // dbStore.revokeDevice cancels pending device commands and audit-logs the revocation
    const revoked = await dbStore.revokeDevice(deviceId, organizationId, actorId, `Platform admin: ${why}`);
    return { id: revoked.id, status: revoked.status };
  }

  /** Stops one API key working at once. The key cannot be restored; the customer creates a new one. */
  async revokeMerchantApiKey(
    organizationId: string,
    apiKeyId: string,
    actorId: string,
    reason: unknown,
  ): Promise<{ id: string }> {
    const why = requireReason(reason);
    await withTransaction(async (tx) => {
      const rows = await tx<{ revoked_at: Date | null }>`
        SELECT "revoked_at" FROM "api_keys"
        WHERE "id" = ${apiKeyId}::uuid AND "organization_id" = ${organizationId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new HttpException(404, 'API_KEY_NOT_FOUND', 'API key not found for this merchant');
      }
      if (rows[0]!.revoked_at) {
        throw new HttpException(409, 'API_KEY_ALREADY_REVOKED', 'API key is already revoked');
      }
      await tx`UPDATE "api_keys" SET "revoked_at" = NOW() WHERE "id" = ${apiKeyId}::uuid`;
      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'API_KEY_REVOKED_BY_PLATFORM',
          resourceType: 'API_KEY',
          resourceId: apiKeyId,
          metadata: { platformAdmin: true, reason: why },
        },
        tx,
      );
    });
    return { id: apiKeyId };
  }

  /**
   * Holds a device without revoking it: an ACTIVE device becomes QUARANTINED and every device
   * check (requests, ingestion, outbound jobs) refuses it until it is released.
   */
  async setDeviceQuarantine(
    organizationId: string,
    deviceId: string,
    quarantined: boolean,
    actorId: string,
    reason: unknown,
  ): Promise<{ id: string; status: DeviceStatus }> {
    const why = requireReason(reason);
    const from = quarantined ? DeviceStatus.ACTIVE : DeviceStatus.QUARANTINED;
    const to = quarantined ? DeviceStatus.QUARANTINED : DeviceStatus.ACTIVE;
    await withTransaction(async (tx) => {
      const rows = await tx<{ status: string }>`
        SELECT "status" FROM "devices"
        WHERE "id" = ${deviceId}::uuid AND "organization_id" = ${organizationId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new HttpException(404, 'DEVICE_NOT_FOUND', 'Device not found for this merchant');
      }
      if (rows[0]!.status !== from) {
        throw new HttpException(
          409,
          'DEVICE_STATE_CONFLICT',
          `Only a ${from} device can be ${quarantined ? 'quarantined' : 'released'}; this one is ${rows[0]!.status}.`,
        );
      }
      await tx`
        UPDATE "devices" SET "status" = ${to}::"DeviceStatus", "updated_at" = NOW()
        WHERE "id" = ${deviceId}::uuid
      `;
      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: quarantined ? 'DEVICE_QUARANTINED' : 'DEVICE_RELEASED',
          resourceType: 'DEVICE',
          resourceId: deviceId,
          previousState: { status: from },
          newState: { status: to },
          metadata: { platformAdmin: true, reason: why },
        },
        tx,
      );
    });
    return { id: deviceId, status: to };
  }

  /**
   * Puts a merchant on a plan for one billing period without charging them: no invoice is
   * created and no payment is recorded. Paid plans bought by the merchant still go through
   * subscription checkout with verified payment evidence.
   */
  async assignPlan(
    organizationId: string,
    actorId: string,
    input: { planCode?: unknown; billingInterval?: unknown; reason?: unknown },
  ): Promise<OrganizationSubscriptionDto> {
    const why = requireReason(input.reason);
    const planCode = typeof input.planCode === 'string' ? input.planCode.trim() : '';
    const interval = input.billingInterval;
    if (!planCode || (interval !== BillingInterval.MONTHLY && interval !== BillingInterval.ANNUALLY)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'planCode and billingInterval (MONTHLY or ANNUALLY) are required.');
    }

    return withTransaction(async (tx) => {
      const orgRows = await tx`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId}::uuid FOR UPDATE`;
      if (orgRows.length === 0) {
        throw new HttpException(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
      }

      const plan = await dbStore.getPlanByCode(planCode, tx);
      const version = plan ? await dbStore.getActivePlanVersion(plan.id, tx) : null;
      if (!plan || !version) {
        throw new PlanNotFoundError(planCode);
      }
      const price = (await dbStore.getPlanPrices(version.id, tx)).find(
        (p) => p.isActive && p.currency === 'TZS' && p.billingInterval === interval,
      );
      if (!price) {
        throw new BriskError('PRICE_NOT_FOUND', `Plan '${planCode}' has no active TZS ${interval} price.`, 422);
      }

      const existing = await dbStore.getOrganizationSubscription(organizationId, tx);
      const now = new Date();
      const periodDays = interval === BillingInterval.ANNUALLY ? 365 : 30;
      const record: OrganizationSubscriptionRecord = {
        id: existing?.id ?? randomUUID(),
        organizationId,
        planVersionId: version.id,
        status: SubscriptionStatus.ACTIVE,
        currency: price.currency,
        unitPriceCents: price.amountCents,
        billingInterval: interval,
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + periodDays * 24 * 3600 * 1000),
        trialEndsAt: null,
        canceledAt: null,
        cancelAtPeriodEnd: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const saved = await dbStore.saveSubscription(record, tx);

      await tx`
        INSERT INTO "subscription_history" (
          "id", "organization_id", "subscription_id", "plan_version_id",
          "event_type", "previous_status", "new_status", "unit_price_cents",
          "currency", "billing_interval", "actor_id", "metadata"
        )
        VALUES (
          ${randomUUID()}, ${organizationId}, ${saved.id}, ${version.id},
          'ADMIN_PLAN_ASSIGNED',
          ${existing ? existing.status : null}::"SubscriptionStatus",
          ${SubscriptionStatus.ACTIVE}::"SubscriptionStatus",
          ${price.amountCents.toString()}::bigint,
          ${price.currency},
          ${interval}::"BillingInterval",
          ${actorId},
          ${JSON.stringify({ planCode: plan.code, versionNumber: version.versionNumber, reason: why, charged: false })}::jsonb
        )
      `;
      await dbStore.recordAudit(
        {
          organizationId,
          actorId,
          actorType: 'USER',
          action: 'ADMIN_PLAN_ASSIGNED',
          resourceType: 'SUBSCRIPTION',
          resourceId: saved.id,
          previousState: existing ? { planVersionId: existing.planVersionId, status: existing.status } : null,
          newState: { planVersionId: version.id, status: SubscriptionStatus.ACTIVE },
          metadata: { platformAdmin: true, reason: why, planCode: plan.code, billingInterval: interval, charged: false },
        },
        tx,
      );

      return (await subscriptionService.getOrganizationSubscription(organizationId, tx))!;
    });
  }

  private async getSummary(organizationId: string): Promise<MerchantSummary> {
    const { merchants } = await this.listMerchants({ id: organizationId, limit: 1 });
    if (merchants.length === 0) {
      throw new HttpException(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
    }
    return merchants[0]!;
  }
}

export const adminService = new AdminService();
