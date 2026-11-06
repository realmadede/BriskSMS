import { createHash, randomBytes } from 'node:crypto';
import { ApiKeyScope } from '@brisksms/shared';
import {
  dbStore,
  OAuthClientRecord,
  OAuthAuthorizationCodeRecord,
  OAuthTokenRecord,
} from '../../core/store.js';

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
  /**
   * Registers a client application (e.g. Zapier CLI, Make.com, n8n)
   */
  public registerClient(dto: RegisterOAuthClientDto): OAuthClientRecord {
    const id = `client_${randomBytes(12).toString('hex')}`;
    const clientSecretHash = dto.clientSecret
      ? createHash('sha256').update(dto.clientSecret).digest('hex')
      : null;

    const record: OAuthClientRecord = {
      id,
      organizationId: dto.organizationId,
      name: dto.name.trim(),
      clientSecretHash,
      redirectUris: dto.redirectUris.map((u) => u.trim()),
      isPublic: dto.isPublic ?? true, // Default to public client for PKCE
      createdAt: new Date(),
    };

    dbStore.oauthClients.set(id, record);
    return record;
  }

  /**
   * Issues a short-lived (10-minute) single-use authorization code with PKCE challenge
   */
  public generateAuthorizationCode(dto: AuthorizeCodeDto): string {
    const client = dbStore.oauthClients.get(dto.clientId);
    if (!client) {
      throw new Error(`Invalid OAuth client_id: ${dto.clientId}`);
    }

    if (!client.redirectUris.includes(dto.redirectUri)) {
      throw new Error(`Unauthorized redirect_uri: ${dto.redirectUri}`);
    }

    if (!dto.codeChallenge) {
      throw new Error('PKCE code_challenge is required');
    }

    const code = `code_${randomBytes(24).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

    const authCodeRecord: OAuthAuthorizationCodeRecord = {
      code,
      clientId: dto.clientId,
      userId: dto.userId,
      organizationId: dto.organizationId,
      redirectUri: dto.redirectUri,
      scopes: dto.scopes,
      codeChallenge: dto.codeChallenge,
      codeChallengeMethod: dto.codeChallengeMethod ?? 'S256',
      expiresAt,
      isUsed: false,
      createdAt: now,
    };

    dbStore.oauthCodes.set(code, authCodeRecord);
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

    // S256: BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))
    const computedHash = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    return computedHash === challenge;
  }

  /**
   * Exchanges authorization code for access and refresh tokens
   */
  public exchangeCodeForTokens(dto: ExchangeCodeDto): TokenResponse {
    const client = dbStore.oauthClients.get(dto.clientId);
    if (!client) {
      throw new Error(`Invalid client_id: ${dto.clientId}`);
    }

    // If client is confidential, verify client_secret
    if (!client.isPublic && client.clientSecretHash) {
      if (!dto.clientSecret) {
        throw new Error('client_secret is required for confidential clients');
      }
      const secretHash = createHash('sha256').update(dto.clientSecret).digest('hex');
      if (secretHash !== client.clientSecretHash) {
        throw new Error('Invalid client_secret');
      }
    }

    const codeRecord = dbStore.oauthCodes.get(dto.code);
    if (!codeRecord) {
      throw new Error('Invalid authorization code');
    }

    if (codeRecord.isUsed) {
      throw new Error('Authorization code has already been used');
    }

    if (new Date() > codeRecord.expiresAt) {
      throw new Error('Authorization code has expired');
    }

    if (codeRecord.clientId !== dto.clientId) {
      throw new Error('Authorization code was issued to a different client');
    }

    if (codeRecord.redirectUri !== dto.redirectUri) {
      throw new Error('redirect_uri does not match original authorization request');
    }

    // Verify PKCE Challenge
    const isPkceValid = this.verifyCodeChallenge(
      dto.codeVerifier,
      codeRecord.codeChallenge,
      codeRecord.codeChallengeMethod,
    );

    if (!isPkceValid) {
      throw new Error('Invalid PKCE code_verifier');
    }

    // Mark code as used
    codeRecord.isUsed = true;

    // Issue tokens
    return this.issueTokenRecord(
      codeRecord.clientId,
      codeRecord.userId,
      codeRecord.organizationId,
      codeRecord.scopes,
    );
  }

  /**
   * Refreshes an expired access token using a valid refresh token
   */
  public refreshTokens(dto: RefreshTokenDto): TokenResponse {
    const accessToken = dbStore.oauthTokensByRefresh.get(dto.refreshToken);
    if (!accessToken) {
      throw new Error('Invalid refresh token');
    }

    const tokenRecord = dbStore.oauthTokens.get(accessToken);
    if (!tokenRecord) {
      throw new Error('Token record not found');
    }

    if (tokenRecord.revokedAt) {
      throw new Error('Token has been revoked');
    }

    if (new Date() > tokenRecord.refreshExpiresAt) {
      throw new Error('Refresh token has expired');
    }

    if (tokenRecord.clientId !== dto.clientId) {
      throw new Error('Refresh token was issued to a different client');
    }

    // Revoke old access token
    tokenRecord.revokedAt = new Date();
    dbStore.oauthTokensByRefresh.delete(dto.refreshToken);

    // Issue new pair
    return this.issueTokenRecord(
      tokenRecord.clientId,
      tokenRecord.userId,
      tokenRecord.organizationId,
      tokenRecord.scopes,
    );
  }

  /**
   * Validates bearer access token and authorization scope
   */
  public verifyAccessToken(
    token: string,
    requiredScope?: ApiKeyScope,
  ): { organizationId: string; userId: string; scopes: ApiKeyScope[] } | null {
    if (!token || !token.startsWith('bsk_at_')) {
      return null;
    }

    const record = dbStore.oauthTokens.get(token);
    if (!record) {
      return null;
    }

    if (record.revokedAt) {
      return null;
    }

    if (new Date() > record.expiresAt) {
      return null;
    }

    if (requiredScope && !record.scopes.includes(requiredScope)) {
      return null;
    }

    return {
      organizationId: record.organizationId,
      userId: record.userId,
      scopes: record.scopes,
    };
  }

  /**
   * Revokes an active token (RFC 7009)
   */
  public revokeToken(token: string): boolean {
    const record = dbStore.oauthTokens.get(token);
    if (record) {
      record.revokedAt = new Date();
      dbStore.oauthTokensByRefresh.delete(record.refreshToken);
      return true;
    }

    // Check if refresh token was passed
    const at = dbStore.oauthTokensByRefresh.get(token);
    if (at) {
      const rec = dbStore.oauthTokens.get(at);
      if (rec) {
        rec.revokedAt = new Date();
        dbStore.oauthTokensByRefresh.delete(token);
        return true;
      }
    }

    return false;
  }

  private issueTokenRecord(
    clientId: string,
    userId: string,
    organizationId: string,
    scopes: ApiKeyScope[],
  ): TokenResponse {
    const now = new Date();
    const expiresInSeconds = 3600; // 1 hour
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);
    const refreshExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const accessToken = `bsk_at_${randomBytes(24).toString('hex')}`;
    const refreshToken = `bsk_rt_${randomBytes(32).toString('hex')}`;

    const tokenRecord: OAuthTokenRecord = {
      accessToken,
      refreshToken,
      clientId,
      userId,
      organizationId,
      scopes,
      expiresAt,
      refreshExpiresAt,
      revokedAt: null,
      createdAt: now,
    };

    dbStore.oauthTokens.set(accessToken, tokenRecord);
    dbStore.oauthTokensByRefresh.set(refreshToken, accessToken);

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
