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
 * 3. Secret Masking & Encryption at Rest: Keys are encrypted at rest using AES-256-GCM
 *    and never exposed in API DTOs, logs, or error responses.
 * 4. Audit Logging: Key provisioning, rotation, and revocation events are immutably logged.
 * 5. Fail Closed: If ENCRYPTION_MASTER_KEY is missing or invalid, key decryption fails closed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from '@brisksms/db';
import { encryptSecret, decryptSecret } from '../../../core/crypto.js';
import { HttpException } from '../../../core/http.js';

export interface KeyRecord {
  currentKey: string;
  previousKey?: string;
  rotatedAt?: Date;
}

export class SmsGateKeyService {
  private deviceKeys = new Map<string, KeyRecord>();
  private gatewayKeys = new Map<string, KeyRecord>();
  private readonly memoryOnly: boolean;

  constructor(options: { memoryOnly?: boolean } = {}) {
    if (options.memoryOnly && process.env.NODE_ENV === 'production') {
      throw new Error('SECURITY VIOLATION: memoryOnly mode cannot be enabled in production');
    }
    this.memoryOnly = Boolean(options.memoryOnly);
  }

  private buildDeviceKeyScope(organizationId: string, deviceId: string): string {
    return `${organizationId.trim()}:${deviceId.trim()}`;
  }

  /**
   * Authoritatively resolves the single organizationId bound to a deviceId.
   *
   * Security Invariants:
   * 1. Persistence Binding: Queries authoritative database records (smsgate_signing_keys & devices).
   * 2. Revocation Enforcement: Fails closed with 403 DEVICE_REVOKED if the device is revoked.
   * 3. Disambiguation: Fails closed with 409 AMBIGUOUS_DEVICE_IDENTITY if the device is registered
   *    under multiple organizations, preventing cross-tenant leakage.
   * 4. Unknown Detection: Returns null if no record exists for this device.
   */
  async resolveAuthoritativeDeviceOrganization(deviceId: string): Promise<string | null> {
    const cleanDeviceId = deviceId?.trim();
    if (!cleanDeviceId) return null;

    if (!this.memoryOnly) {
      // 1. Check if device exists in devices table and is revoked
      const devRows = await sql<Record<string, any>>`
        SELECT organization_id, status FROM devices
        WHERE id::text = ${cleanDeviceId}
      `;
      for (const d of devRows) {
        if (d.status === 'REVOKED') {
          throw new HttpException(
            403,
            'DEVICE_REVOKED',
            `Device "${cleanDeviceId}" has been revoked and cannot submit delivery reports`,
          );
        }
      }

      // 2. Query distinct organizations from smsgate_signing_keys
      const keyRows = await sql<Record<string, any>>`
        SELECT DISTINCT organization_id FROM smsgate_signing_keys
        WHERE device_id = ${cleanDeviceId}
      `;

      if (keyRows.length > 1) {
        throw new HttpException(
          409,
          'AMBIGUOUS_DEVICE_IDENTITY',
          `Device "${cleanDeviceId}" is ambiguously bound to multiple organizations`,
        );
      }

      if (keyRows.length === 1) {
        return keyRows[0]!.organization_id;
      }

      if (devRows.length === 1 && devRows[0]!.organization_id) {
        return devRows[0]!.organization_id;
      }

      return null;
    }

    // Explicit opt-in pure unit-test mode without PostgreSQL
    const matchedOrgs: string[] = [];
    for (const scopeKey of this.deviceKeys.keys()) {
      const [orgId, devId] = scopeKey.split(':');
      if (devId === cleanDeviceId && orgId) {
        if (!matchedOrgs.includes(orgId)) {
          matchedOrgs.push(orgId);
        }
      }
    }

    if (matchedOrgs.length > 1) {
      throw new HttpException(
        409,
        'AMBIGUOUS_DEVICE_IDENTITY',
        `Device "${cleanDeviceId}" is ambiguously bound to multiple organizations in memory`,
      );
    }

    return matchedOrgs[0] ?? null;
  }

