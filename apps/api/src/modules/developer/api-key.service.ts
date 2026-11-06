import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ApiKeyScope,
  ApiKeyDto,
  CreateApiKeyDto,
  CreatedApiKeyResult,
} from '@brisksms/shared';
import { dbStore, ApiKeyRecord } from '../../core/store.js';

export class ApiKeyService {
  /**
   * Generates a new cryptographically secure API key
   * Returns plaintext key ONLY ONCE during generation
   */
  public createApiKey(
    organizationId: string,
    dto: CreateApiKeyDto,
  ): CreatedApiKeyResult {
    const org = dbStore.organizations.get(organizationId);
    if (!org) {
      throw new Error(`Organization '${organizationId}' does not exist`);
    }

    if (!dto.scopes || dto.scopes.length === 0) {
      throw new Error('At least one ApiKeyScope is required');
    }

    // Generate prefix and high-entropy secret
    const secretEntropy = randomBytes(24).toString('hex'); // 48 chars
    const rawKey = `bsk_live_${secretEntropy}`;
    const keyPrefix = rawKey.substring(0, 14); // "bsk_live_xxxx"

    // Hash with SHA-256 for secure constant-time matching
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const now = new Date();
    const record: ApiKeyRecord = {
      id: randomUUID(),
      organizationId,
      keyHash,
      keyPrefix,
      label: dto.name.trim(),
      scopes: [...dto.scopes],
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };

    dbStore.apiKeys.set(record.id, record);
    dbStore.apiKeysByHash.set(keyHash, record.id);

    const apiKeyDto: ApiKeyDto = {
      id: record.id,
      organizationId,
      name: record.label,
      keyPrefix,
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
  public validateApiKey(rawKey: string, requiredScope?: ApiKeyScope): ApiKeyRecord | null {
    if (!rawKey || !rawKey.startsWith('bsk_live_')) {
      return null;
    }

    const keyHash = createHash('sha256').update(rawKey.trim()).digest('hex');
    const keyId = dbStore.apiKeysByHash.get(keyHash);
    if (!keyId) {
      return null;
    }

    const record = dbStore.apiKeys.get(keyId);
    if (!record) {
      return null;
    }

    if (record.revokedAt) {
      return null;
    }

    if (requiredScope && !record.scopes.includes(requiredScope)) {
      return null;
    }

    // Update telemetry
    record.lastUsedAt = new Date();
    return record;
  }

  /**
   * Revokes an existing API key
   */
  public revokeApiKey(organizationId: string, apiKeyId: string): boolean {
    const record = dbStore.apiKeys.get(apiKeyId);
    if (!record || record.organizationId !== organizationId) {
      return false;
    }

    record.revokedAt = new Date();
    return true;
  }

  /**
   * Lists API keys for an organization (safe DTOs without secrets)
   */
  public listApiKeys(organizationId: string): ApiKeyDto[] {
    const results: ApiKeyDto[] = [];
    for (const record of dbStore.apiKeys.values()) {
      if (record.organizationId === organizationId) {
        results.push({
          id: record.id,
          organizationId: record.organizationId,
          name: record.label,
          keyPrefix: record.keyPrefix,
          scopes: record.scopes,
          lastUsedAt: record.lastUsedAt,
          revokedAt: record.revokedAt,
          createdAt: record.createdAt,
        });
      }
    }

    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}
