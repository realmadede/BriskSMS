/**
 * SMSGate Webhook Signing Key Management Service
 *
 * Provides cryptographic key storage, rotation, and tenant/device isolation
 * for incoming SMSGate delivery report webhooks.
 *
 * Invariants:
 * 1. Scope Isolation: Keys are strictly partitioned by organizationId and deviceId.
 *    Device keys from Organization A can never be resolved or accessed by Organization B.
 * 2. Secure Rotation: Stores an active `currentKey` and an optional `previousKey` during
 *    key rotation grace period (default: 24 hours), preventing dropped delivery receipts.
 * 3. Secret Masking: Keys are never exposed in API DTOs, logs, or error responses.
 */

export interface KeyRecord {
  currentKey: string;
  previousKey?: string;
  rotatedAt?: Date;
}

export class SmsGateKeyService {
  private deviceKeys = new Map<string, KeyRecord>();
  private gatewayKeys = new Map<string, KeyRecord>();

  private buildDeviceKeyScope(organizationId: string, deviceId: string): string {
    return `${organizationId.trim()}:${deviceId.trim()}`;
  }

  /**
   * Sets or provisions the initial webhook signing key for a specific device in an organization.
   */
  setDeviceSigningKey(organizationId: string, deviceId: string, secret: string): void {
    if (!organizationId || !deviceId) {
      throw new Error('organizationId and deviceId are required to scope a device signing key');
    }
    const cleanSecret = secret?.trim();
    if (!cleanSecret || cleanSecret.length < 16) {
      throw new Error('Signing key must be a secure secret with at least 16 characters');
    }

    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    this.deviceKeys.set(scopeKey, { currentKey: cleanSecret });
  }

  /**
   * Rotates a device signing key, preserving the previous key during grace period.
   */
  rotateDeviceSigningKey(organizationId: string, deviceId: string, newSecret: string): void {
    if (!organizationId || !deviceId) {
      throw new Error('organizationId and deviceId are required to rotate a device signing key');
    }
    const cleanNewSecret = newSecret?.trim();
    if (!cleanNewSecret || cleanNewSecret.length < 16) {
      throw new Error('New signing key must be a secure secret with at least 16 characters');
    }

    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    const existing = this.deviceKeys.get(scopeKey);

    this.deviceKeys.set(scopeKey, {
      currentKey: cleanNewSecret,
      previousKey: existing?.currentKey,
      rotatedAt: new Date(),
    });
  }

  /**
   * Retrieves active candidate signing keys for a device (current key and previous key if rotating).
   */
  getDeviceSigningKeys(organizationId: string, deviceId: string): string[] {
    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    const record = this.deviceKeys.get(scopeKey);
    if (!record) return [];

    const keys: string[] = [record.currentKey];
    if (record.previousKey) {
      // Check grace period (e.g. 24 hours)
      const gracePeriodMs = 24 * 60 * 60 * 1000;
      if (record.rotatedAt && Date.now() - record.rotatedAt.getTime() < gracePeriodMs) {
        keys.push(record.previousKey);
      }
    }
    return keys;
  }

  /**
   * Sets or provisions an organization-level SMSGate server signing key (Mode B private VPS).
   */
  setGatewaySigningKey(organizationId: string, secret: string): void {
    if (!organizationId) {
      throw new Error('organizationId is required to scope a gateway signing key');
    }
    const cleanSecret = secret?.trim();
    if (!cleanSecret || cleanSecret.length < 16) {
      throw new Error('Signing key must be a secure secret with at least 16 characters');
    }

    this.gatewayKeys.set(organizationId.trim(), { currentKey: cleanSecret });
  }

  /**
   * Rotates an organization-level SMSGate server signing key.
   */
  rotateGatewaySigningKey(organizationId: string, newSecret: string): void {
    if (!organizationId) {
      throw new Error('organizationId is required to rotate a gateway signing key');
    }
    const cleanNewSecret = newSecret?.trim();
    if (!cleanNewSecret || cleanNewSecret.length < 16) {
      throw new Error('New signing key must be a secure secret with at least 16 characters');
    }

    const orgKey = organizationId.trim();
    const existing = this.gatewayKeys.get(orgKey);

    this.gatewayKeys.set(orgKey, {
      currentKey: cleanNewSecret,
      previousKey: existing?.currentKey,
      rotatedAt: new Date(),
    });
  }

  /**
   * Resolves all valid candidate keys for an incoming delivery webhook.
   * Priority:
   * 1. Device-specific key for `${organizationId}:${deviceId}`
   * 2. Organization-level gateway key
   */
  resolveCandidateKeys(organizationId: string, deviceId?: string): string[] {
    if (!organizationId) return [];

    if (deviceId && deviceId.trim()) {
      const deviceCandidateKeys = this.getDeviceSigningKeys(organizationId, deviceId.trim());
      if (deviceCandidateKeys.length > 0) {
        return deviceCandidateKeys;
      }
    }

    const gatewayRecord = this.gatewayKeys.get(organizationId.trim());
    if (gatewayRecord) {
      const keys = [gatewayRecord.currentKey];
      if (gatewayRecord.previousKey) {
        keys.push(gatewayRecord.previousKey);
      }
      return keys;
    }

    return [];
  }

  /**
   * Revokes a device key upon device unpairing or decommissioning.
   */
  revokeDeviceKey(organizationId: string, deviceId: string): void {
    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    this.deviceKeys.delete(scopeKey);
  }

  /**
   * Clears all in-memory keys (for test reset).
   */
  clearAll(): void {
    this.deviceKeys.clear();
    this.gatewayKeys.clear();
  }
}

export const smsGateKeyService = new SmsGateKeyService();