  /**
   * Sets or provisions the initial webhook signing key for a specific device in an organization.
   * Encrypts the key at rest in PostgreSQL and writes an immutable audit log entry.
   */
  async setDeviceSigningKey(
    organizationId: string,
    deviceId: string,
    secret: string,
    actorId?: string,
  ): Promise<void> {
    if (!organizationId || !deviceId) {
      throw new Error('organizationId and deviceId are required to scope a device signing key');
    }
    const cleanSecret = secret?.trim();
    if (!cleanSecret || cleanSecret.length < 16) {
      throw new Error('Signing key must be a secure secret with at least 16 characters');
    }

    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    this.deviceKeys.set(scopeKey, { currentKey: cleanSecret });

    const encryptedKey = encryptSecret(cleanSecret);
    const now = new Date();
    if (this.memoryOnly) return;

    const rows = await sql<Record<string, any>>`
        INSERT INTO smsgate_signing_keys (
          id, organization_id, device_id, encrypted_key, encrypted_prev_key, rotated_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${deviceId.trim()}, ${encryptedKey}, NULL, NULL, ${now}, ${now}
        )
        ON CONFLICT ("organization_id", "device_id") WHERE "device_id" IS NOT NULL
        DO UPDATE SET
          encrypted_key = EXCLUDED.encrypted_key,
          encrypted_prev_key = NULL,
          rotated_at = NULL,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;

    const keyId = rows[0]?.id || randomUUID();
    await sql`
        INSERT INTO audit_logs (
          id, organization_id, actor_id, actor_type, action, resource_type, resource_id,
          previous_state, new_state, metadata, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${actorId ?? '00000000-0000-0000-0000-000000000000'},
          'SYSTEM', 'SMSGATE_KEY_PROVISIONED', 'smsgate_signing_key', ${keyId},
          NULL, ${JSON.stringify({ deviceId: deviceId.trim(), status: 'ACTIVE' })}::jsonb,
          ${JSON.stringify({ organizationId, deviceId: deviceId.trim() })}::jsonb,
          ${now}
        )
      `;
  }

  /**
   * Rotates a device signing key, preserving the previous key during grace period.
   * Encrypts both keys at rest in PostgreSQL and logs rotation in audit trail.
   */
  async rotateDeviceSigningKey(
    organizationId: string,
    deviceId: string,
    newSecret: string,
    actorId?: string,
  ): Promise<void> {
    if (!organizationId || !deviceId) {
      throw new Error('organizationId and deviceId are required to rotate a device signing key');
    }
    const cleanNewSecret = newSecret?.trim();
    if (!cleanNewSecret || cleanNewSecret.length < 16) {
      throw new Error('New signing key must be a secure secret with at least 16 characters');
    }

    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    const existingMemory = this.deviceKeys.get(scopeKey);

    const now = new Date();
    this.deviceKeys.set(scopeKey, {
      currentKey: cleanNewSecret,
      previousKey: existingMemory?.currentKey,
      rotatedAt: now,
    });

    const encryptedNewKey = encryptSecret(cleanNewSecret);
    if (this.memoryOnly) return;

    const rows = await sql<Record<string, any>>`
        INSERT INTO smsgate_signing_keys (
          id, organization_id, device_id, encrypted_key, encrypted_prev_key, rotated_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${deviceId.trim()}, ${encryptedNewKey}, NULL, ${now}, ${now}, ${now}
        )
        ON CONFLICT ("organization_id", "device_id") WHERE "device_id" IS NOT NULL
        DO UPDATE SET
          encrypted_prev_key = smsgate_signing_keys.encrypted_key,
          encrypted_key = EXCLUDED.encrypted_key,
          rotated_at = EXCLUDED.rotated_at,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;

    const keyId = rows[0]?.id || randomUUID();
    await sql`
        INSERT INTO audit_logs (
          id, organization_id, actor_id, actor_type, action, resource_type, resource_id,
          previous_state, new_state, metadata, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${actorId ?? '00000000-0000-0000-0000-000000000000'},
          'SYSTEM', 'SMSGATE_KEY_ROTATED', 'smsgate_signing_key', ${keyId},
          ${JSON.stringify({ deviceId: deviceId.trim(), action: 'KEY_REPLACED' })}::jsonb,
          ${JSON.stringify({ deviceId: deviceId.trim(), status: 'ROTATED' })}::jsonb,
          ${JSON.stringify({ organizationId, deviceId: deviceId.trim(), rotatedAt: now.toISOString() })}::jsonb,
          ${now}
        )
      `;
  }

