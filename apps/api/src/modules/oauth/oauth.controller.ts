import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate } from '../../core/guards.js';
import { OAuthService } from './oauth.service.js';
import { dbStore } from '../../core/store.js';
import { ApiKeyScope, UserRole } from '@brisksms/shared';

const oauthService = new OAuthService();

async function assertDeveloperAccess(orgId: string, userId: string): Promise<void> {
  const membership = await dbStore.getMembership(orgId, userId);
  if (!membership) {
    throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
  }
  const allowed = [UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER];
  if (!allowed.includes(membership.role)) {
    throw new HttpException(
      403,
      'INSUFFICIENT_PERMISSIONS',
      `Action requires one of the following roles: ${allowed.join(', ')}`,
    );
  }
}

export function registerOAuthRoutes(router: Router): void {
  // 1. Register OAuth Client Application (e.g. Zapier App, Third-party ERP)
  router.post('/v1/oauth/clients', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const body = req.body as Record<string, any>;
    const orgId = (body.organizationId as string) || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    if (!body.name || !body.redirectUris || !Array.isArray(body.redirectUris) || body.redirectUris.length === 0) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'name and redirectUris array are required');
    }

    const client = await oauthService.registerClient({
      organizationId: orgId,
      name: String(body.name),
      redirectUris: body.redirectUris.map(String),
      isPublic: body.isPublic !== undefined ? Boolean(body.isPublic) : true,
      clientSecret: body.clientSecret ? String(body.clientSecret) : undefined,
    });

    return {
      success: true,
      statusCode: 201,
      data: {
        id: client.id,
        organizationId: client.organizationId,
        name: client.name,
        redirectUris: client.redirectUris,
        isPublic: client.isPublic,
        createdAt: client.createdAt,
      },
    };
  });

  // 2. RFC 7636 Authorization Endpoint (Issues authorization code with PKCE challenge)
  router.get('/v1/oauth/authorize', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const clientId = req.query.client_id;
    const redirectUri = req.query.redirect_uri;
    const responseType = req.query.response_type;
    const codeChallenge = req.query.code_challenge;
    const codeChallengeMethod = (req.query.code_challenge_method || 'S256') as 'S256' | 'plain';
    const rawScope = req.query.scope || '';
    const state = req.query.state || '';

    if (!clientId || !redirectUri || !codeChallenge) {
      throw new HttpException(400, 'INVALID_REQUEST', 'client_id, redirect_uri, and code_challenge are required');
    }

    if (responseType !== 'code') {
      throw new HttpException(400, 'UNSUPPORTED_RESPONSE_TYPE', 'response_type must be "code"');
    }

    const client = await oauthService.getClient(clientId);
    if (!client) {
      throw new HttpException(404, 'INVALID_CLIENT', `OAuth client '${clientId}' not found`);
    }

    // Ensure user belongs to the client's organization
    await assertDeveloperAccess(client.organizationId, userId);

    const scopes = rawScope
      ? (rawScope.split(/[\s,]+/).filter(Boolean) as ApiKeyScope[])
      : [ApiKeyScope.SMS_SEND, ApiKeyScope.PAYMENTS_READ];

    const code = await oauthService.generateAuthorizationCode({
      clientId,
      userId,
      organizationId: client.organizationId,
      redirectUri,
      scopes,
      codeChallenge,
      codeChallengeMethod,
    });

    const parsedRedirect = new URL(redirectUri);
    parsedRedirect.searchParams.set('code', code);
    if (state) {
      parsedRedirect.searchParams.set('state', state);
    }

    return {
      success: true,
      data: {
        code,
        state,
        redirectUri: parsedRedirect.toString(),
      },
    };
  });

  // 3. RFC 7636 Token Endpoint (Exchanges authorization code with PKCE verifier or refreshes tokens)
  router.post('/v1/oauth/token', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = req.body as Record<string, any>;
    const grantType = body.grant_type;

    if (grantType === 'authorization_code') {
      const clientId = body.client_id;
      const code = body.code;
      const codeVerifier = body.code_verifier;
      const redirectUri = body.redirect_uri;
      const clientSecret = body.client_secret;

      if (!clientId || !code || !codeVerifier || !redirectUri) {
        throw new HttpException(
          400,
          'INVALID_REQUEST',
          'client_id, code, code_verifier, and redirect_uri are required for authorization_code grant',
        );
      }

      const tokens = await oauthService.exchangeCodeForTokens({
        clientId: String(clientId),
        code: String(code),
        codeVerifier: String(codeVerifier),
        redirectUri: String(redirectUri),
        clientSecret: clientSecret ? String(clientSecret) : undefined,
      });

      return {
        success: true,
        data: tokens,
      };
    }

    if (grantType === 'refresh_token') {
      const clientId = body.client_id;
      const refreshToken = body.refresh_token;
      const clientSecret = body.client_secret;

      if (!clientId || !refreshToken) {
        throw new HttpException(
          400,
          'INVALID_REQUEST',
          'client_id and refresh_token are required for refresh_token grant',
        );
      }

      const tokens = await oauthService.refreshTokens({
        clientId: String(clientId),
        refreshToken: String(refreshToken),
        clientSecret: clientSecret ? String(clientSecret) : undefined,
      });

      return {
        success: true,
        data: tokens,
      };
    }

    throw new HttpException(
      400,
      'UNSUPPORTED_GRANT_TYPE',
      'grant_type must be either "authorization_code" or "refresh_token"',
    );
  });
}
