import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { authService } from '../src/modules/auth/auth.service.js';
import { dbStore } from '../src/core/store.js';
import { verifyJwt } from '../src/core/crypto.js';

describe('Phase 1: AuthModule & Identity Lifecycle', () => {
  beforeEach(() => {
    dbStore.reset();
  });

  it('should successfully register a new user with hashed password and return access/refresh tokens', async () => {
    const result = await authService.register({
      email: 'finance@kilimanjaro-isp.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Amani Mtemi',
      organizationName: 'Kilimanjaro Networks',
    });

    assert.equal(result.user.email, 'finance@kilimanjaro-isp.co.tz');
    assert.equal(result.user.fullName, 'Amani Mtemi');
    assert.equal(result.user.isEmailVerified, false);
    assert.ok(result.organizationId);

    // Verify JWT payload
    const decoded = verifyJwt(result.tokens.accessToken);
    assert.ok(decoded);
    assert.equal(decoded?.sub, result.user.id);
    assert.equal(decoded?.organizationId, result.organizationId);
    assert.equal(decoded?.role, 'OWNER');

    // Verify password is not plaintext
    const storedUser = dbStore.findUserById(result.user.id);
    assert.ok(storedUser?.passwordHash.startsWith('scrypt:'));
    assert.ok(!storedUser?.passwordHash.includes('StrongPassword123!'));
  });

  it('should reject registration with weak passwords less than 8 characters', async () => {
    await assert.rejects(
      authService.register({
        email: 'test@example.com',
        password: 'short',
        fullName: 'Short User',
      }),
      /Password must be at least 8 characters long/,
    );
  });

  it('should prevent duplicate registration with the same email address', async () => {
    await authService.register({
      email: 'admin@brisksms.co.tz',
      password: 'AdminPassword123!',
      fullName: 'System Admin',
    });

    await assert.rejects(
      authService.register({
        email: 'admin@brisksms.co.tz',
        password: 'AnotherPassword456!',
        fullName: 'Duplicate Admin',
      }),
      /A user with this email address is already registered/,
    );
  });

  it('should authenticate valid credentials and reject invalid passwords', async () => {
    await authService.register({
      email: 'cashier@supermarket.co.tz',
      password: 'CorrectPassword123!',
      fullName: 'Cashier Agent',
    });

    // Valid login
    const loginResult = await authService.login({
      email: 'cashier@supermarket.co.tz',
      password: 'CorrectPassword123!',
    });
    assert.ok(loginResult.tokens.accessToken);
    assert.equal(loginResult.user.email, 'cashier@supermarket.co.tz');

    // Invalid password
    await assert.rejects(
      authService.login({
        email: 'cashier@supermarket.co.tz',
        password: 'WrongPassword!',
      }),
      /Invalid email or password/,
    );
  });

  it('should rotate refresh tokens and revoke old ones upon refresh', async () => {
    const reg = await authService.register({
      email: 'dev@tech.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Tech Lead',
    });

    const oldRefreshToken = reg.tokens.refreshToken;

    // Refresh token exchange
    const newTokens = await authService.refreshToken(oldRefreshToken);
    assert.ok(newTokens.accessToken);
    assert.ok(newTokens.refreshToken);
    assert.notEqual(newTokens.refreshToken, oldRefreshToken);

    // Old token must now be rejected
    await assert.rejects(
      authService.refreshToken(oldRefreshToken),
      /Refresh token is expired or invalid/,
    );
  });

  it('should verify user email address successfully', async () => {
    const reg = await authService.register({
      email: 'unverified@test.co.tz',
      password: 'Password123!',
      fullName: 'Unverified User',
    });

    assert.equal(reg.user.isEmailVerified, false);

    await authService.verifyEmail(reg.user.id);

    const updatedUser = dbStore.findUserById(reg.user.id);
    assert.equal(updatedUser?.isEmailVerified, true);
  });
});