  /**
   * Retrieves active candidate signing keys for a device (current key and previous key if rotating).
   */
  async getDeviceSigningKeys(organizationId: string, deviceId: string): Promise<string[]> {
    if (!organizationId || !deviceId) return [];

    if (!this.memoryOnly) {
      const rows = await sql<Record<string, any>>`
        SELECT * FROM smsgate_signing_keys
        WHERE organization_id = ${organizationId} AND device_id = ${deviceId.trim()}
      `;
      if (rows.length > 0) {
        return this.extractKeysFromRow(rows[0]!);
      }
      return [];
    }

    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    const record = this.deviceKeys.get(scopeKey);
    if (!record) return [];

    const keys: string[] = [record.currentKey];
    if (record.previousKey) {
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
  async setGatewaySigningKey(organizationId: string, secret: string, actorId?: string): Promise<void> {
    if (!organizationId) {
      throw new Error('organizationId is required to scope a gateway signing key');
    }
    const cleanSecret = secret?.trim();
    if (!cleanSecret || cleanSecret.length < 16) {
      throw new Error('Signing key must be a secure secret with at least 16 characters');
    }

    const orgKey = organizationId.trim();
    this.gatewayKeys.set(orgKey, { currentKey: cleanSecret });

    const encryptedKey = encryptSecret(cleanSecret);
    const now = new Date();
    if (this.memoryOnly) return;

    const rows = await sql<Record<string, any>>`
        INSERT INTO smsgate_signing_keys (
          id, organization_id, device_id, encrypted_key, encrypted_prev_key, rotated_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, NULL, ${encryptedKey}, NULL, NULL, ${now}, ${now}
        )
        ON CONFLICT ("organization_id") WHERE "device_id" IS NULL
        DO UPDATE SET
          encrypted_key = EXCLUDED.encrypted_key,
          encrypted_prev_key = NULL,
          rotated_at = NULL,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;

    const keyId = rows[0]?.id || randomUUID();
    await sql`
        INSERT INTO audit_logs (
          id, organization_id, actor_id, actor_type, action, resource_type, resource_id,
          previous_state, new_state, metadata, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${actorId ?? '00000000-0000-0000-0000-000000000000'},
          'SYSTEM', 'SMSGATE_KEY_PROVISIONED', 'smsgate_signing_key', ${keyId},
          NULL, ${JSON.stringify({ deviceId: null, status: 'ACTIVE' })}::jsonb,
          ${JSON.stringify({ organizationId, gatewayDefault: true })}::jsonb,
          ${now}
        )
      `;
  }

  /**
   * Rotates an organization-level SMSGate server signing key.
   */
  async rotateGatewaySigningKey(organizationId: string, newSecret: string, actorId?: string): Promise<void> {
    if (!organizationId) {
      throw new Error('organizationId is required to rotate a gateway signing key');
    }
    const cleanNewSecret = newSecret?.trim();
    if (!cleanNewSecret || cleanNewSecret.length < 16) {
      throw new Error('New signing key must be a secure secret with at least 16 characters');
    }

    const orgKey = organizationId.trim();
    const existingMemory = this.gatewayKeys.get(orgKey);

    const now = new Date();
    this.gatewayKeys.set(orgKey, {
      currentKey: cleanNewSecret,
      previousKey: existingMemory?.currentKey,
      rotatedAt: now,
    });

    const encryptedNewKey = encryptSecret(cleanNewSecret);
    if (this.memoryOnly) return;

    const rows = await sql<Record<string, any>>`
        INSERT INTO smsgate_signing_keys (
          id, organization_id, device_id, encrypted_key, encrypted_prev_key, rotated_at, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, NULL, ${encryptedNewKey}, NULL, ${now}, ${now}, ${now}
        )
        ON CONFLICT ("organization_id") WHERE "device_id" IS NULL
        DO UPDATE SET
          encrypted_prev_key = smsgate_signing_keys.encrypted_key,
          encrypted_key = EXCLUDED.encrypted_key,
          rotated_at = EXCLUDED.rotated_at,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `;

    const keyId = rows[0]?.id || randomUUID();
    await sql`
        INSERT INTO audit_logs (
          id, organization_id, actor_id, actor_type, action, resource_type, resource_id,
          previous_state, new_state, metadata, created_at
        ) VALUES (
          ${randomUUID()}, ${organizationId}, ${actorId ?? '00000000-0000-0000-0000-000000000000'},
          'SYSTEM', 'SMSGATE_KEY_ROTATED', 'smsgate_signing_key', ${keyId},
          ${JSON.stringify({ deviceId: null, action: 'KEY_REPLACED' })}::jsonb,
          ${JSON.stringify({ deviceId: null, status: 'ROTATED' })}::jsonb,
          ${JSON.stringify({ organizationId, gatewayDefault: true, rotatedAt: now.toISOString() })}::jsonb,
          ${now}
        )
      `;
  }

  /**
   * Resolves all valid candidate keys for an incoming delivery webhook.
   * Priority:
   * 1. Device-specific key for `${organizationId}:${deviceId}`
   * 2. Organization-level gateway key
   */
  async resolveCandidateKeys(organizationId: string, deviceId?: string): Promise<string[]> {
    if (!organizationId) return [];

    if (this.memoryOnly) {
      return this.resolveCandidateKeysFromMemory(organizationId, deviceId);
    }

    let dbRows: Record<string, any>[] = [];
    if (deviceId && deviceId.trim()) {
      dbRows = await sql<Record<string, any>>`
        SELECT * FROM smsgate_signing_keys
        WHERE organization_id = ${organizationId} AND device_id = ${deviceId.trim()}
      `;
    }

    if (dbRows.length === 0) {
      dbRows = await sql<Record<string, any>>`
        SELECT * FROM smsgate_signing_keys
        WHERE organization_id = ${organizationId} AND device_id IS NULL
      `;
    }

    if (dbRows.length > 0) {
      return this.extractKeysFromRow(dbRows[0]!);
    }

    return [];
  }

  /**
   * Synchronous candidate key resolution from local in-memory cache.
   */
  resolveCandidateKeysSync(organizationId: string, deviceId?: string): string[] {
    return this.resolveCandidateKeysFromMemory(organizationId, deviceId);
  }

  private resolveCandidateKeysFromMemory(organizationId: string, deviceId?: string): string[] {
    if (!organizationId) return [];

    if (deviceId && deviceId.trim()) {
      const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId.trim());
      const record = this.deviceKeys.get(scopeKey);
      if (record) {
        const keys: string[] = [record.currentKey];
        if (record.previousKey) {
          const gracePeriodMs = 24 * 60 * 60 * 1000;
          if (record.rotatedAt && Date.now() - record.rotatedAt.getTime() < gracePeriodMs) {
            keys.push(record.previousKey);
          }
        }
        return keys;
      }
    }

    const gatewayRecord = this.gatewayKeys.get(organizationId.trim());
    if (gatewayRecord) {
      const keys = [gatewayRecord.currentKey];
      if (gatewayRecord.previousKey) {
        const gracePeriodMs = 24 * 60 * 60 * 1000;
        if (gatewayRecord.rotatedAt && Date.now() - gatewayRecord.rotatedAt.getTime() < gracePeriodMs) {
          keys.push(gatewayRecord.previousKey);
        }
      }
      return keys;
    }

    return [];
  }

  private extractKeysFromRow(row: Record<string, any>): string[] {
    const keys: string[] = [];
    if (row.encrypted_key) {
      try {
        const decrypted = decryptSecret(row.encrypted_key);
        keys.push(decrypted);
      } catch (err: unknown) {
        throw new Error(`Failed to decrypt active SMSGate signing key: ${(err as Error).message}`);
      }
    }
    if (row.encrypted_prev_key && row.rotated_at) {
      const gracePeriodMs = 24 * 60 * 60 * 1000;
      const rotatedAtMs = new Date(row.rotated_at).getTime();
      if (Date.now() - rotatedAtMs < gracePeriodMs) {
        try {
          const decryptedPrev = decryptSecret(row.encrypted_prev_key);
          keys.push(decryptedPrev);
        } catch {
          // Gracefully omit corrupt previous key
        }
      }
    }
    return keys;
  }

  /**
   * Revokes a device key upon device unpairing or decommissioning.
   */
  async revokeDeviceKey(organizationId: string, deviceId: string, actorId?: string): Promise<void> {
    const scopeKey = this.buildDeviceKeyScope(organizationId, deviceId);
    this.deviceKeys.delete(scopeKey);

    const now = new Date();
    if (this.memoryOnly) return;

    const deleted = await sql<Record<string, any>>`
        DELETE FROM smsgate_signing_keys
        WHERE organization_id = ${organizationId} AND device_id = ${deviceId.trim()}
        RETURNING id
      `;

    if (deleted.length > 0) {
      await sql`
          INSERT INTO audit_logs (
            id, organization_id, actor_id, actor_type, action, resource_type, resource_id,
            previous_state, new_state, metadata, created_at
          ) VALUES (
            ${randomUUID()}, ${organizationId}, ${actorId ?? '00000000-0000-0000-0000-000000000000'},
            'SYSTEM', 'SMSGATE_KEY_REVOKED', 'smsgate_signing_key', ${deleted[0]!.id},
            ${JSON.stringify({ deviceId: deviceId.trim(), status: 'REVOKED' })}::jsonb,
            NULL,
            ${JSON.stringify({ organizationId, deviceId: deviceId.trim(), revokedAt: now.toISOString() })}::jsonb,
            ${now}
          )
        `;
    }
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
