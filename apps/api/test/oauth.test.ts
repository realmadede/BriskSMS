import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiKeyScope, UserRole } from '@brisksms/shared';
import { dbStore } from '../src/core/store.js';
import { OAuthService } from '../src/modules/oauth/oauth.service.js';

describe('OAuth 2.0 PKCE Server (@brisksms/api)', () => {
  let oauthService: OAuthService;
  let orgId = randomUUID();
  let userId = randomUUID();

  beforeEach(async () => {
    await dbStore.reset();
    oauthService = new OAuthService();

    const user = await dbStore.createUser({
      email: 'oauth-owner@sahara.co.tz',
      passwordHash: 'scrypt:salt:hash',
      fullName: 'Sahara Owner',
    });
    userId = user.id;

    const org = await dbStore.seedOrganizationDirect({
      id: randomUUID(),
      name: 'Sahara Trading Hub',
      slug: `sahara-trading-${randomUUID().slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
    });
    orgId = org.id;

    await dbStore.addMember({
      organizationId: orgId,
      userId,
      role: UserRole.OWNER,
      actorId: userId,
    });
  });

  it('registers an OAuth client application with redirect URIs', async () => {
    const client = await oauthService.registerClient({
      organizationId: orgId,
      name: 'Zapier Community CLI App',
      redirectUris: ['https://zapier.com/dashboard/auth/oauth/return/App12345/'],
      isPublic: true,
    });

    assert.equal(client.name, 'Zapier Community CLI App');
    assert.equal(client.redirectUris[0], 'https://zapier.com/dashboard/auth/oauth/return/App12345/');
    assert.equal(client.isPublic, true);
  });

  it('executes full RFC 7636 PKCE authorization code exchange flow', async () => {
    const redirectUri = 'https://zapier.com/dashboard/auth/oauth/return/App12345/';
    const client = await oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Zapier App',
      redirectUris: [redirectUri],
      isPublic: true,
    });

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = await oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND, ApiKeyScope.PAYMENTS_READ],
      codeChallenge,
      codeChallengeMethod: 'S256',
    });

    assert.equal(authCode.startsWith('code_'), true);

    const tokenResponse = await oauthService.exchangeCodeForTokens({
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

    const verified = await oauthService.verifyAccessToken(tokenResponse.access_token, ApiKeyScope.SMS_SEND);
    assert.notEqual(verified, null);
    assert.equal(verified?.organizationId, orgId);

    const ungranted = await oauthService.verifyAccessToken(tokenResponse.access_token, ApiKeyScope.INVOICES_WRITE);
    assert.equal(ungranted, null);
  });

  it('rejects invalid PKCE code_verifier', async () => {
    const redirectUri = 'https://zapier.com/dashboard/auth/oauth/return/App12345/';
    const client = await oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Zapier App',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'actual_secret_code_verifier_998877';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = await oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND],
      codeChallenge,
      codeChallengeMethod: 'S256',
    });

    await assert.rejects(
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

  it('prevents authorization code replay (single-use invariant)', async () => {
    const redirectUri = 'https://zapier.com/callback';
    const client = await oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Client',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'verifier_code_12345';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = await oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND],
      codeChallenge,
    });

    await oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code: authCode,
      codeVerifier,
      redirectUri,
    });

    await assert.rejects(
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

  it('refreshes expired access tokens using valid refresh tokens', async () => {
    const redirectUri = 'https://zapier.com/callback';
    const client = await oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Client',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'verifier_refresh_9988';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = await oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.PAYMENTS_READ],
      codeChallenge,
    });

    const tokens = await oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code: authCode,
      codeVerifier,
      redirectUri,
    });

    const newTokens = await oauthService.refreshTokens({
      clientId: client.id,
      refreshToken: tokens.refresh_token,
    });

    assert.notEqual(newTokens.access_token, tokens.access_token);
    assert.equal(newTokens.token_type, 'Bearer');

    const oldVerified = await oauthService.verifyAccessToken(tokens.access_token);
    assert.equal(oldVerified, null);

    const newVerified = await oauthService.verifyAccessToken(newTokens.access_token, ApiKeyScope.PAYMENTS_READ);
    assert.notEqual(newVerified, null);
  });

  it('revokes active access tokens and refresh tokens upon request', async () => {
    const redirectUri = 'https://zapier.com/callback';
    const client = await oauthService.registerClient({
      organizationId: orgId,
      name: 'BriskSMS Client',
      redirectUris: [redirectUri],
    });

    const codeVerifier = 'verifier_revoke_7766';
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');

    const authCode = await oauthService.generateAuthorizationCode({
      clientId: client.id,
      userId,
      organizationId: orgId,
      redirectUri,
      scopes: [ApiKeyScope.SMS_SEND],
      codeChallenge,
    });

    const tokens = await oauthService.exchangeCodeForTokens({
      clientId: client.id,
      code: authCode,
      codeVerifier,
      redirectUri,
    });

    const revoked = await oauthService.revokeToken(tokens.access_token);
    assert.equal(revoked, true);

    const verified = await oauthService.verifyAccessToken(tokens.access_token);
    assert.equal(verified, null);
  });
});
