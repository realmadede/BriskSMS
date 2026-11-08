import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiKeyScope } from '@brisksms/shared';
import { sql, SqlExecutor, withTransaction } from '@brisksms/db';
import { OAuthClientRecord } from '../../core/store.js';

export interface RegisterOAuthClientDto {
  organizationId: string;
  name: string;
  redirectUris: string[];
  isPublic?: boolean;
  clientSecret?: string;
}

export interface AuthorizeCodeDto {
  clientId: string;
  userId: string;
  organizationId: string;
  redirectUri: string;
  scopes: ApiKeyScope[];
  codeChallenge: string;
  codeChallengeMethod?: 'S256' | 'plain';
}

export interface ExchangeCodeDto {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientSecret?: string;
}

export interface RefreshTokenDto {
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number; // 3600 seconds (1 hour)
  refresh_token: string;
  scope: string;
  organization_id: string;
}

export class OAuthService {
  private mapClientRow(row: Record<string, any>): OAuthClientRecord {
    const rawUris =
      typeof row.redirect_uris === 'string'
        ? JSON.parse(row.redirect_uris)
        : row.redirect_uris;
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      clientSecretHash: row.client_secret_hash,
      redirectUris: Array.isArray(rawUris) ? rawUris : [],
      isPublic: Boolean(row.is_public),
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Registers a client application (e.g. Zapier CLI, Make.com, n8n)
   */
  public async registerClient(dto: RegisterOAuthClientDto): Promise<OAuthClientRecord> {
    const id = randomUUID();
    const clientSecretHash = dto.clientSecret
      ? createHash('sha256').update(dto.clientSecret).digest('hex')
      : null;
    const redirectUris = dto.redirectUris.map((u) => u.trim());
    const isPublic = dto.isPublic ?? true;
    const now = new Date();

    const inserted = await sql<Record<string, any>>`
      INSERT INTO oauth_clients (
        id, organization_id, name, client_secret_hash, redirect_uris, is_public, created_at, updated_at
      ) VALUES (
        ${id}, ${dto.organizationId}, ${dto.name.trim()}, ${clientSecretHash},
        ${JSON.stringify(redirectUris)}::jsonb, ${isPublic}, ${now}, ${now}
      )
      RETURNING *
    `;

    return this.mapClientRow(inserted[0]!);
  }

  /**
   * Retrieves an OAuth client by ID
   */
  public async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    const rows = await sql<Record<string, any>>`
      SELECT * FROM oauth_clients WHERE id = ${clientId} LIMIT 1
    `;
    return rows[0] ? this.mapClientRow(rows[0]) : null;
  }

