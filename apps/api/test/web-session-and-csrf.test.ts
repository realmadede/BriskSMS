import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
  verifyCsrfToken,
  getCsrfSecret,
  isAllowedOrigin,
  getAllowedOrigins,
} from '../src/core/cookies.js';
import { signJwt } from '../src/core/crypto.js';
import { randomBytes } from 'node:crypto';

describe('Web Console Session Security & CSRF Protection', () => {
  const router = createApp();
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    await dbStore.reset();

    const reg = await authService.register({
      email: 'merchant@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Merchant Security Admin',
      organizationName: 'Secure Retailers Ltd',
    });

    orgId = reg.organizationId!;
    userId = reg.user.id;
  });

  interface HttpResponse {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    setCookies: string[];
    json: any;
  }

  async function makeRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<HttpResponse> {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = path;

    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    const res = new ServerResponse(req);
    let capturedBody = '';
    let statusCode = 200;

    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.end = (chunk: any) => {
      if (chunk) capturedBody += chunk.toString();
      return res;
    };

    if (body) {
      req.push(JSON.stringify(body));
    }
    req.push(null);

    await router.handle(req, res);

    const rawSetCookie = res.getHeader('set-cookie');
    const setCookies: string[] = Array.isArray(rawSetCookie)
      ? (rawSetCookie as string[])
      : rawSetCookie
        ? [String(rawSetCookie)]
        : [];

    let parsed: any = null;
    try {
      parsed = capturedBody ? JSON.parse(capturedBody) : null;
    } catch {
      parsed = capturedBody;
    }

    return {
      statusCode,
      headers: res.getHeaders() as Record<string, string | string[] | undefined>,
      setCookies,
      json: parsed,
    };
  }

  function extractCookie(setCookies: string[], name: string): string | undefined {
    const prefix = `${name}=`;
    const found = setCookies.find((c) => c.startsWith(prefix));
    if (!found) return undefined;
    return found.split(';')[0]?.slice(prefix.length);
  }

  describe('1. Cookie Security Attributes', () => {
    it('sets HttpOnly, SameSite=Lax, and narrow Path on bsk_session upon login', async () => {
      const res = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.setCookies.length >= 3);

      const sessionCookieStr = res.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      assert.ok(sessionCookieStr, 'bsk_session cookie must be set');
      assert.ok(sessionCookieStr.includes('HttpOnly'), 'Session cookie must be HttpOnly');
      assert.ok(sessionCookieStr.includes('SameSite=Lax'), 'Session cookie must be SameSite=Lax');
      assert.ok(sessionCookieStr.includes('Path=/'), 'Session cookie path must be /');
      assert.ok(sessionCookieStr.includes('Max-Age=900'), 'Session cookie must expire in 900s');

      const refreshCookieStr = res.setCookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
      assert.ok(refreshCookieStr, 'bsk_refresh cookie must be set');
      assert.ok(refreshCookieStr.includes('HttpOnly'), 'Refresh cookie must be HttpOnly');
      assert.ok(refreshCookieStr.includes('SameSite=Strict'), 'Refresh cookie must be SameSite=Strict');
      assert.ok(refreshCookieStr.includes('Path=/v1/auth'), 'Refresh cookie must be scoped to /v1/auth');

      const csrfCookieStr = res.setCookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
      assert.ok(csrfCookieStr, 'bsk_csrf cookie must be set');
      assert.ok(!csrfCookieStr.includes('HttpOnly'), 'CSRF cookie must be readable by JS');
      assert.ok(csrfCookieStr.includes('SameSite=Lax'));
    });

    it('sets Secure attribute on all cookies in production mode', async () => {
      const prevEnv = process.env.NODE_ENV;
      const prevMasterKey = process.env.ENCRYPTION_MASTER_KEY;
      const prevCsrfSecret = process.env.CSRF_SECRET;

      process.env.NODE_ENV = 'production';
      process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('hex');
      process.env.CSRF_SECRET = randomBytes(32).toString('hex');

      try {
        const res = await makeRequest('POST', '/v1/auth/login', {}, {
          email: 'merchant@brisksms.co.tz',
          password: 'SecurePassword123!',
        });

        assert.equal(res.statusCode, 200);
        for (const cookieStr of res.setCookies) {
          assert.ok(cookieStr.includes('Secure'), `Cookie must include Secure in production: ${cookieStr}`);
        }
      } finally {
        process.env.NODE_ENV = prevEnv;
        process.env.ENCRYPTION_MASTER_KEY = prevMasterKey;
        process.env.CSRF_SECRET = prevCsrfSecret;
      }
    });

    it('clears all session cookies on logout with Max-Age=0', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);
      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME);
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME);

      const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionCookie}; ${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`;

      const logoutRes = await makeRequest('POST', '/v1/auth/logout', {
        cookie: cookieHeader,
        'x-csrf-token': csrfCookie!,
      });

      assert.equal(logoutRes.statusCode, 200);
      assert.equal(logoutRes.json.data.message, 'Successfully logged out');

      for (const clearedStr of logoutRes.setCookies) {
        assert.ok(clearedStr.includes('Max-Age=0'), `Logout cookie must have Max-Age=0: ${clearedStr}`);
      }
    });
  });

  describe('2. Session Lifecycle & Invalidation', () => {
    it('authenticates GET /v1/auth/session using valid HttpOnly bsk_session cookie', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);
      const res = await makeRequest('GET', '/v1/auth/session', {
        cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json.data.user.email, 'merchant@brisksms.co.tz');
      assert.equal(res.json.data.authType, 'cookie');
    });

    it('rejects expired bsk_session cookie with 401 UNAUTHORIZED', async () => {
      const expiredJwt = signJwt(
        { sub: userId, email: 'merchant@brisksms.co.tz', organizationId: orgId, role: 'OWNER' },
        -10, // Expired 10 seconds ago
      );

      const res = await makeRequest('GET', '/v1/auth/session', {
        cookie: `${SESSION_COOKIE_NAME}=${expiredJwt}`,
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error.code, 'UNAUTHORIZED');
    });

    it('rejects revoked bsk_session token after logout with 401 TOKEN_REVOKED', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME);

      // Perform logout
      await makeRequest('POST', '/v1/auth/logout', {
        cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
        'x-csrf-token': csrfCookie!,
      });

      // Attempt to reuse revoked session
      const reuseRes = await makeRequest('GET', '/v1/auth/session', {
        cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
      });

      assert.equal(reuseRes.statusCode, 401);
      assert.equal(reuseRes.json.error.code, 'TOKEN_REVOKED');
    });

    it('rotates refresh token and issues fresh cookies upon /v1/auth/refresh', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME);
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME);

      const refreshRes = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie!,
        },
        {},
      );

      assert.equal(refreshRes.statusCode, 200);
      const newSessionCookie = extractCookie(refreshRes.setCookies, SESSION_COOKIE_NAME);
      const newRefreshCookie = extractCookie(refreshRes.setCookies, REFRESH_COOKIE_NAME);

      assert.ok(newSessionCookie);
      assert.ok(newRefreshCookie);
      assert.notEqual(newRefreshCookie, refreshCookie, 'Refresh token must be rotated');

      // Attempt replay of old refresh token must fail
      const replayRes = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie!,
        },
        {},
      );

      assert.equal(replayRes.statusCode, 401);
      assert.equal(replayRes.json.error.code, 'INVALID_TOKEN');
    });
  });

  describe('3. CSRF Protection for State-Changing Operations', () => {
    it('rejects state-changing POST when X-CSRF-Token header is missing', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME);

      // Attempt state-changing invoice issuance without X-CSRF-Token header
      const postRes = await makeRequest(
        'POST',
        '/v1/reconciliation/invoices',
        {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
        },
        {
          organizationId: orgId,
          reference: 'INV-CSRF-TEST-1',
          totalAmount: '50000',
        },
      );

      assert.equal(postRes.statusCode, 403);
      assert.equal(postRes.json.error.code, 'CSRF_TOKEN_MISSING');
    });

    it('rejects state-changing POST when X-CSRF-Token does not match bsk_csrf cookie', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME);

      const postRes = await makeRequest(
        'POST',
        '/v1/reconciliation/invoices',
        {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': 'attacker_forged_csrf_token_123',
        },
        {
          organizationId: orgId,
          reference: 'INV-CSRF-TEST-2',
          totalAmount: '50000',
        },
      );

      assert.equal(postRes.statusCode, 403);
      assert.equal(postRes.json.error.code, 'CSRF_TOKEN_INVALID');
    });

    it('rejects request when Origin header is from an untrusted domain', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME);

      const postRes = await makeRequest(
        'POST',
        '/v1/reconciliation/invoices',
        {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie!,
          origin: 'https://evil-hacker-site.com',
        },
        {
          organizationId: orgId,
          reference: 'INV-CSRF-TEST-3',
          totalAmount: '50000',
        },
      );

      assert.equal(postRes.statusCode, 403);
      assert.equal(postRes.json.error.code, 'CSRF_ORIGIN_MISMATCH');
    });

    it('accepts state-changing POST when valid CSRF token, cookie, and trusted origin are provided', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME);

      const postRes = await makeRequest(
        'POST',
        '/v1/reconciliation/invoices',
        {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie!,
          origin: 'http://localhost:4200',
        },
        {
          organizationId: orgId,
          referenceNumber: 'INV-CSRF-SUCCESS-1',
          totalAmountCents: 75000,
        },
      );

      assert.equal(postRes.statusCode, 201);
      assert.equal(postRes.json.data.invoice.referenceNumber, 'INV-CSRF-SUCCESS-1');
    });

    it('allows safe GET requests to read data without requiring X-CSRF-Token header', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);

      // Safe GET request
      const getRes = await makeRequest('GET', `/v1/reconciliation/invoices?organizationId=${orgId}`, {
        cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
      });

      assert.equal(getRes.statusCode, 200);
      assert.ok(Array.isArray(getRes.json.data.invoices));
    });
  });

  describe('4. Authentication Boundary Isolation', () => {
    it('prevents browser cookie session from authenticating device ingestion endpoint', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });

      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME);

      // Device ingestion endpoint requires device Bearer token (bsk_dev_...)
      const res = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        {
          cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        },
        {
          rawPayload: 'sample mpesa evidence',
          provider: 'MPESA',
        },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error.code, 'UNAUTHORIZED');
    });

    it('preserves non-browser Bearer token API authentication without requiring cookies or CSRF', async () => {
      const reg = await authService.register({
        email: 'api-client@example.com',
        password: 'Password123!',
        fullName: 'API Client User',
        organizationName: 'API Client Org',
      });

      // Call API using Bearer token with zero cookies and zero CSRF headers
      const res = await makeRequest(
        'POST',
        '/v1/reconciliation/invoices',
        {
          authorization: `Bearer ${reg.tokens.accessToken}`,
        },
        {
          organizationId: reg.organizationId!,
          referenceNumber: 'INV-BEARER-TEST-1',
          totalAmountCents: 120000,
        },
      );

      assert.equal(res.statusCode, 201);
      assert.equal(res.json.data.invoice.referenceNumber, 'INV-BEARER-TEST-1');
    });
  });

  describe('5. Login & Registration Cross-Site & Origin Protection', () => {
    it('rejects cross-site login when Origin is from an untrusted domain with 403 CSRF_ORIGIN_MISMATCH', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/login',
        {
          origin: 'https://evil-attacker.com',
        },
        {
          email: 'merchant@brisksms.co.tz',
          password: 'SecurePassword123!',
        },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_ORIGIN_MISMATCH');
    });

    it('rejects cross-site login when Sec-Fetch-Site is cross-site with 403 CSRF_CROSS_SITE_FORBIDDEN', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/login',
        {
          'sec-fetch-site': 'cross-site',
        },
        {
          email: 'merchant@brisksms.co.tz',
          password: 'SecurePassword123!',
        },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_CROSS_SITE_FORBIDDEN');
    });

    it('rejects cross-site registration when Origin is from an untrusted domain with 403 CSRF_ORIGIN_MISMATCH', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/register',
        {
          origin: 'https://attacker-origin.com',
        },
        {
          email: 'attacker_user@example.com',
          password: 'Password123!',
          fullName: 'Attacker User',
        },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_ORIGIN_MISMATCH');
    });

    it('rejects cross-site registration when Sec-Fetch-Site is cross-site with 403 CSRF_CROSS_SITE_FORBIDDEN', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/register',
        {
          'sec-fetch-site': 'cross-site',
        },
        {
          email: 'attacker_user2@example.com',
          password: 'Password123!',
          fullName: 'Attacker User',
        },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_CROSS_SITE_FORBIDDEN');
    });

    it('accepts login from authorized origin when valid CSRF token is provided', async () => {
      const csrfRes = await makeRequest('GET', '/v1/auth/csrf');
      const csrfCookie = extractCookie(csrfRes.setCookies, CSRF_COOKIE_NAME)!;

      const res = await makeRequest(
        'POST',
        '/v1/auth/login',
        {
          origin: 'http://localhost:4200',
          cookie: `${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie,
        },
        {
          email: 'merchant@brisksms.co.tz',
          password: 'SecurePassword123!',
        },
      );

      assert.equal(res.statusCode, 200);
      assert.ok(extractCookie(res.setCookies, SESSION_COOKIE_NAME));
      assert.ok(extractCookie(res.setCookies, REFRESH_COOKIE_NAME));
    });
  });

  describe('6. Refresh Endpoint CSRF, Rotation & Concurrency Safety', () => {
    it('rejects cross-site refresh when Origin is from an untrusted domain with 403 CSRF_ORIGIN_MISMATCH', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      const res = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          origin: 'https://evil-refresh-attacker.com',
          cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie,
        },
        {},
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_ORIGIN_MISMATCH');
    });

    it('rejects cross-site refresh when Sec-Fetch-Site is cross-site with 403 CSRF_CROSS_SITE_FORBIDDEN', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      const res = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          'sec-fetch-site': 'cross-site',
          cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie,
        },
        {},
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_CROSS_SITE_FORBIDDEN');
    });

    it('rejects cookie refresh when X-CSRF-Token header is missing', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      const res = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          origin: 'http://localhost:4200',
        },
        {},
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_TOKEN_MISSING');
    });

    it('rejects cookie refresh when X-CSRF-Token is invalid or mismatched', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      const res = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': 'wrong-or-tampered-csrf-token-value',
          origin: 'http://localhost:4200',
        },
        {},
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_TOKEN_INVALID');
    });

    it('rotates refresh token and invalidates old token upon successful refresh', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const oldRefreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      const refreshRes = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          cookie: `${REFRESH_COOKIE_NAME}=${oldRefreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie,
          origin: 'http://localhost:4200',
        },
        {},
      );

      assert.equal(refreshRes.statusCode, 200);
      const newRefreshCookie = extractCookie(refreshRes.setCookies, REFRESH_COOKIE_NAME)!;
      assert.ok(newRefreshCookie);
      assert.notEqual(newRefreshCookie, oldRefreshCookie);
    });

    it('strictly rejects reuse/replay of old revoked refresh token with 401 INVALID_TOKEN', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const oldRefreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      // 1. First refresh consumes the token
      const res1 = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          cookie: `${REFRESH_COOKIE_NAME}=${oldRefreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie,
          origin: 'http://localhost:4200',
        },
        {},
      );
      assert.equal(res1.statusCode, 200);

      // 2. Replay attempt using the consumed old token must fail
      const res2 = await makeRequest(
        'POST',
        '/v1/auth/refresh',
        {
          cookie: `${REFRESH_COOKIE_NAME}=${oldRefreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
          'x-csrf-token': csrfCookie,
          origin: 'http://localhost:4200',
        },
        {},
      );
      assert.equal(res2.statusCode, 401);
      assert.equal(res2.json.error.code, 'INVALID_TOKEN');
    });

    it('prevents race condition: concurrent refresh requests cannot create multiple valid refresh branches', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      const req1 = makeRequest('POST', '/v1/auth/refresh', {
        cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
        'x-csrf-token': csrfCookie,
        origin: 'http://localhost:4200',
      }, {});

      const req2 = makeRequest('POST', '/v1/auth/refresh', {
        cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
        'x-csrf-token': csrfCookie,
        origin: 'http://localhost:4200',
      }, {});

      const [res1, res2] = await Promise.all([req1, req2]);
      const codes = [res1.statusCode, res2.statusCode].sort();

      // Exactly one succeeds and one is rejected due to transaction lock
      assert.deepEqual(codes, [200, 401]);
    });
  });

  describe('7. CSRF Cryptographic Security & Malformed Token Defense', () => {
    it('rejects expired CSRF token', () => {
      const nonce = 'a'.repeat(48);
      const expiredTime = Date.now() - 10000; // 10s in the past
      const payload = `${nonce}.${expiredTime}`;
      const sig = require('node:crypto').createHmac('sha256', getCsrfSecret()).update(payload).digest('hex');
      const expiredToken = `${payload}.${sig}`;

      assert.equal(verifyCsrfToken(expiredToken, expiredToken), false);
    });

    it('rejects tampered CSRF token where signature does not match payload', () => {
      const validToken = generateCsrfToken();
      const parts = validToken.split('.');
      const sigPart = parts[2]!;
      // Tamper signature by changing last character
      const tamperedSig = sigPart.slice(0, -1) + (sigPart.endsWith('0') ? '1' : '0');
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

      assert.equal(verifyCsrfToken(tamperedToken, tamperedToken), false);
    });

    it('rejects malformed CSRF token with invalid separators, non-hex nonce, or invalid timestamp', () => {
      assert.equal(verifyCsrfToken('malformed-token-without-dots', 'malformed-token-without-dots'), false);
      assert.equal(verifyCsrfToken('a.b', 'a.b'), false);
      assert.equal(verifyCsrfToken('a.b.c.d', 'a.b.c.d'), false);
      assert.equal(verifyCsrfToken('nonhexnonce.12345.sig', 'nonhexnonce.12345.sig'), false);
      assert.equal(verifyCsrfToken(`${'a'.repeat(48)}.notanumber.${'b'.repeat(64)}`, `${'a'.repeat(48)}.notanumber.${'b'.repeat(64)}`), false);
      assert.equal(verifyCsrfToken(`${'a'.repeat(48)}.-500.${'b'.repeat(64)}`, `${'a'.repeat(48)}.-500.${'b'.repeat(64)}`), false);
    });

    it('rejects oversized CSRF tokens exceeding 512 bytes', () => {
      const hugeToken = 'a'.repeat(1000);
      assert.equal(verifyCsrfToken(hugeToken, hugeToken), false);
    });

    it('enforces independent CSRF_SECRET in production and refuses to reuse JWT or encryption keys', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevCsrf = process.env.CSRF_SECRET;
      const prevJwt = process.env.JWT_ACCESS_SECRET;
      const prevEnc = process.env.ENCRYPTION_MASTER_KEY;

      try {
        process.env.NODE_ENV = 'production';
        process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
        process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('hex');

        // 1. Missing CSRF_SECRET fails closed
        delete process.env.CSRF_SECRET;
        assert.throws(() => getCsrfSecret(), /FATAL: CSRF_SECRET is required/);

        // 2. Short CSRF_SECRET fails closed
        process.env.CSRF_SECRET = 'too_short';
        assert.throws(() => getCsrfSecret(), /FATAL: Insecure or insufficient-entropy CSRF_SECRET/);

        // 3. Reusing JWT_ACCESS_SECRET fails closed
        process.env.CSRF_SECRET = process.env.JWT_ACCESS_SECRET;
        assert.throws(() => getCsrfSecret(), /FATAL: CSRF_SECRET must be independently configured and not reuse JWT_ACCESS_SECRET/);

        // 4. Reusing ENCRYPTION_MASTER_KEY fails closed
        process.env.CSRF_SECRET = process.env.ENCRYPTION_MASTER_KEY;
        assert.throws(() => getCsrfSecret(), /FATAL: CSRF_SECRET must be independently configured and not reuse ENCRYPTION_MASTER_KEY/);

        // 5. Independently configured secure key passes
        const independentSecret = randomBytes(32).toString('hex');
        process.env.CSRF_SECRET = independentSecret;
        assert.equal(getCsrfSecret(), independentSecret);
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevCsrf !== undefined) process.env.CSRF_SECRET = prevCsrf; else delete process.env.CSRF_SECRET;
        if (prevJwt !== undefined) process.env.JWT_ACCESS_SECRET = prevJwt; else delete process.env.JWT_ACCESS_SECRET;
        if (prevEnc !== undefined) process.env.ENCRYPTION_MASTER_KEY = prevEnc; else delete process.env.ENCRYPTION_MASTER_KEY;
      }
    });
  });

  describe('8. Production Origin, Deceptive Hostnames & CORS Security', () => {
    it('rejects deceptive origin suffix attacks (e.g. localhost:4200.evil.com)', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/login',
        {
          origin: 'http://localhost:4200.evil.com',
        },
        {
          email: 'merchant@brisksms.co.tz',
          password: 'SecurePassword123!',
        },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_ORIGIN_MISMATCH');
    });

    it('rejects deceptive origin subdomain attacks (e.g. evil-console.brisksms.co.tz)', () => {
      const prevEnv = process.env.FRONTEND_URL;
      try {
        process.env.FRONTEND_URL = 'https://console.brisksms.co.tz';
        assert.equal(isAllowedOrigin('https://evil-console.brisksms.co.tz'), false);
        assert.equal(isAllowedOrigin('https://console.brisksms.co.tz.attacker.org'), false);
        assert.equal(isAllowedOrigin('https://console.brisksms.co.tz'), true);
      } finally {
        if (prevEnv) process.env.FRONTEND_URL = prevEnv; else delete process.env.FRONTEND_URL;
      }
    });

    it('rejects null origin from sandboxed iframes or local files', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/login',
        {
          origin: 'null',
        },
        {
          email: 'merchant@brisksms.co.tz',
          password: 'SecurePassword123!',
        },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'CSRF_ORIGIN_MISMATCH');
    });

    it('rejects localhost/127.0.0.1 in production mode unless explicitly configured in ALLOWED_ORIGINS', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevAllowed = process.env.ALLOWED_ORIGINS;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.ALLOWED_ORIGINS;
        delete process.env.FRONTEND_URL;
        delete process.env.CORS_ORIGIN;

        assert.equal(isAllowedOrigin('http://localhost:4200'), false);
        assert.equal(isAllowedOrigin('http://127.0.0.1:4200'), false);

        process.env.ALLOWED_ORIGINS = 'https://console.brisksms.co.tz';
        assert.equal(isAllowedOrigin('https://console.brisksms.co.tz'), true);
        assert.equal(isAllowedOrigin('http://localhost:4200'), false);
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevAllowed) process.env.ALLOWED_ORIGINS = prevAllowed; else delete process.env.ALLOWED_ORIGINS;
      }
    });

    it('rejects wildcard "*" in CORS_ORIGIN from being accepted as an authorized origin', () => {
      const prevCors = process.env.CORS_ORIGIN;
      try {
        process.env.CORS_ORIGIN = '*';
        const allowed = getAllowedOrigins();
        assert.equal(allowed.has('*'), false);
        assert.equal(isAllowedOrigin('*'), false);
      } finally {
        if (prevCors) process.env.CORS_ORIGIN = prevCors; else delete process.env.CORS_ORIGIN;
      }
    });

    it('preflight OPTIONS with untrusted origin does NOT set Access-Control-Allow-Origin or Credentials', async () => {
      const res = await makeRequest('OPTIONS', '/v1/auth/login', {
        origin: 'https://evil-untrusted-site.com',
      });

      assert.equal(res.statusCode, 204);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
      assert.equal(res.headers['vary'], 'Origin');
    });

    it('preflight OPTIONS with authorized origin sets Allow-Origin, Allow-Credentials, and Vary: Origin', async () => {
      const res = await makeRequest('OPTIONS', '/v1/auth/login', {
        origin: 'http://localhost:4200',
      });

      assert.equal(res.statusCode, 204);
      assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:4200');
      assert.equal(res.headers['access-control-allow-credentials'], 'true');
      assert.equal(res.headers['vary'], 'Origin');
    });
  });

  describe('9. Cache-Control Security Headers on Sensitive Endpoints', () => {
    it('sets Cache-Control: no-store and related headers on GET /v1/auth/csrf', async () => {
      const res = await makeRequest('GET', '/v1/auth/csrf');
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
      assert.equal(res.headers['pragma'], 'no-cache');
      assert.equal(res.headers['expires'], '0');
    });

    it('sets Cache-Control: no-store on POST /v1/auth/login', async () => {
      const res = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
      assert.equal(res.headers['pragma'], 'no-cache');
      assert.equal(res.headers['expires'], '0');
    });

    it('sets Cache-Control: no-store on GET /v1/auth/session', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const sessionCookie = extractCookie(loginRes.setCookies, SESSION_COOKIE_NAME)!;

      const res = await makeRequest('GET', '/v1/auth/session', {
        cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
    });

    it('sets Cache-Control: no-store on POST /v1/auth/refresh', async () => {
      const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
        email: 'merchant@brisksms.co.tz',
        password: 'SecurePassword123!',
      });
      const refreshCookie = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
      const csrfCookie = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;

      const res = await makeRequest('POST', '/v1/auth/refresh', {
        cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}; ${CSRF_COOKIE_NAME}=${csrfCookie}`,
        'x-csrf-token': csrfCookie,
        origin: 'http://localhost:4200',
      }, {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate');
    });
  });
});
