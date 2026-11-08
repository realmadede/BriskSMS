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
} from '../src/core/cookies.js';
import { signJwt } from '../src/core/crypto.js';

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
      process.env.ENCRYPTION_MASTER_KEY = 'production_super_secure_high_entropy_master_key_32_bytes_min!';
      process.env.CSRF_SECRET = 'production_super_secure_high_entropy_csrf_secret_32_bytes_min!';

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
});