  /**
   * Issues a short-lived (10-minute) single-use authorization code with PKCE challenge
   */
  public async generateAuthorizationCode(dto: AuthorizeCodeDto): Promise<string> {
    const clientRows = await sql<Record<string, any>>`
      SELECT * FROM oauth_clients WHERE id = ${dto.clientId} LIMIT 1
    `;
    if (clientRows.length === 0) {
      throw new Error(`Invalid OAuth client_id: ${dto.clientId}`);
    }

    const client = this.mapClientRow(clientRows[0]!);
    if (client.organizationId !== dto.organizationId) {
      throw new Error('OAuth client does not belong to the specified organization');
    }

    if (!client.redirectUris.includes(dto.redirectUri)) {
      throw new Error(`Unauthorized redirect_uri: ${dto.redirectUri}`);
    }

    if (!dto.codeChallenge) {
      throw new Error('PKCE code_challenge is required');
    }

    const code = `code_${randomBytes(24).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
    const scopes = [...dto.scopes];
    const method = dto.codeChallengeMethod ?? 'S256';

    await sql`
      INSERT INTO oauth_authorization_codes (
        code, client_id, user_id, organization_id, redirect_uri,
        scopes, code_challenge, code_challenge_method, expires_at, used_at, created_at
      ) VALUES (
        ${code}, ${dto.clientId}, ${dto.userId}, ${dto.organizationId}, ${dto.redirectUri},
        ${JSON.stringify(scopes)}::jsonb, ${dto.codeChallenge}, ${method}, ${expiresAt}, NULL, ${now}
      )
    `;

    return code;
  }

  /**
   * Verifies PKCE code_verifier against code_challenge (RFC 7636)
   */
  public verifyCodeChallenge(
    codeVerifier: string,
    challenge: string,
    method: 'S256' | 'plain',
  ): boolean {
    if (method === 'plain') {
      return codeVerifier === challenge;
    }

    const computedHash = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    return computedHash === challenge;
  }

  /**
   * Exchanges authorization code for access and refresh tokens inside an ACID transaction
   */
  public async exchangeCodeForTokens(dto: ExchangeCodeDto): Promise<TokenResponse> {
    return withTransaction(async (tx) => {
      const clientRows = await tx<Record<string, any>>`
        SELECT * FROM oauth_clients WHERE id = ${dto.clientId} LIMIT 1
      `;
      if (clientRows.length === 0) {
        throw new Error(`Invalid client_id: ${dto.clientId}`);
      }
      const client = this.mapClientRow(clientRows[0]!);

      if (!client.isPublic && client.clientSecretHash) {
        if (!dto.clientSecret) {
          throw new Error('client_secret is required for confidential clients');
        }
        const secretHash = createHash('sha256').update(dto.clientSecret).digest('hex');
        if (secretHash !== client.clientSecretHash) {
          throw new Error('Invalid client_secret');
        }
      }

      const codeRows = await tx<Record<string, any>>`
        SELECT * FROM oauth_authorization_codes WHERE code = ${dto.code} FOR UPDATE
      `;
      if (codeRows.length === 0) {
        throw new Error('Invalid authorization code');
      }
      const codeRecord = codeRows[0]!;

      if (codeRecord.used_at) {
        throw new Error('Authorization code has already been used');
      }

      if (new Date() > new Date(codeRecord.expires_at)) {
        throw new Error('Authorization code has expired');
      }

      if (codeRecord.client_id !== dto.clientId) {
        throw new Error('Authorization code was issued to a different client');
      }

      if (codeRecord.redirect_uri !== dto.redirectUri) {
        throw new Error('redirect_uri does not match original authorization request');
      }

      const isPkceValid = this.verifyCodeChallenge(
        dto.codeVerifier,
        codeRecord.code_challenge,
        codeRecord.code_challenge_method as 'S256' | 'plain',
      );

      if (!isPkceValid) {
        throw new Error('Invalid PKCE code_verifier');
      }

      const now = new Date();
      await tx`
        UPDATE oauth_authorization_codes SET used_at = ${now} WHERE code = ${dto.code}
      `;

      const rawScopes =
        typeof codeRecord.scopes === 'string'
          ? JSON.parse(codeRecord.scopes)
          : codeRecord.scopes;

      return this.issueTokenRecordTx(
        tx,
        codeRecord.client_id,
        codeRecord.user_id,
        codeRecord.organization_id,
        Array.isArray(rawScopes) ? rawScopes : [],
      );
    });
  }

  /**
   * Refreshes an expired access token using a valid refresh token
   */
  public async refreshTokens(dto: RefreshTokenDto): Promise<TokenResponse> {
    const refreshTokenHash = createHash('sha256').update(dto.refreshToken).digest('hex');

    return withTransaction(async (tx) => {
      const tokenRows = await tx<Record<string, any>>`
        SELECT * FROM oauth_tokens WHERE refresh_token_hash = ${refreshTokenHash} FOR UPDATE
      `;
      if (tokenRows.length === 0) {
        throw new Error('Invalid refresh token');
      }

      const tokenRecord = tokenRows[0]!;

      if (tokenRecord.revoked_at) {
        throw new Error('Token has been revoked');
      }

      if (new Date() > new Date(tokenRecord.refresh_token_expires_at)) {
        throw new Error('Refresh token has expired');
      }

      if (tokenRecord.client_id !== dto.clientId) {
        throw new Error('Refresh token was issued to a different client');
      }

      const now = new Date();
      await tx`
        UPDATE oauth_tokens SET revoked_at = ${now} WHERE id = ${tokenRecord.id}
      `;

      const rawScopes =
        typeof tokenRecord.scopes === 'string'
          ? JSON.parse(tokenRecord.scopes)
          : tokenRecord.scopes;

      return this.issueTokenRecordTx(
        tx,
        tokenRecord.client_id,
        tokenRecord.user_id,
        tokenRecord.organization_id,
        Array.isArray(rawScopes) ? rawScopes : [],
      );
    });
  }

  /**
   * Validates bearer access token and authorization scope
   */
  public async verifyAccessToken(
    token: string,
    requiredScope?: ApiKeyScope,
  ): Promise<{ organizationId: string; userId: string; scopes: ApiKeyScope[] } | null> {
    if (!token || !token.startsWith('bsk_at_')) {
      return null;
    }

    const accessTokenHash = createHash('sha256').update(token).digest('hex');
    const rows = await sql<Record<string, any>>`
      SELECT * FROM oauth_tokens WHERE access_token_hash = ${accessTokenHash} LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }

    const record = rows[0]!;
    if (record.revoked_at) {
      return null;
    }

    if (new Date() > new Date(record.access_token_expires_at)) {
      return null;
    }

    const rawScopes =
      typeof record.scopes === 'string'
        ? JSON.parse(record.scopes)
        : record.scopes;
    const scopes: ApiKeyScope[] = Array.isArray(rawScopes) ? rawScopes : [];
    if (requiredScope && !scopes.includes(requiredScope)) {
      return null;
    }

    return {
      organizationId: record.organization_id,
      userId: record.user_id,
      scopes,
    };
  }

  /**
   * Revokes an active token (RFC 7009)
   */
  public async revokeToken(token: string): Promise<boolean> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();

    const updated = await sql<Record<string, any>>`
      UPDATE oauth_tokens
      SET revoked_at = ${now}
      WHERE (access_token_hash = ${tokenHash} OR refresh_token_hash = ${tokenHash})
        AND revoked_at IS NULL
      RETURNING id
    `;

    return updated.length > 0;
  }

  private async issueTokenRecordTx(
    tx: SqlExecutor,
    clientId: string,
    userId: string,
    organizationId: string,
    scopes: ApiKeyScope[],
  ): Promise<TokenResponse> {
    const now = new Date();
    const expiresInSeconds = 3600;
    const accessTokenExpiresAt = new Date(now.getTime() + expiresInSeconds * 1000);
    const refreshTokenExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const accessToken = `bsk_at_${randomBytes(24).toString('hex')}`;
    const refreshToken = `bsk_rt_${randomBytes(32).toString('hex')}`;

    const accessTokenHash = createHash('sha256').update(accessToken).digest('hex');
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('hex');

    await tx`
      INSERT INTO oauth_tokens (
        id, access_token_hash, refresh_token_hash, client_id, user_id,
        organization_id, scopes, access_token_expires_at, refresh_token_expires_at, revoked_at, created_at
      ) VALUES (
        ${randomUUID()}, ${accessTokenHash}, ${refreshTokenHash}, ${clientId}, ${userId},
        ${organizationId}, ${JSON.stringify(scopes)}::jsonb, ${accessTokenExpiresAt}, ${refreshTokenExpiresAt}, NULL, ${now}
      )
    `;

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresInSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
      organization_id: organizationId,
    };
  }
}
