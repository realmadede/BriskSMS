import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import type { CookieToSet } from '../../core/cookies.js';
import { authService, RegisterDto, LoginDto } from './auth.service.js';
import { authenticate, validateCsrf } from '../../core/guards.js';
import { hashToken } from '../../core/crypto.js';
import { sql } from '@brisksms/db';
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  getSessionCookieOptions,
  getRefreshCookieOptions,
  getCsrfCookieOptions,
  getClearedCookieOptions,
  generateCsrfToken,
} from '../../core/cookies.js';

export function registerAuthRoutes(router: Router): void {
  // Public CSRF handshake endpoint for browser clients
  router.get('/v1/auth/csrf', async (): Promise<ApiResponse> => {
    const csrfToken = generateCsrfToken();
    return {
      success: true,
      data: { csrfToken },
      cookies: [{ name: CSRF_COOKIE_NAME, value: csrfToken, options: getCsrfCookieOptions() }],
    };
  });

  router.post('/v1/auth/register', async (req: RouteRequest): Promise<ApiResponse> => {
    // If browser sent CSRF cookie or token, validate it
    if (req.cookies[CSRF_COOKIE_NAME] || req.headers['x-csrf-token']) {
      validateCsrf(req);
    }

    const dto = req.body as unknown as RegisterDto;
    const result = await authService.register(dto);
    const csrfToken = generateCsrfToken();

    const cookies: CookieToSet[] = [
      { name: SESSION_COOKIE_NAME, value: result.tokens.accessToken, options: getSessionCookieOptions() },
      { name: REFRESH_COOKIE_NAME, value: result.tokens.refreshToken, options: getRefreshCookieOptions() },
      { name: CSRF_COOKIE_NAME, value: csrfToken, options: getCsrfCookieOptions() },
    ];

    return {
      success: true,
      statusCode: 201,
      data: {
        ...result,
        csrfToken,
      },
      cookies,
    };
  });

  router.post('/v1/auth/login', async (req: RouteRequest): Promise<ApiResponse> => {
    // If browser sent CSRF cookie or token, validate it
    if (req.cookies[CSRF_COOKIE_NAME] || req.headers['x-csrf-token']) {
      validateCsrf(req);
    }

    const dto = req.body as unknown as LoginDto;
    const result = await authService.login(dto);
    const csrfToken = generateCsrfToken();

    const cookies: CookieToSet[] = [
      { name: SESSION_COOKIE_NAME, value: result.tokens.accessToken, options: getSessionCookieOptions() },
      { name: REFRESH_COOKIE_NAME, value: result.tokens.refreshToken, options: getRefreshCookieOptions() },
      { name: CSRF_COOKIE_NAME, value: csrfToken, options: getCsrfCookieOptions() },
    ];

    return {
      success: true,
      data: {
        ...result,
        csrfToken,
      },
      cookies,
    };
  });

  router.post('/v1/auth/refresh', async (req: RouteRequest): Promise<ApiResponse> => {
    let token = (req.body.refreshToken as string) || '';
    const isCookieRefresh = !token && Boolean(req.cookies[REFRESH_COOKIE_NAME]);

    if (!token && isCookieRefresh) {
      token = req.cookies[REFRESH_COOKIE_NAME]!;
      validateCsrf(req);
    }

    if (!token) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Refresh token is required');
    }

    const tokens = await authService.refreshToken(token);
    const csrfToken = generateCsrfToken();

    const cookies: CookieToSet[] = [
      { name: SESSION_COOKIE_NAME, value: tokens.accessToken, options: getSessionCookieOptions() },
      { name: REFRESH_COOKIE_NAME, value: tokens.refreshToken, options: getRefreshCookieOptions() },
      { name: CSRF_COOKIE_NAME, value: csrfToken, options: getCsrfCookieOptions() },
    ];

    return {
      success: true,
      data: {
        ...tokens,
        csrfToken,
      },
      cookies,
    };
  });

  router.post('/v1/auth/logout', async (req: RouteRequest): Promise<ApiResponse> => {
    try {
      authenticate(req);
      if (req.context.jti) {
        await authService.revokeSession(req.context.jti, req.context.userId);
      }
    } catch {
      // Allow clean logout even if session was expired
    }

    // Revoke refresh token in database if present in cookies
    const rawRefresh = req.cookies[REFRESH_COOKIE_NAME];
    if (rawRefresh) {
      const refreshHash = hashToken(rawRefresh);
      await sql`
        UPDATE "refresh_tokens" SET "revoked_at" = NOW() WHERE "token_hash" = ${refreshHash}
      `;
    }

    const cookies: CookieToSet[] = [
      { name: SESSION_COOKIE_NAME, value: '', options: getClearedCookieOptions('/') },
      { name: REFRESH_COOKIE_NAME, value: '', options: getClearedCookieOptions('/v1/auth') },
      { name: CSRF_COOKIE_NAME, value: '', options: getClearedCookieOptions('/') },
    ];

    return {
      success: true,
      data: { message: 'Successfully logged out' },
      cookies,
    };
  });

  router.get('/v1/auth/session', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const profile = await authService.getMe(userId);

    let csrfToken = req.cookies[CSRF_COOKIE_NAME];
    const cookies: CookieToSet[] = [];
    if (!csrfToken) {
      csrfToken = generateCsrfToken();
      cookies.push({ name: CSRF_COOKIE_NAME, value: csrfToken, options: getCsrfCookieOptions() });
    }

    return {
      success: true,
      data: {
        user: profile.user,
        organizations: profile.organizations,
        organizationId: req.context.organizationId,
        role: req.context.role,
        authType: req.context.authType,
        csrfToken,
      },
      cookies: cookies.length > 0 ? cookies : undefined,
    };
  });

  router.post('/v1/auth/verify-email', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = (req.body.userId as string) || '';
    if (!userId) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'userId is required');
    }
    await authService.verifyEmail(userId);
    return {
      success: true,
      data: { message: 'Email address verified successfully' },
    };
  });

  router.get('/v1/auth/me', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const profile = await authService.getMe(userId);
    return {
      success: true,
      data: profile,
    };
  });
}
