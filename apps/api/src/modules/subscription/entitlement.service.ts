import {
  FeatureKey,
  QuotaExceededError,
  FeatureDisabledError,
  SubscriptionStatus,
  EntitlementCheckResult,
} from '@brisksms/shared';
import { dbStore } from '../../core/store.js';

export class EntitlementService {
  /**
   * Resolves the full feature entitlement dictionary for an organization.
   * If the organization has no active subscription, returns default values from FeatureDefinitions.
   */
  getEntitlements(organizationId: string): Record<string, string> {
    const sub = dbStore.getOrganizationSubscription(organizationId);
    const result: Record<string, string> = {};

    // 1. Populate system defaults from FeatureDefinitions
    for (const feat of dbStore.featureDefinitions.values()) {
      result[feat.key] = feat.defaultValue;
    }

    // 2. If organization has an active/trialing subscription, override with configured plan version values
    if (sub && (sub.status === SubscriptionStatus.ACTIVE || sub.status === SubscriptionStatus.TRIALING)) {
      const planEntitlements = dbStore.getPlanEntitlements(sub.planVersionId);
      for (const ent of planEntitlements) {
        result[ent.featureKey] = ent.value;
      }
    }

    return result;
  }

  /**
   * Evaluates a boolean feature flag for an organization
   */
  isFeatureEnabled(organizationId: string, featureKey: string): boolean {
    const entitlements = this.getEntitlements(organizationId);
    const val = entitlements[featureKey];
    return val === 'true' || val === '1';
  }

  /**
   * Asserts that a boolean feature is enabled, throwing FeatureDisabledError if not
   */
  assertFeatureEnabled(organizationId: string, featureKey: string): void {
    if (!this.isFeatureEnabled(organizationId, featureKey)) {
      throw new FeatureDisabledError(featureKey);
    }
  }

  /**
   * Evaluates a numeric quota limit against current usage
   */
  checkNumericLimit(organizationId: string, featureKey: string, currentUsage: number): EntitlementCheckResult {
    const entitlements = this.getEntitlements(organizationId);
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
  enforceDeviceQuota(organizationId: string): void {
    const devices = dbStore.getOrgDevices(organizationId);
    const activeCount = devices.filter((d) => d.status === 'ACTIVE' || d.status === 'PENDING_PAIRING').length;
    const check = this.checkNumericLimit(organizationId, FeatureKey.MAX_CONNECTED_DEVICES, activeCount);

    if (!check.allowed) {
      throw new QuotaExceededError('connected Android devices', check.limit ?? 1);
    }
  }

  /**
   * Enforces organization member quota dynamically based on configured plan limit
   */
  enforceMemberQuota(organizationId: string): void {
    let memberCount = 0;
    for (const mem of dbStore.memberships.values()) {
      if (mem.organizationId === organizationId) {
        memberCount++;
      }
    }

    const check = this.checkNumericLimit(organizationId, FeatureKey.MAX_ORGANIZATION_MEMBERS, memberCount);
    if (!check.allowed) {
      throw new QuotaExceededError('organization members', check.limit ?? 2);
    }
  }
}

export const entitlementService = new EntitlementService();
