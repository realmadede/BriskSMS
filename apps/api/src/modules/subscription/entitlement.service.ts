import {
  FeatureKey,
  QuotaExceededError,
  FeatureDisabledError,
  SubscriptionStatus,
  EntitlementCheckResult,
} from '@brisksms/shared';
import { dbStore } from '../../core/store.js';
import { SqlExecutor, sql } from '@brisksms/db';

export class EntitlementService {
  /**
   * Resolves the full feature entitlement dictionary for an organization from PostgreSQL.
   * If the organization has no active subscription, returns default values from FeatureDefinitions.
   */
  async getEntitlements(organizationId: string, tx: SqlExecutor = sql): Promise<Record<string, string>> {
    const [featureDefs, sub] = await Promise.all([
      dbStore.getFeatureDefinitions(tx),
      dbStore.getOrganizationSubscription(organizationId, tx),
    ]);

    const result: Record<string, string> = {};
    for (const feat of featureDefs) {
      result[feat.key] = feat.defaultValue;
    }

    if (sub && (sub.status === SubscriptionStatus.ACTIVE || sub.status === SubscriptionStatus.TRIALING)) {
      const planEntitlements = await dbStore.getPlanEntitlements(sub.planVersionId, tx);
      for (const ent of planEntitlements) {
        result[ent.featureKey] = ent.value;
      }
    }

    return result;
  }

  /**
   * Evaluates a boolean feature flag for an organization
   */
  async isFeatureEnabled(organizationId: string, featureKey: string, tx: SqlExecutor = sql): Promise<boolean> {
    const entitlements = await this.getEntitlements(organizationId, tx);
    const val = entitlements[featureKey];
    return val === 'true' || val === '1';
  }

  /**
   * Asserts that a boolean feature is enabled, throwing FeatureDisabledError if not
   */
  async assertFeatureEnabled(organizationId: string, featureKey: string, tx: SqlExecutor = sql): Promise<void> {
    if (!(await this.isFeatureEnabled(organizationId, featureKey, tx))) {
      throw new FeatureDisabledError(featureKey);
    }
  }

  /**
   * Evaluates a numeric quota limit against current usage
   */
  async checkNumericLimit(
    organizationId: string,
    featureKey: string,
    currentUsage: number,
    tx: SqlExecutor = sql,
  ): Promise<EntitlementCheckResult> {
    const entitlements = await this.getEntitlements(organizationId, tx);
    const rawLimit = entitlements[featureKey];
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 1;
    const allowed = currentUsage < limit;

    return {
      allowed,
      featureKey,
      currentValue: limit,
      limit,
      currentUsage,
      remaining: Math.max(0, limit - currentUsage),
    };
  }

  /**
   * Enforces device pairing quota dynamically based on configured plan limit
   */
  async enforceDeviceQuota(organizationId: string, tx: SqlExecutor = sql): Promise<void> {
    const devices = await dbStore.getOrgDevices(organizationId, tx);
    const activeCount = devices.filter((d) => d.status === 'ACTIVE' || d.status === 'PENDING_PAIRING').length;
    const check = await this.checkNumericLimit(organizationId, FeatureKey.MAX_CONNECTED_DEVICES, activeCount, tx);

    if (!check.allowed) {
      throw new QuotaExceededError('connected Android devices', check.limit ?? 1);
    }
  }

  /**
   * Enforces organization member quota dynamically based on configured plan limit
   */
  async enforceMemberQuota(organizationId: string, tx: SqlExecutor = sql): Promise<void> {
    const memberCount = await dbStore.countOrgMembers(organizationId, tx);
    const check = await this.checkNumericLimit(organizationId, FeatureKey.MAX_ORGANIZATION_MEMBERS, memberCount, tx);
    if (!check.allowed) {
      throw new QuotaExceededError('organization members', check.limit ?? 2);
    }
  }
}

export const entitlementService = new EntitlementService();
