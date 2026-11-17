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
  GOOGLE_NONCE_COOKIE_NAME,
  getSessionCookieOptions,
  getRefreshCookieOptions,
  getCsrfCookieOptions,
  getGoogleNonceCookieOptions,
  getClearedCookieOptions,
  generateCsrfToken,
  isAllowedOrigin,
} from '../../core/cookies.js';

function extractClientIp(req: RouteRequest): string {
  const remoteIp = req.rawReq?.socket?.remoteAddress || '';
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const isProdOrStaging = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

  if (trustProxy || (!isProdOrStaging && !remoteIp)) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return remoteIp || 'unknown';
}

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
    // Origin & Fetch Metadata defense against cross-site registration
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site registration blocked by Fetch Metadata policy');
    }

    // If browser sent CSRF cookie or token, validate it
    if (
      req.cookies[SESSION_COOKIE_NAME] ||
      req.cookies[REFRESH_COOKIE_NAME] ||
      req.cookies[CSRF_COOKIE_NAME] ||
      req.headers['x-csrf-token']
    ) {
      validateCsrf(req);
    }

    // IP Rate Limit: max 10 registration requests per minute per IP
    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`register_${clientIp}`, 10, 60_000);
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
    // Origin & Fetch Metadata defense against Login CSRF
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site login blocked by Fetch Metadata policy');
    }

    // If browser sent session/refresh/CSRF cookie or token, enforce CSRF
    if (
      req.cookies[CSRF_COOKIE_NAME] ||
      req.headers['x-csrf-token']
    ) {
      validateCsrf(req);
    }

    const dto = req.body as unknown as LoginDto;
    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`login_ip_${clientIp}`, 20, 60_000);
    }
    if (dto?.email && typeof dto.email === 'string') {
      const emailHash = hashToken(`login:${dto.email.trim().toLowerCase()}`).slice(0, 32);
      await authService.checkRateLimit(`login_acct_${emailHash}`, 10, 60_000);
    }

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

  async function handleGoogleNonce(req: RouteRequest): Promise<ApiResponse> {
    // 1. Anti-prefetch defense against browser link prefetching or search preview
    const purpose = req.headers['purpose'] || req.headers['sec-purpose'];
    if (purpose === 'prefetch' || purpose === 'preview') {
      throw new HttpException(400, 'PREFETCH_FORBIDDEN', 'Nonce prefetching is strictly prohibited');
    }

    // 2. Anti-navigation defense: Nonce issuance must be a programmatic API call, never top-level document navigation
    if (req.headers['sec-fetch-mode'] === 'navigate') {
      throw new HttpException(403, 'NAVIGATION_FORBIDDEN', 'Top-level navigation to nonce endpoint is prohibited');
    }

    // 3. Origin & Fetch Metadata defense against cross-site nonce generation
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
    }

    // 4. Strict Referer check for requests without Origin (e.g. GET requests in certain user agents)
    if (!req.headers.origin && req.headers.referer) {
      try {
        const refOrigin = new URL(req.headers.referer as string).origin;
        if (!isAllowedOrigin(refOrigin)) {
          throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Referer origin '${refOrigin}' is not authorized`);
        }
      } catch (err) {
        if (err instanceof HttpException) throw err;
        throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', 'Malformed referer URL');
      }
    }

    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`google_nonce_${clientIp}`, 30, 60_000);
    }

    const result = await authService.createGoogleNonce(clientIp);

    const cookies: CookieToSet[] = [
      {
        name: GOOGLE_NONCE_COOKIE_NAME,
        value: result.nonceHash,
        options: getGoogleNonceCookieOptions(result.expiresIn),
      },
    ];

    return {
      success: true,
      data: {
        nonce: result.nonce,
        expiresIn: result.expiresIn,
      },
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
      cookies,
    };
  }

  router.post('/v1/auth/google/nonce', handleGoogleNonce);
  router.get('/v1/auth/google/nonce', handleGoogleNonce);

  router.post('/v1/auth/google', async (req: RouteRequest): Promise<ApiResponse> => {
    // Origin & Fetch Metadata defense against Login CSRF
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site login blocked by Fetch Metadata policy');
    }

    // If browser sent CSRF cookie or token, validate it
    if (
      req.cookies[SESSION_COOKIE_NAME] ||
      req.cookies[REFRESH_COOKIE_NAME] ||
      req.cookies[CSRF_COOKIE_NAME] ||
      req.headers['x-csrf-token']
    ) {
      validateCsrf(req);
    }

    const cookieNonceHash = req.cookies[GOOGLE_NONCE_COOKIE_NAME];
    if (!cookieNonceHash) {
      throw new HttpException(401, 'INVALID_GOOGLE_NONCE', 'Authentication nonce cookie missing from browser session');
    }

    const idToken = ((req.body.idToken || req.body.credential) as string) || '';
    const result = await authService.loginWithGoogle(idToken, extractClientIp(req), cookieNonceHash);
    const csrfToken = generateCsrfToken();

    const cookies: CookieToSet[] = [
      { name: SESSION_COOKIE_NAME, value: result.tokens.accessToken, options: getSessionCookieOptions() },
      { name: REFRESH_COOKIE_NAME, value: result.tokens.refreshToken, options: getRefreshCookieOptions() },
      { name: CSRF_COOKIE_NAME, value: csrfToken, options: getCsrfCookieOptions() },
      { name: GOOGLE_NONCE_COOKIE_NAME, value: '', options: getClearedCookieOptions('/v1/auth/google') },
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
    // Origin & Fetch Metadata defense against Cross-Site Refresh
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site refresh blocked by Fetch Metadata policy');
    }

    let token = (req.body.refreshToken as string) || '';
    const isCookieRefresh = !token && Boolean(req.cookies[REFRESH_COOKIE_NAME]);

    if (!token && isCookieRefresh) {
      token = req.cookies[REFRESH_COOKIE_NAME]!;
      validateCsrf(req);
    } else if (req.cookies[CSRF_COOKIE_NAME] || req.headers['x-csrf-token']) {
      validateCsrf(req);
    }

    if (!token) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Refresh token is required');
    }

    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`refresh_ip_${clientIp}`, 30, 60_000);
    }

    const tokens = await authService.refreshToken(token, req.tokenBlacklist);
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
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site logout blocked by Fetch Metadata policy');
    }
    if (
      req.cookies[SESSION_COOKIE_NAME] ||
      req.cookies[REFRESH_COOKIE_NAME] ||
      req.cookies[CSRF_COOKIE_NAME] ||
      req.headers['x-csrf-token']
    ) {
      validateCsrf(req);
    }

    try {
      await authenticate(req);
      if (req.context.jti) {
        await authService.revokeSession(req.context.jti, req.context.userId, req.tokenBlacklist);
      }
    } catch {
      // Allow clean logout even if session was expired
    }

    // Revoke refresh token and its entire session family in database if present in cookies or body
    const rawRefresh = req.cookies[REFRESH_COOKIE_NAME] || (req.body?.refreshToken as string);
    if (rawRefresh) {
      const refreshHash = hashToken(rawRefresh);
      const familyRows = await sql<{ family_id: string }>`
        SELECT "family_id" FROM "refresh_tokens" WHERE "token_hash" = ${refreshHash} LIMIT 1
      `;
      const familyId = familyRows[0]?.family_id;
      if (familyId) {
        await authService.revokeFamily(familyId, req.tokenBlacklist);
      }
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
    await authenticate(req);
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
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
    }

    // IP Rate Limit: max 30 verification attempts per minute per IP to prevent token guessing
    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`verify_ev_${clientIp}`, 30, 60_000);
    }

    const token = (req.body.token as string) || '';
    if (!token) {
      if (req.body.userId) {
        throw new HttpException(
          400,
          'INVALID_PAYLOAD',
          'Verification token is required. Verifying via userId alone is strictly prohibited.',
        );
      }
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Verification token is required');
    }

    const result = await authService.verifyEmailToken(token);
    return {
      success: true,
      data: {
        message: 'Email address verified successfully',
        userId: result.userId,
        verified: result.verified,
      },
    };
  });

  router.post('/v1/auth/resend-verification', async (req: RouteRequest): Promise<ApiResponse> => {
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
    }

    // Validate CSRF if cookie or header is present
    if (
      req.cookies[SESSION_COOKIE_NAME] ||
      req.cookies[REFRESH_COOKIE_NAME] ||
      req.cookies[CSRF_COOKIE_NAME] ||
      req.headers['x-csrf-token']
    ) {
      validateCsrf(req);
    }

    const email = (req.body.email as string) || '';
    if (!email) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email address is required');
    }

    const result = await authService.resendVerificationEmail(email, extractClientIp(req));
    return {
      success: true,
      data: result,
    };
  });

  router.post('/v1/auth/forgot-password', async (req: RouteRequest): Promise<ApiResponse> => {
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
    }
    if (
      req.cookies[SESSION_COOKIE_NAME] ||
      req.cookies[REFRESH_COOKIE_NAME] ||
      req.cookies[CSRF_COOKIE_NAME] ||
      req.headers['x-csrf-token']
    ) {
      validateCsrf(req);
    }

    const email = (req.body.email as string) || '';
    const result = await authService.forgotPassword(email, extractClientIp(req));
    return {
      success: true,
      data: result,
    };
  });

  router.post('/v1/auth/reset-password', async (req: RouteRequest): Promise<ApiResponse> => {
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
    }

    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`reset_pw_${clientIp}`, 15, 60_000);
    }

    const token = (req.body.token as string) || '';
    const newPassword = ((req.body.newPassword || req.body.password) as string) || '';
    const result = await authService.resetPassword(token, newPassword, req.tokenBlacklist);
    return {
      success: true,
      data: {
        message: 'Password reset successfully. Please sign in with your new password.',
        ...result,
      },
    };
  });

  router.post('/v1/auth/accept-invitation', async (req: RouteRequest): Promise<ApiResponse> => {
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin as string)) {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${req.headers.origin}' is not authorized`);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
    }

    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`accept_inv_${clientIp}`, 15, 60_000);
    }

    const result = await authService.acceptInvitation({
      token: (req.body.token as string) || '',
      password: req.body.password as string | undefined,
      fullName: req.body.fullName as string | undefined,
    });
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

  router.post('/v1/auth/switch-organization', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    if (req.context.authType === 'oauth') {
      throw new HttpException(403, 'OAUTH_FORBIDDEN', 'OAuth access tokens cannot switch active organizations');
    }
    const userId = req.context.userId!;
    const organizationId = (req.body.organizationId as string) || '';
    if (!organizationId) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'organizationId is required');
    }

    const result = await authService.switchOrganization(userId, organizationId);
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

  router.get('/v1/auth/me', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    const userId = req.context.userId!;
    const profile = await authService.getMe(userId);
    return {
      success: true,
      data: profile,
    };
  });
}
