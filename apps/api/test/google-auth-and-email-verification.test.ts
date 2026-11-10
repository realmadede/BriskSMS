import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { MockGoogleTokenVerifier, DefaultGoogleTokenVerifier } from '../src/modules/auth/providers/google.provider.js';
import { MockEmailProvider, ResendEmailProvider } from '../src/modules/auth/providers/resend.provider.js';
import { EmailService } from '../src/modules/auth/services/email.service.js';
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from '../src/core/cookies.js';
import { sql } from '@brisksms/db';

describe('Google Sign-In & Resend Email Verification Security Suite', () => {
  const router = createApp();
  const mockGoogle = new MockGoogleTokenVerifier();
  const mockEmail = new MockEmailProvider();
  const customEmailService = new EmailService(mockEmail);

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

    if (body !== undefined) {
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

  function extractTokenFromSentEmail(index: number = 0): string {
    const sent = mockEmail.sentEmails[index];
    if (!sent?.text) throw new Error(`Expected sent email at index ${index} with text`);
    const match = sent.text.match(/token=(bsk_ev_[a-zA-Z0-9_-]+)/);
    if (!match || !match[1]) throw new Error(`No token match found in email text: ${sent.text}`);
    return match[1];
  }

  beforeEach(async () => {
    await dbStore.reset();
    mockGoogle.clear();
    mockEmail.clear();
    authService.setGoogleVerifier(mockGoogle);
    authService.setEmailService(customEmailService);
    authService.clearRateLimits();
    process.env.GOOGLE_CLIENT_ID = 'test-client-id-brisksms.apps.googleusercontent.com';
    process.env.RESEND_API_KEY = 're_test_mock_api_key_12345';
  });

  afterEach(() => {
    mockGoogle.clear();
    mockEmail.clear();
    authService.clearRateLimits();
  });

  // ==========================================
  // SECTION 1: GOOGLE SIGN-IN & SSO TESTS
  // ==========================================
  describe('1. Google Identity Sign-In (POST /v1/auth/google)', () => {
    it('provisions a new user with verified email, default workspace, and HttpOnly session cookies', async () => {
      const idToken = 'valid.google.token.user1';
      mockGoogle.registerToken(idToken, {
        iss: 'https://accounts.google.com',
        sub: 'google_sub_1001',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'merchant.john@example.com',
        email_verified: true,
        name: 'John Merchant',
        picture: 'https://lh3.googleusercontent.com/a/avatar123',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.user.email, 'merchant.john@example.com');
      assert.equal(res.json.data.user.fullName, 'John Merchant');
      assert.equal(res.json.data.user.isEmailVerified, true);
      assert.equal(res.json.data.user.authProvider, 'GOOGLE');
      assert.equal(res.json.data.user.avatarUrl, 'https://lh3.googleusercontent.com/a/avatar123');
      assert.ok(res.json.data.tokens.accessToken);
      assert.ok(res.json.data.csrfToken);

      // Verify HttpOnly cookies set
      const sessionCookie = extractCookie(res.setCookies, SESSION_COOKIE_NAME);
      const refreshCookie = extractCookie(res.setCookies, REFRESH_COOKIE_NAME);
      const csrfCookie = extractCookie(res.setCookies, CSRF_COOKIE_NAME);

      assert.ok(sessionCookie, 'Session cookie must be set');
      assert.ok(refreshCookie, 'Refresh cookie must be set');
      assert.ok(csrfCookie, 'CSRF cookie must be set');

      // Verify database record
      const dbUser = await dbStore.findUserByGoogleId('google_sub_1001');
      assert.ok(dbUser);
      assert.equal(dbUser?.email, 'merchant.john@example.com');
      assert.equal(dbUser?.passwordHash, undefined);
      assert.equal(dbUser?.isEmailVerified, true);

      // Verify default workspace created
      const orgs = await dbStore.getUserOrganizations(dbUser.id);
      assert.equal(orgs.length, 1);
      assert.equal(orgs[0]?.role, 'OWNER');
      assert.ok(orgs[0]?.org.name.includes('John Merchant'));
    });

    it('supports standard Google Identity credential field in payload', async () => {
      const idToken = 'valid.google.token.cred_field';
      mockGoogle.registerToken(idToken, {
        iss: 'https://accounts.google.com',
        sub: 'google_sub_1002',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'cred.user@example.com',
        email_verified: true,
        name: 'Credential User',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { credential: idToken },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.user.email, 'cred.user@example.com');
    });

    it('rejects invalid or forged token signature with 401 INVALID_GOOGLE_TOKEN', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken: 'forged.signature.token' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json.success, false);
      assert.equal(res.json.error.code, 'INVALID_GOOGLE_TOKEN');
    });

    it('rejects expired Google token with 401 INVALID_GOOGLE_TOKEN', async () => {
      const expiredToken = 'expired.google.token';
      mockGoogle.registerToken(expiredToken, {
        iss: 'accounts.google.com',
        sub: 'google_sub_expired',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'expired@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) - 100, // Expired 100s ago
      });

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken: expiredToken },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error.code, 'INVALID_GOOGLE_TOKEN');
      assert.ok(res.json.error.message.includes('expired'));
    });

    it('rejects audience mismatch with 401 INVALID_GOOGLE_TOKEN', async () => {
      const mismatchAudToken = 'aud.mismatch.token';
      mockGoogle.registerToken(mismatchAudToken, {
        iss: 'accounts.google.com',
        sub: 'google_sub_aud',
        aud: 'wrong-client-id.apps.googleusercontent.com',
        email: 'aud@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken: mismatchAudToken },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error.code, 'INVALID_GOOGLE_TOKEN');
      assert.ok(res.json.error.message.includes('audience mismatch'));
    });

    it('rejects issuer mismatch with 401 INVALID_GOOGLE_TOKEN', async () => {
      const issuerToken = 'issuer.mismatch.token';
      mockGoogle.registerToken(issuerToken, {
        iss: 'https://evil-auth-provider.com',
        sub: 'google_sub_iss',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'iss@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken: issuerToken },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error.code, 'INVALID_GOOGLE_TOKEN');
      assert.ok(res.json.error.message.includes('Invalid Google token issuer'));
    });

    it('rejects unverified Google email with 400 GOOGLE_EMAIL_NOT_VERIFIED', async () => {
      const unverifiedToken = 'unverified.email.token';
      mockGoogle.registerToken(unverifiedToken, {
        iss: 'accounts.google.com',
        sub: 'google_sub_unverified',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'unverified@example.com',
        email_verified: false,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken: unverifiedToken },
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.json.error.code, 'GOOGLE_EMAIL_NOT_VERIFIED');
    });

    it('safely links existing email/password account when Google email matches and is verified', async () => {
      // 1. Create email/password user
      const existing = await authService.register({
        email: 'merchant.link@business.co.tz',
        password: 'Password123!',
        fullName: 'Existing Merchant',
        organizationName: 'Existing Org',
      });
      assert.equal(existing.user.isEmailVerified, false);

      // 2. Log in with Google matching the same email
      const linkToken = 'valid.google.token.link';
      mockGoogle.registerToken(linkToken, {
        iss: 'accounts.google.com',
        sub: 'google_sub_link_999',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'merchant.link@business.co.tz',
        email_verified: true,
        name: 'Existing Merchant (Google)',
        picture: 'https://lh3.googleusercontent.com/avatar/linked.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken: linkToken },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json.data.user.id, existing.user.id);
      assert.equal(res.json.data.user.isEmailVerified, true);

      // Verify DB record has both passwordHash intact AND google_id set
      const dbUser = await dbStore.findUserById(existing.user.id);
      assert.ok(dbUser?.passwordHash?.startsWith('scrypt:'), 'Password hash must be preserved');
      assert.equal(dbUser?.googleId, 'google_sub_link_999');
      assert.equal(dbUser?.avatarUrl, 'https://lh3.googleusercontent.com/avatar/linked.png');
      assert.equal(dbUser?.isEmailVerified, true);
    });

    it('rejects suspended accounts with 403 ACCOUNT_DEACTIVATED', async () => {
      const suspendedToken = 'suspended.user.token';
      mockGoogle.registerToken(suspendedToken, {
        iss: 'accounts.google.com',
        sub: 'google_sub_suspended',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'suspended@business.co.tz',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      // Pre-create suspended user in DB
      const user = await dbStore.createUser({
        email: 'suspended@business.co.tz',
        fullName: 'Suspended Merchant',
        googleId: 'google_sub_suspended',
        authProvider: 'GOOGLE',
      });
      await sql`UPDATE "users" SET "is_active" = false WHERE "id" = ${user.id}`;

      const res = await makeRequest(
        'POST',
        '/v1/auth/google',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { idToken: suspendedToken },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, 'ACCOUNT_DEACTIVATED');
    });

    it('enforces IP rate limiting on rapid repeated Google login attempts', async () => {
      const dummyToken = 'rapid.token';
      mockGoogle.registerToken(dummyToken, {
        iss: 'accounts.google.com',
        sub: 'sub_dummy',
        aud: 'test-client-id-brisksms.apps.googleusercontent.com',
        email: 'dummy@example.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const clientIp = '198.51.100.42';

      // 10 allowed attempts
      for (let i = 0; i < 10; i++) {
        await authService.loginWithGoogle(dummyToken, clientIp);
      }

      // 11th attempt must be rejected with 429
      await assert.rejects(
        authService.loginWithGoogle(dummyToken, clientIp),
        (err: any) => {
          assert.equal(err.statusCode, 429);
          assert.equal(err.code, 'TOO_MANY_REQUESTS');
          return true;
        },
      );
    });
  });

  // ==========================================
  // SECTION 2: EMAIL VERIFICATION DISPATCH & TOKEN LIFECYCLE
  // ==========================================
  describe('2. Email Verification Token Lifecycle & Resend Delivery', () => {
    it('dispatches verification email with bsk_ev token on merchant registration', async () => {
      const regRes = await makeRequest(
        'POST',
        '/v1/auth/register',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        {
          email: 'newmerchant@company.co.tz',
          password: 'StrongPassword123!',
          fullName: 'Baraka Mushi',
          organizationName: 'Mushi Logistics',
        },
      );

      assert.equal(regRes.statusCode, 201);
      assert.equal(regRes.json.data.user.isEmailVerified, false);

      // Verify email was dispatched via EmailProvider
      assert.equal(mockEmail.sentEmails.length, 1);
      const sent = mockEmail.sentEmails[0]!;
      assert.equal(sent.to, 'newmerchant@company.co.tz');
      assert.ok(sent.subject.includes('Verify your email address'));
      assert.ok(sent.html?.includes('/verify-email?token=bsk_ev_'));
      assert.ok(sent.text?.includes('/verify-email?token=bsk_ev_'));

      const rawToken = extractTokenFromSentEmail(0);

      // Verify token exists in database and is unused
      const tokenRecord = await dbStore.findVerificationToken(rawToken);
      assert.ok(tokenRecord);
      assert.equal(tokenRecord?.userId, regRes.json.data.user.id);
      assert.equal(tokenRecord?.usedAt, null);
      assert.ok(new Date(tokenRecord!.expiresAt) > new Date());
    });

    it('successfully consumes token, marks user verified, and invalidates token atomically', async () => {
      // 1. Register user
      await makeRequest(
        'POST',
        '/v1/auth/register',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        {
          email: 'verify.target@company.co.tz',
          password: 'StrongPassword123!',
          fullName: 'Verify Target',
        },
      );

      const rawToken = extractTokenFromSentEmail(0);

      // 2. Consume token via POST /v1/auth/verify-email
      const verifyRes = await makeRequest(
        'POST',
        '/v1/auth/verify-email',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { token: rawToken },
      );

      assert.equal(verifyRes.statusCode, 200);
      assert.equal(verifyRes.json.success, true);
      assert.equal(verifyRes.json.data.verified, true);

      // Verify user in DB is marked verified
      const dbUser = await dbStore.findUserByEmail('verify.target@company.co.tz');
      assert.equal(dbUser?.isEmailVerified, true);

      // Verify token record in DB has used_at set
      const tokenRecord = await dbStore.findVerificationToken(rawToken);
      assert.ok(tokenRecord?.usedAt !== null);
    });

    it('enforces single-use token: rejects subsequent attempts with 400 INVALID_VERIFICATION_TOKEN', async () => {
      await makeRequest(
        'POST',
        '/v1/auth/register',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        {
          email: 'singleuse@company.co.tz',
          password: 'StrongPassword123!',
          fullName: 'Single Use',
        },
      );

      const rawToken = extractTokenFromSentEmail(0);

      // First verification: Success
      const firstRes = await makeRequest(
        'POST',
        '/v1/auth/verify-email',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { token: rawToken },
      );
      assert.equal(firstRes.statusCode, 200);

      // Second verification with same token: Rejected
      const secondRes = await makeRequest(
        'POST',
        '/v1/auth/verify-email',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { token: rawToken },
      );
      assert.equal(secondRes.statusCode, 400);
      assert.equal(secondRes.json.error.code, 'INVALID_VERIFICATION_TOKEN');
    });

    it('handles concurrent race condition: exactly one request succeeds under concurrency', async () => {
      await makeRequest(
        'POST',
        '/v1/auth/register',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        {
          email: 'race@company.co.tz',
          password: 'StrongPassword123!',
          fullName: 'Race Merchant',
        },
      );

      const rawToken = extractTokenFromSentEmail(0);

      // Fire 5 concurrent verify requests
      const promises = Array.from({ length: 5 }, () =>
        makeRequest(
          'POST',
          '/v1/auth/verify-email',
          { 'content-type': 'application/json', host: 'localhost:3000' },
          { token: rawToken },
        ),
      );

      const responses = await Promise.all(promises);
      const successCount = responses.filter((r) => r.statusCode === 200).length;
      const rejectCount = responses.filter((r) => r.statusCode === 400).length;

      assert.equal(successCount, 1, 'Exactly one concurrent request must succeed');
      assert.equal(rejectCount, 4, 'Remaining concurrent requests must be rejected');
    });

    it('rejects verification request with missing token or submitting userId alone', async () => {
      const res = await makeRequest(
        'POST',
        '/v1/auth/verify-email',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { userId: 'usr_arbitrary_attempt' },
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.json.error.code, 'INVALID_PAYLOAD');
    });

    it('rejects expired verification tokens with 400 INVALID_VERIFICATION_TOKEN', async () => {
      await makeRequest(
        'POST',
        '/v1/auth/register',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        {
          email: 'expired.token@company.co.tz',
          password: 'StrongPassword123!',
          fullName: 'Expired Token Merchant',
        },
      );

      const rawToken = extractTokenFromSentEmail(0);

      // Force token expiration in database
      await sql`
        UPDATE "email_verification_tokens"
        SET "expires_at" = NOW() - INTERVAL '1 hour'
      `;

      const res = await makeRequest(
        'POST',
        '/v1/auth/verify-email',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { token: rawToken },
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.json.error.code, 'INVALID_VERIFICATION_TOKEN');
    });
  });

  // ==========================================
  // SECTION 3: RESEND VERIFICATION & ENUMERATION DEFENSE
  // ==========================================
  describe('3. Non-Enumerating Resend & Rate Limiting (POST /v1/auth/resend-verification)', () => {
    it('dispatches a new token and revokes older tokens for valid unverified accounts', async () => {
      await makeRequest(
        'POST',
        '/v1/auth/register',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        {
          email: 'resend.user@company.co.tz',
          password: 'StrongPassword123!',
          fullName: 'Resend User',
        },
      );

      const initialToken = extractTokenFromSentEmail(0);
      assert.equal(mockEmail.sentEmails.length, 1);

      // Request resend
      const resendRes = await makeRequest(
        'POST',
        '/v1/auth/resend-verification',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { email: 'resend.user@company.co.tz' },
      );

      assert.equal(resendRes.statusCode, 200);
      assert.equal(resendRes.json.success, true);
      assert.equal(mockEmail.sentEmails.length, 2);

      const freshToken = extractTokenFromSentEmail(1);
      assert.notEqual(initialToken, freshToken, 'Fresh token must be generated');

      // Verify old token is now expired/revoked
      const oldTokenRecord = await dbStore.findVerificationToken(initialToken);
      assert.ok(new Date(oldTokenRecord!.expiresAt) <= new Date(), 'Prior token must be expired');

      // Verify fresh token is valid and active
      const freshTokenRecord = await dbStore.findVerificationToken(freshToken);
      assert.ok(new Date(freshTokenRecord!.expiresAt) > new Date(), 'Fresh token must be active');
    });

    it('returns generic success for nonexistent email without leaking account existence (Enumeration Defense)', async () => {
      mockEmail.clear();

      const res = await makeRequest(
        'POST',
        '/v1/auth/resend-verification',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { email: 'nonexistent-account@nowhere.com' },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json.success, true);
      assert.ok(res.json.data.message.includes('If an unverified account exists'));
      assert.equal(mockEmail.sentEmails.length, 0, 'No email should be dispatched for nonexistent account');
    });

    it('returns generic success without dispatching email for already-verified accounts', async () => {
      const reg = await authService.register({
        email: 'already.verified@company.co.tz',
        password: 'Password123!',
        fullName: 'Already Verified',
      });
      await authService.verifyEmail(reg.user.id);
      mockEmail.clear();

      const res = await makeRequest(
        'POST',
        '/v1/auth/resend-verification',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { email: 'already.verified@company.co.tz' },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json.success, true);
      assert.equal(mockEmail.sentEmails.length, 0, 'No email should be dispatched for already verified account');
    });

    it('enforces rate limit of 3 resends per 15 minutes', async () => {
      const email = 'ratelimit.resend@company.co.tz';
      await authService.register({
        email,
        password: 'Password123!',
        fullName: 'Rate Limited Resend',
      });

      // 3 allowed resends
      for (let i = 0; i < 3; i++) {
        const res = await makeRequest(
          'POST',
          '/v1/auth/resend-verification',
          { 'content-type': 'application/json', host: 'localhost:3000' },
          { email },
        );
        assert.equal(res.statusCode, 200);
      }

      // 4th attempt must be rejected with 429
      const fourthRes = await makeRequest(
        'POST',
        '/v1/auth/resend-verification',
        { 'content-type': 'application/json', host: 'localhost:3000' },
        { email },
      );

      assert.equal(fourthRes.statusCode, 429);
      assert.equal(fourthRes.json.error.code, 'TOO_MANY_REQUESTS');
    });
  });

  // ==========================================
  // SECTION 4: RESEND PROVIDER ERROR HANDLING & REDACTION
  // ==========================================
  describe('4. Resend Provider Error Handling & Security Redaction', () => {
    it('returns failure when RESEND_API_KEY is missing without throwing unhandled exceptions', async () => {
      const providerWithoutKey = new ResendEmailProvider('', 'noreply@brisksms.com');
      const result = await providerWithoutKey.sendEmail({
        to: 'target@example.com',
        subject: 'Test',
        text: 'Hello',
      });

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('RESEND_API_KEY is not configured'));
    });

    it('redacts sensitive API tokens or secrets in error messages', async () => {
      const provider = new ResendEmailProvider('re_1234567890abcdef1234567890abcdef');
      // Point to unrouteable port to test network error handling
      (provider as any).apiUrl = 'http://127.0.0.1:54321/emails';

      const result = await provider.sendEmail({
        to: 'target@example.com',
        subject: 'Redaction Test',
        text: 'Testing redaction',
      });

      assert.equal(result.success, false);
      assert.ok(!result.error?.includes('re_1234567890abcdef1234567890abcdef'), 'Secret API key must not leak');
    });
  });

  // ==========================================
  // SECTION 5: REAL RS256 CRYPTO VERIFICATION
  // ==========================================
  describe('5. Real RS256 JWT Cryptographic Signature Verification', () => {
    it('validates authentic RS256 signatures and detects tampering', async () => {
      // Generate RSA Keypair
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = publicKey.export({ format: 'jwk' });
      jwk.kid = 'test-key-id-001';
      jwk.alg = 'RS256';
      jwk.use = 'sig';

      const verifier = new DefaultGoogleTokenVerifier('test-client-id');
      // Inject test JWK
      (verifier as any).jwksCache = {
        keys: [jwk],
        expiresAt: Date.now() + 3600_000,
      };

      const header = { alg: 'RS256', kid: 'test-key-id-001', typ: 'JWT' };
      const payload = {
        iss: 'accounts.google.com',
        sub: 'google_rs256_sub_123',
        aud: 'test-client-id',
        email: 'rs256@example.com',
        email_verified: true,
        name: 'Crypto User',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signingInput = `${headerB64}.${payloadB64}`;

      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      const signatureB64 = signer.sign(privateKey, 'base64url');

      const authenticToken = `${signingInput}.${signatureB64}`;

      // 1. Authentic Token Verification
      const verified = await verifier.verifyIdToken(authenticToken);
      assert.equal(verified.sub, 'google_rs256_sub_123');
      assert.equal(verified.email, 'rs256@example.com');
      assert.equal(verified.email_verified, true);

      // 2. Tampered Payload Detection
      const tamperedPayload = { ...payload, email: 'hacker@attacker.com' };
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
      const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

      await assert.rejects(
        verifier.verifyIdToken(tamperedToken),
        /cryptographic signature verification failed/,
      );
    });
  });
});
