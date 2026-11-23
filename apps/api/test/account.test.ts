import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '@brisksms/db';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { accountService } from '../src/modules/account/account.service.js';
import { totpAt, verifyTotp, generateTotpSecret } from '../src/modules/account/totp.js';
import { decryptSecret } from '../src/core/crypto.js';
import { purgeDeletedAccounts } from '@brisksms/worker';
import { MockGoogleTokenVerifier } from '../src/modules/auth/providers/google.provider.js';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: any) => {
    assert.equal(err.code ?? err.errorCode, code);
    return true;
  });
}

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    // Secret "12345678901234567890" in base32; at T=59s the 6-digit code is 287082
    assert.equal(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
  });

  it('accepts the current code and one step of drift, rejects the rest', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    assert.equal(verifyTotp(secret, totpAt(secret, now), now), true);
    assert.equal(verifyTotp(secret, totpAt(secret, now - 30_000), now), true);
    assert.equal(verifyTotp(secret, totpAt(secret, now - 120_000), now), false);
    assert.equal(verifyTotp(secret, 'abcdef', now), false);
  });
});

describe('Account security', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = 'brisksms_dev_encryption_master_key_32_bytes_min!';
    await dbStore.reset();
    await authService.clearRateLimits();
  });

  async function signUp(organizationName?: string) {
    const res = await authService.register({
      email: 'amina@example.co.tz',
      password: 'correct-horse-9',
      fullName: 'Amina Juma',
      organizationName,
    });
    return res.user.id;
  }

  it('tells a personal account from an organization', async () => {
    const personalId = await signUp();
    const personal = await accountService.getAccount(personalId);
    assert.equal(personal.workspaces[0]!.accountType, 'PERSONAL');

    await dbStore.reset();
    const orgId = await signUp('Juma Traders Ltd');
    const org = await accountService.getAccount(orgId);
    assert.equal(org.workspaces[0]!.accountType, 'ORGANIZATION');
    assert.equal(org.workspaces[0]!.name, 'Juma Traders Ltd');
  });

  it('changes the password only with the current one', async () => {
    const id = await signUp();
    await expectCode(accountService.changePassword(id, { currentPassword: 'wrong-password', newPassword: 'another-pass-1' }), 'INVALID_PASSWORD');
    await expectCode(accountService.changePassword(id, { currentPassword: 'correct-horse-9', newPassword: 'short' }), 'WEAK_PASSWORD');
    await accountService.changePassword(id, { currentPassword: 'correct-horse-9', newPassword: 'another-pass-1' });
    await expectCode(authService.login({ email: 'amina@example.co.tz', password: 'correct-horse-9' }), 'INVALID_CREDENTIALS');
    const ok = await authService.login({ email: 'amina@example.co.tz', password: 'another-pass-1' });
    assert.ok(ok.tokens.accessToken);
  });

  it('turns on two-factor, demands a code at sign-in, and burns recovery codes', async () => {
    const id = await signUp();
    const { secret } = await accountService.beginTwoFactor(id, 'correct-horse-9');

    const stored = (await sql<{ two_factor_secret: string }>`SELECT "two_factor_secret" FROM "users" WHERE "id" = ${id}`)[0]!;
    assert.notEqual(stored.two_factor_secret, secret, 'the secret is stored encrypted');
    assert.equal(decryptSecret(stored.two_factor_secret), secret);

    await expectCode(accountService.enableTwoFactor(id, '000000'), 'INVALID_TWO_FACTOR_CODE');
    const { recoveryCodes } = await accountService.enableTwoFactor(id, totpAt(secret, Date.now()));
    assert.equal(recoveryCodes.length, 8);

    const creds = { email: 'amina@example.co.tz', password: 'correct-horse-9' };
    await expectCode(authService.login(creds), 'TWO_FACTOR_REQUIRED');
    await expectCode(authService.login({ ...creds, totpCode: '123456' }), 'INVALID_TWO_FACTOR_CODE');
    assert.ok((await authService.login({ ...creds, totpCode: totpAt(secret, Date.now()) })).tokens.accessToken);

    assert.ok((await authService.login({ ...creds, totpCode: recoveryCodes[0]! })).tokens.accessToken);
    await expectCode(authService.login({ ...creds, totpCode: recoveryCodes[0]! }), 'INVALID_TWO_FACTOR_CODE');

    await accountService.disableTwoFactor(id, { password: 'correct-horse-9', code: totpAt(secret, Date.now()) });
    assert.ok((await authService.login(creds)).tokens.accessToken);
  });

  it('changes the email only after the new address confirms it', async () => {
    const id = await signUp();
    await expectCode(accountService.requestEmailChange(id, { newEmail: 'new@example.co.tz', password: 'nope' }), 'INVALID_PASSWORD');
    const { confirmToken } = (await accountService.requestEmailChange(id, { newEmail: 'New@Example.co.tz', password: 'correct-horse-9' })) as { confirmToken: string };

    assert.equal((await dbStore.findUserById(id))!.email, 'amina@example.co.tz', 'unchanged until confirmed');
    await accountService.confirmEmailChange(confirmToken);
    assert.equal((await dbStore.findUserById(id))!.email, 'new@example.co.tz');
    await expectCode(accountService.confirmEmailChange(confirmToken), 'INVALID_TOKEN');
  });

  it('refuses an email address another account already uses', async () => {
    const id = await signUp();
    await authService.register({ email: 'taken@example.co.tz', password: 'correct-horse-9', fullName: 'Other Person' });
    await expectCode(accountService.requestEmailChange(id, { newEmail: 'taken@example.co.tz', password: 'correct-horse-9' }), 'EMAIL_EXISTS');
  });

  it('holds a deleted account for 30 days and restores it on sign-in', async () => {
    const id = await signUp();
    await expectCode(accountService.requestDeletion(id, { password: 'correct-horse-9', confirmEmail: 'someone@else.com' }), 'CONFIRMATION_MISMATCH');
    await expectCode(accountService.requestDeletion(id, { password: 'wrong', confirmEmail: 'amina@example.co.tz' }), 'INVALID_PASSWORD');

    const { scheduledFor, holdDays } = await accountService.requestDeletion(id, { password: 'correct-horse-9', confirmEmail: 'amina@example.co.tz' });
    assert.equal(holdDays, 30);
    const days = (scheduledFor.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30);
    assert.ok((await accountService.getAccount(id)).deletion);

    const login = await authService.login({ email: 'amina@example.co.tz', password: 'correct-horse-9' });
    assert.equal(login.accountRestored, true);
    assert.equal((await accountService.getAccount(id)).deletion, null);
  });

  it('will not let an owner delete a workspace other people still use', async () => {
    const ownerId = await signUp('Juma Traders Ltd');
    const orgId = (await sql<{ organization_id: string }>`SELECT "organization_id" FROM "users_organizations" WHERE "user_id" = ${ownerId}`)[0]!.organization_id;
    const other = await authService.register({ email: 'staff@example.co.tz', password: 'correct-horse-9', fullName: 'Staff Member' });
    await sql`INSERT INTO "users_organizations" ("organization_id", "user_id", "role") VALUES (${orgId}, ${other.user.id}, 'FINANCE')`;
    await expectCode(
      accountService.requestDeletion(ownerId, { password: 'correct-horse-9', confirmEmail: 'amina@example.co.tz' }),
      'OWNERSHIP_TRANSFER_REQUIRED',
    );
  });

  it('erases personal data after the hold, wipes the phone, and keeps sealed payment records', async () => {
    const id = await signUp();
    const orgId = (await sql<{ organization_id: string }>`SELECT "organization_id" FROM "users_organizations" WHERE "user_id" = ${id}`)[0]!.organization_id;
    await sql`INSERT INTO "customers" ("organization_id", "account_number", "full_name", "phone_number") VALUES (${orgId}, 'ACC-1', 'Neema Said', '+255700000001')`;
    await sql`INSERT INTO "devices" ("organization_id", "label", "device_model", "manufacturer", "android_version", "app_version", "device_token_hash", "public_key_pem") VALUES (${orgId}, 'Shop phone', 'Pixel 7', 'Google', '14', '1.0.0', 'hash-1', 'pem')`;
    await accountService.requestDeletion(id, { password: 'correct-horse-9', confirmEmail: 'amina@example.co.tz' });

    // Still inside the hold: nothing is touched
    assert.equal(await purgeDeletedAccounts(new Date()), 0);
    assert.equal((await sql`SELECT 1 FROM "customers" WHERE "organization_id" = ${orgId}`).length, 1);

    // Past the hold
    const later = new Date(Date.now() + 31 * 86_400_000);
    assert.equal(await purgeDeletedAccounts(later), 1);
    assert.equal((await sql`SELECT 1 FROM "customers" WHERE "organization_id" = ${orgId}`).length, 0);
    const user = (await sql<Record<string, any>>`SELECT * FROM "users" WHERE "id" = ${id}`)[0]!;
    assert.equal(user.email, `deleted-${id}@deleted.invalid`);
    assert.equal(user.password_hash, null);
    assert.equal(user.is_active, false);
    const org = (await sql<Record<string, any>>`SELECT * FROM "organizations" WHERE "id" = ${orgId}`)[0]!;
    assert.equal(org.name, 'Deleted account');
    const dev = (await sql<Record<string, any>>`SELECT "status", "label" FROM "devices" WHERE "organization_id" = ${orgId}`)[0]!;
    assert.equal(dev.status, 'REVOKED');
    assert.equal(dev.label, 'Erased device');
    const cmds = await sql<Record<string, any>>`SELECT "command_type", "status" FROM "device_commands" WHERE "organization_id" = ${orgId}`;
    assert.deepEqual(cmds.map((c) => [c.command_type, c.status]), [['WIPE_AND_REVOKE', 'PENDING']]);

    // Running it again changes nothing
    assert.equal(await purgeDeletedAccounts(later), 0);
    await expectCode(authService.login({ email: 'amina@example.co.tz', password: 'correct-horse-9' }), 'INVALID_CREDENTIALS');
  });

  function googleToken(mock: MockGoogleTokenVerifier, token: string, sub: string, email: string) {
    mock.registerToken(token, {
      iss: 'https://accounts.google.com',
      sub,
      aud: 'test-client-id-brisksms.apps.googleusercontent.com',
      email,
      email_verified: true,
      name: 'Amina Juma',
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as any);
  }

  it('asks a Google sign-in for the authenticator code too', async () => {
    const mock = new MockGoogleTokenVerifier();
    authService.setGoogleVerifier(mock);
    process.env.GOOGLE_CLIENT_ID = 'test-client-id-brisksms.apps.googleusercontent.com';
    const id = await signUp();
    const { secret } = await accountService.beginTwoFactor(id, 'correct-horse-9');
    await accountService.enableTwoFactor(id, totpAt(secret, Date.now()));
    googleToken(mock, 'tok-2fa', 'g-1', 'amina@example.co.tz');

    await expectCode(authService.loginWithGoogle('tok-2fa'), 'TWO_FACTOR_REQUIRED');
    await expectCode(authService.loginWithGoogle('tok-2fa', undefined, undefined, '123456'), 'INVALID_TWO_FACTOR_CODE');
    const ok = await authService.loginWithGoogle('tok-2fa', undefined, undefined, totpAt(secret, Date.now()));
    assert.ok(ok.tokens.accessToken);
  });

  it('lets a Google-only account set a password without a current one', async () => {
    const mock = new MockGoogleTokenVerifier();
    authService.setGoogleVerifier(mock);
    process.env.GOOGLE_CLIENT_ID = 'test-client-id-brisksms.apps.googleusercontent.com';
    googleToken(mock, 'tok-new', 'g-2', 'kito@example.co.tz');
    const { user } = await authService.loginWithGoogle('tok-new');
    assert.equal((await accountService.getAccount(user.id)).profile.hasPassword, false);
    await expectCode(accountService.changePassword(user.id, { newPassword: 'short' }), 'WEAK_PASSWORD');
    await accountService.changePassword(user.id, { newPassword: 'a-fresh-password-1' });
    assert.equal((await accountService.getAccount(user.id)).profile.hasPassword, true);
    assert.ok((await authService.login({ email: 'kito@example.co.tz', password: 'a-fresh-password-1' })).tokens.accessToken);
  });

  it('hands a workspace to another member, which then lets the old owner delete their account', async () => {
    const ownerId = await signUp('Juma Traders Ltd');
    const orgId = (await sql<{ organization_id: string }>`SELECT "organization_id" FROM "users_organizations" WHERE "user_id" = ${ownerId}`)[0]!.organization_id;
    const other = await authService.register({ email: 'staff@example.co.tz', password: 'correct-horse-9', fullName: 'Staff Member' });
    await sql`INSERT INTO "users_organizations" ("organization_id", "user_id", "role") VALUES (${orgId}, ${other.user.id}, 'FINANCE')`;

    const ws = (await accountService.getAccount(ownerId)).workspaces.find((w) => w.id === orgId)!;
    assert.deepEqual(ws.members.map((m) => m.userId), [other.user.id]);
    await expectCode(accountService.transferOwnership(other.user.id, { organizationId: orgId, newOwnerId: ownerId, password: 'correct-horse-9' }), 'INSUFFICIENT_PERMISSIONS');
    await expectCode(accountService.transferOwnership(ownerId, { organizationId: orgId, newOwnerId: other.user.id, password: 'wrong' }), 'INVALID_PASSWORD');
    await accountService.transferOwnership(ownerId, { organizationId: orgId, newOwnerId: other.user.id, password: 'correct-horse-9' });

    const roles = await sql<{ user_id: string; role: string }>`SELECT "user_id", "role"::text AS role FROM "users_organizations" WHERE "organization_id" = ${orgId}`;
    assert.equal(roles.find((r) => r.user_id === other.user.id)!.role, 'OWNER');
    assert.equal(roles.find((r) => r.user_id === ownerId)!.role, 'ADMIN');
    const res = await accountService.requestDeletion(ownerId, { password: 'correct-horse-9', confirmEmail: 'amina@example.co.tz' });
    assert.equal(res.holdDays, 30);
  });
});
