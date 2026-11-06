import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiKeyScope } from '@brisksms/shared';
import { dbStore, OrganizationRecord } from '../src/core/store.js';
import { OAuthService } from '../src/modules/oauth/oauth.service.js';

describe('OAuth 2.0 PKCE Server (@brisksms/api)', () => {
  let oauthService: OAuthService;
  const orgId = randomUUID();
  const userId = randomUUID();

  beforeEach(() => {
    dbStore.reset();
    oauthService = new OAuthService();

    const org: OrganizationRecord = {
      id: orgId,
      name: 'Sahara Trading Hub',
      slug: 'sahara-trading',
      countryCode: 'TZ',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    dbStore.organizations.set(orgId, org);
  });

  it('registers an OAuth client application with redirect URIs', () => {
    const client = oauthService.registerClient({
      organizationId: orgId,
      name: 'Zapier Community CLI App',
      redirectUris: ['https://zapier.com/dashboard/auth/oauth/return/App12345/'],
      isPublic: true,
    });

    assert.equal(client.name, 'Zapier Community CLI App');
    assert.equal(client.redirectUris[0], 'https://zapier.com/dashboard/auth/oauth/return/App12345/');
    assert.equal(client.isPublic, true);
    assert.equal(dbStore.oauthClients.has(client.id), true);
  });

  it('executes full RFC 7636 PKCE authorization code exchange flow', () => {
    const redirectUri = 'https://zapier.com/dashboard/auth/oauth/return/App12345/';
    const client = oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Zapier App',
      redirectUris: [redirectUri],
      isPublic: true,
    });

    // 1. Client generates PKCE code_verifier and code_challenge (S256)
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    // 2. Authorization request
    const authCode = oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND, ApiKeyScope.PAYMENTS_READ],
      codeChallenge,
      codeChallengeMethod: 'S256',
    });

    assert.equal(authCode.startsWith('code_'), true);

    // 3. Token exchange request with code_verifier
    const tokenResponse = oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code: authCode,
      codeVerifier,
      redirectUri,
    });

    assert.equal(tokenResponse.access_token.startsWith('bsk_at_'), true);
    assert.equal(tokenResponse.refresh_token.startsWith('bsk_rt_'), true);
    assert.equal(tokenResponse.token_type, 'Bearer');
    assert.equal(tokenResponse.expires_in, 3600);
    assert.equal(tokenResponse.organization_id, orgId);

    // 4. Verify access token authorization
    const verified = oauthService.verifyAccessToken(tokenResponse.access_token, ApiKeyScope.SMS_SEND);
    assert.notEqual(verified, null);
    assert.equal(verified?.organizationId, orgId);

    // Missing scope rejected
    const ungranted = oauthService.verifyAccessToken(tokenResponse.access_token, ApiKeyScope.INVOICES_WRITE);
    assert.equal(ungranted, null);
  });

  it('rejects invalid PKCE code_verifier', () => {
    const redirectUri = 'https://zapier.com/dashboard/auth/oauth/return/App12345/';
    const client = oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Zapier App',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'actual_secret_code_verifier_998877';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND],
      codeChallenge,
      codeChallengeMethod: 'S256',
    });

    // Attempt token exchange with wrong code_verifier
    assert.throws(
      () =>
        oauthService.exchangeCodeForTokens({
          clientId: client.id,
          code: authCode,
          codeVerifier: 'tampered_or_wrong_verifier_112233',
          redirectUri,
        }),
      /Invalid PKCE code_verifier/,
    );
  });

  it('prevents authorization code replay (single-use invariant)', () => {
    const redirectUri = 'https://zapier.com/callback';
    const client = oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Client',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'verifier_code_12345';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND],
      codeChallenge,
    });

    // First exchange succeeds
    oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code: authCode,
      codeVerifier,
      redirectUri,
    });

    // Second replay attempt must be rejected
    assert.throws(
      () =>
        oauthService.exchangeCodeForTokens({
          clientId: client.id,
          code: authCode,
          codeVerifier,
          redirectUri,
        }),
      /Authorization code has already been used/,
    );
  });

  it('refreshes expired access tokens using valid refresh tokens', () => {
    const redirectUri = 'https://zapier.com/callback';
    const client = oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Client',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'verifier_refresh_9988';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.PAYMENTS_READ],
      codeChallenge,
    });

    const tokens = oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code: authCode,
      codeVerifier,
      redirectUri,
    });

    // Refresh
    const newTokens = oauthService.refreshTokens({
      clientId: client.id,
      refreshToken: tokens.refresh_token,
    });

    assert.notEqual(newTokens.access_token, tokens.access_token);
    assert.equal(newTokens.token_type, 'Bearer');

    // Old access token should now be invalid
    const oldVerified = oauthService.verifyAccessToken(tokens.access_token);
    assert.equal(oldVerified, null);

    // New access token is active
    const newVerified = oauthService.verifyAccessToken(newTokens.access_token, ApiKeyScope.PAYMENTS_READ);
    assert.notEqual(newVerified, null);
  });

  it('revokes active access tokens and refresh tokens upon request', () => {
    const redirectUri = 'https://zapier.com/callback';
    const client = oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Client',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'verifier_revoke_7766';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND],
      codeChallenge,
    });

    const tokens = oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code: authCode,
      codeVerifier,
      redirectUri,
    });

    // Revoke
    const revoked = oauthService.revokeToken(tokens.access_token);
    assert.equal(revoked, true);

    const verified = oauthService.verifyAccessToken(tokens.access_token);
    assert.equal(verified, null);
  });
});
