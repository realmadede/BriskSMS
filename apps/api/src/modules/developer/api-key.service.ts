import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ApiKeyScope,
  ApiKeyDto,
  CreateApiKeyDto,
  CreatedApiKeyResult,
} from '@brisksms/shared';
import { sql, withTransaction } from '@brisksms/db';
import { ApiKeyRecord } from '../../core/store.js';

export class ApiKeyService {
  private mapRow(row: Record<string, any>): ApiKeyRecord {
    const rawScopes = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions;
    return {
      id: row.id,
      organizationId: row.organization_id,
      keyHash: row.key_hash,
      keyPrefix: row.key_prefix,
      label: row.label,
      scopes: Array.isArray(rawScopes) ? rawScopes : [],
      rotatedFromId: row.rotated_from_id ?? null,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Generates a new cryptographically secure API key
   * Returns plaintext key ONLY ONCE during generation; only SHA-256 hash is persisted.
   */
  public async createApiKey(
    organizationId: string,
    dto: CreateApiKeyDto,
  ): Promise<CreatedApiKeyResult> {
    const orgs = await sql<Record<string, any>>`
      SELECT id FROM organizations WHERE id = ${organizationId} LIMIT 1
    `;
    if (orgs.length === 0) {
      throw new Error(`Organization '${organizationId}' does not exist`);
    }

    if (!dto.scopes || dto.scopes.length === 0) {
      throw new Error('At least one ApiKeyScope is required');
    }

    const secretEntropy = randomBytes(24).toString('hex');
    const rawKey = `bsk_live_${secretEntropy}`;
    const keyPrefix = rawKey.substring(0, 14);
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const now = new Date();
    const id = randomUUID();
    const label = dto.name.trim();
    const scopes = [...dto.scopes];

    const inserted = await sql<Record<string, any>>`
      INSERT INTO api_keys (
        id, organization_id, key_hash, key_prefix, label, permissions,
        rotated_from_id, last_used_at, revoked_at, created_at
      ) VALUES (
        ${id}, ${organizationId}, ${keyHash}, ${keyPrefix}, ${label}, ${JSON.stringify(scopes)}::jsonb,
        NULL, NULL, NULL, ${now}
      )
      RETURNING *
    `;

    const record = this.mapRow(inserted[0]!);
    const apiKeyDto: ApiKeyDto = {
      id: record.id,
      organizationId: record.organizationId,
      name: record.label,
      keyPrefix: record.keyPrefix,
      scopes: record.scopes,
      createdAt: record.createdAt,
      lastUsedAt: null,
      revokedAt: null,
    };

    return {
      apiKey: apiKeyDto,
      plainTextSecret: rawKey,
    };
  }

  /**
   * Validates a raw API key, checks revocation, scope authorization, and updates lastUsedAt
   */
  public async validateApiKey(rawKey: string, requiredScope?: ApiKeyScope): Promise<ApiKeyRecord | null> {
    if (!rawKey || !rawKey.startsWith('bsk_live_')) {
      return null;
    }

    const keyHash = createHash('sha256').update(rawKey.trim()).digest('hex');
    const rows = await sql<Record<string, any>>`
      SELECT * FROM api_keys WHERE key_hash = ${keyHash} LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }

    const record = this.mapRow(rows[0]!);
    if (record.revokedAt) {
      return null;
    }

    if (requiredScope && !record.scopes.includes(requiredScope)) {
      return null;
    }

    const now = new Date();
    await sql`
      UPDATE api_keys SET last_used_at = ${now} WHERE id = ${record.id}
    `;
    record.lastUsedAt = now;
    return record;
  }

  /**
   * Revokes an existing API key (enforces organization boundary)
   */
  public async revokeApiKey(
    organizationId: string,
    apiKeyId: string,
  ): Promise<boolean> {
    const now = new Date();
    const updated = await sql<Record<string, any>>`
      UPDATE api_keys
      SET revoked_at = ${now}
      WHERE id = ${apiKeyId} AND organization_id = ${organizationId} AND revoked_at IS NULL
      RETURNING id
    `;
    return updated.length > 0;
  }

  /**
   * Atomically rotates an existing API key, revoking the old key and linking rotated_from_id
   */
  public async rotateApiKey(
    organizationId: string,
    apiKeyId: string,
  ): Promise<CreatedApiKeyResult> {
    return withTransaction(async (tx) => {
      const existing = await tx<Record<string, any>>`
        SELECT * FROM api_keys
        WHERE id = ${apiKeyId} AND organization_id = ${organizationId}
        FOR UPDATE
      `;
      if (existing.length === 0) {
        throw new Error('API key not found for this organization');
      }
      const oldRecord = this.mapRow(existing[0]!);
      if (oldRecord.revokedAt) {
        throw new Error('Cannot rotate an already revoked API key');
      }

      const now = new Date();
      await tx`
        UPDATE api_keys
        SET revoked_at = ${now}
        WHERE id = ${apiKeyId} AND organization_id = ${organizationId}
      `;

      const secretEntropy = randomBytes(24).toString('hex');
      const rawKey = `bsk_live_${secretEntropy}`;
      const keyPrefix = rawKey.substring(0, 14);
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      const newId = randomUUID();

      const inserted = await tx<Record<string, any>>`
        INSERT INTO api_keys (
          id, organization_id, key_hash, key_prefix, label, permissions,
          rotated_from_id, last_used_at, revoked_at, created_at
        ) VALUES (
          ${newId}, ${organizationId}, ${keyHash}, ${keyPrefix}, ${oldRecord.label}, ${JSON.stringify(oldRecord.scopes)}::jsonb,
          ${oldRecord.id}, NULL, NULL, ${now}
        )
        RETURNING *
      `;

      const newRecord = this.mapRow(inserted[0]!);
      return {
        apiKey: {
          id: newRecord.id,
          organizationId: newRecord.organizationId,
          name: newRecord.label,
          keyPrefix: newRecord.keyPrefix,
          scopes: newRecord.scopes,
          createdAt: newRecord.createdAt,
          lastUsedAt: null,
          revokedAt: null,
        },
        plainTextSecret: rawKey,
      };
    });
  }

  /**
   * Lists API keys for an organization (safe DTOs without secrets or hashes)
   */
  public async listApiKeys(organizationId: string): Promise<ApiKeyDto[]> {
    const rows = await sql<Record<string, any>>`
      SELECT id, organization_id, label, key_prefix, permissions, last_used_at, revoked_at, created_at
      FROM api_keys
      WHERE organization_id = ${organizationId}
      ORDER BY created_at DESC, id DESC
    `;

    return rows.map((row) => {
      const rawScopes = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions;
      return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.label,
        keyPrefix: row.key_prefix,
        scopes: Array.isArray(rawScopes) ? rawScopes : [],
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
        revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
        createdAt: new Date(row.created_at),
      };
    });
  }
}
