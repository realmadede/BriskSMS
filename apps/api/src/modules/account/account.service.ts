import { randomBytes, randomUUID } from 'node:crypto';
import { sql, withTransaction } from '@brisksms/db';
import { HttpException } from '../../core/http.js';
import { dbStore } from '../../core/store.js';
import {
  hashPassword,
  verifyPassword,
  generateSecureToken,
  hashToken,
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
} from '../../core/crypto.js';
import { authService } from '../auth/auth.service.js';
import { emailService } from '../auth/services/email.service.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const DELETION_HOLD_DAYS = 30;
const RECOVERY_CODE_COUNT = 8;
const EMAIL_CHANGE_PREFIX = 'email_change:';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  full_name: string;
  phone_number: string | null;
  is_email_verified: boolean;
  auth_provider: string;
  two_factor_secret: string | null;
  two_factor_enabled: boolean;
  two_factor_recovery_hashes: string | null;
  pending_email: string | null;
  deletion_requested_at: Date | null;
  deletion_scheduled_for: Date | null;
  created_at: Date;
}

async function loadUser(userId: string): Promise<UserRow> {
  const rows = await sql<UserRow>`SELECT * FROM "users" WHERE "id" = ${userId} LIMIT 1`;
  if (!rows[0]) throw new HttpException(404, 'USER_NOT_FOUND', 'User not found');
  return rows[0];
}

function requirePassword(user: UserRow, password: unknown): void {
  if (!user.password_hash) {
    throw new HttpException(400, 'NO_PASSWORD_SET', 'This account signs in with Google. Use "Forgot password" on the sign-in page to set a password first.');
  }
  if (typeof password !== 'string' || !password || password.length > 256 || !verifyPassword(password, user.password_hash)) {
    throw new HttpException(403, 'INVALID_PASSWORD', 'The password you entered is not correct');
  }
}

function plainTwoFactorSecret(stored: string): string {
  return isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
}

function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => hashToken(`recovery:${c}`)) };
}

/**
 * Checks a 6-digit authenticator code or a one-time recovery code for a user with 2FA on.
 * A recovery code is burned when it is used.
 */
export async function verifySecondFactor(userId: string, input: unknown): Promise<boolean> {
  const user = await loadUser(userId);
  if (!user.two_factor_enabled || !user.two_factor_secret) return true;
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return false;
  if (/^\d{3}\s?\d{3}$/.test(value)) {
    return verifyTotp(plainTwoFactorSecret(user.two_factor_secret), value);
  }
  const hash = hashToken(`recovery:${value.toLowerCase()}`);
  const hashes: string[] = user.two_factor_recovery_hashes ? JSON.parse(user.two_factor_recovery_hashes) : [];
  if (!hashes.includes(hash)) return false;
  await sql`
    UPDATE "users"
    SET "two_factor_recovery_hashes" = ${JSON.stringify(hashes.filter((h) => h !== hash))}, "updated_at" = NOW()
    WHERE "id" = ${userId}
  `;
  return true;
}

export class AccountService {
  async getAccount(userId: string, organizationId?: string) {
    const user = await loadUser(userId);
    const orgs = await sql<{
      id: string; name: string; role: string; account_type: string; plan_tier: string; member_count: number;
    }>`
      SELECT o."id", o."name", uo."role"::text AS role, o."account_type", o."plan_tier",
             (SELECT COUNT(*)::int FROM "users_organizations" m WHERE m."organization_id" = o."id") AS member_count
      FROM "users_organizations" uo
      JOIN "organizations" o ON o."id" = uo."organization_id"
      WHERE uo."user_id" = ${userId}
      ORDER BY uo."created_at" ASC
    `;
    const ownedIds = orgs.filter((o) => o.role === 'OWNER').map((o) => o.id);
    const memberRows = ownedIds.length
      ? await sql<{ organization_id: string; user_id: string; full_name: string; email: string; role: string }>`
          SELECT uo."organization_id", u."id" AS user_id, u."full_name", u."email", uo."role"::text AS role
          FROM "users_organizations" uo JOIN "users" u ON u."id" = uo."user_id"
          WHERE uo."organization_id" IN (
            SELECT "organization_id" FROM "users_organizations" WHERE "user_id" = ${userId} AND "role" = 'OWNER'::"UserRole"
          ) AND uo."user_id" <> ${userId} AND u."is_active" = TRUE
          ORDER BY u."full_name" ASC
        `
      : [];
    const membersByOrg = new Map<string, { userId: string; fullName: string; email: string; role: string }[]>();
    for (const m of memberRows) {
      const list = membersByOrg.get(m.organization_id) ?? [];
      list.push({ userId: m.user_id, fullName: m.full_name, email: m.email, role: m.role });
      membersByOrg.set(m.organization_id, list);
    }
    const recoveryLeft = user.two_factor_recovery_hashes ? JSON.parse(user.two_factor_recovery_hashes).length : 0;
    return {
      profile: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        phoneNumber: user.phone_number,
        isEmailVerified: user.is_email_verified,
        signInMethod: user.auth_provider,
        hasPassword: Boolean(user.password_hash),
        memberSince: user.created_at,
      },
      pendingEmail: user.pending_email,
      twoFactor: { enabled: user.two_factor_enabled, recoveryCodesLeft: user.two_factor_enabled ? recoveryLeft : 0 },
      workspaces: orgs.map((o) => ({
        id: o.id,
        // Other people in a workspace you own: who ownership could pass to
        members: o.role === 'OWNER' ? (membersByOrg.get(o.id) ?? []) : [],
        name: o.name,
        role: o.role,
        accountType: o.account_type,
        planTier: o.plan_tier,
        memberCount: o.member_count,
        isActive: o.id === organizationId,
      })),
      deletion: user.deletion_scheduled_for
        ? { requestedAt: user.deletion_requested_at, scheduledFor: user.deletion_scheduled_for, holdDays: DELETION_HOLD_DAYS }
        : null,
    };
  }

  async updateProfile(userId: string, dto: { fullName?: unknown; phoneNumber?: unknown }) {
    const fullName = typeof dto.fullName === 'string' ? dto.fullName.trim() : '';
    if (fullName.length < 2 || fullName.length > 255) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Full name must be between 2 and 255 characters');
    }
    const phone = typeof dto.phoneNumber === 'string' && dto.phoneNumber.trim() ? dto.phoneNumber.trim() : null;
    if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) {
      throw new HttpException(400, 'INVALID_PHONE', 'Enter a valid phone number');
    }
    await sql`UPDATE "users" SET "full_name" = ${fullName}, "phone_number" = ${phone}, "updated_at" = NOW() WHERE "id" = ${userId}`;
  }

  /** Signs out every session except the one making the request. */
  private async revokeOtherSessions(userId: string, keepJti?: string): Promise<void> {
    const keep = keepJti
      ? (await sql<{ family_id: string }>`SELECT "family_id" FROM "refresh_tokens" WHERE "jti" = ${keepJti} LIMIT 1`)[0]?.family_id
      : undefined;
    const families = await sql<{ family_id: string }>`
      SELECT DISTINCT "family_id" FROM "refresh_tokens" WHERE "user_id" = ${userId} AND "revoked_at" IS NULL
    `;
    for (const f of families) {
      if (f.family_id && f.family_id !== keep) await authService.revokeFamily(f.family_id);
    }
  }

  async changePassword(userId: string, dto: { currentPassword?: unknown; newPassword?: unknown; code?: unknown }, currentJti?: string) {
    const user = await loadUser(userId);
    // A Google-only account has no password yet. It sets one without a current password,
    // and only the authenticator code (if two-factor is on) proves it is really them.
    if (user.password_hash) {
      requirePassword(user, dto.currentPassword);
    } else if (user.two_factor_enabled && !(await verifySecondFactor(userId, dto.code))) {
      throw new HttpException(403, 'INVALID_TWO_FACTOR_CODE', 'Enter a valid authenticator or recovery code to set a password');
    }
    const next = dto.newPassword;
    if (typeof next !== 'string' || next.length < 8) {
      throw new HttpException(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters long');
    }
    if (next.length > 256) throw new HttpException(400, 'INVALID_PAYLOAD', 'Password must not exceed 256 characters');
    if (user.password_hash && next === dto.currentPassword) {
      throw new HttpException(400, 'PASSWORD_UNCHANGED', 'Choose a password different from the current one');
    }
    await sql`UPDATE "users" SET "password_hash" = ${hashPassword(next)}, "updated_at" = NOW() WHERE "id" = ${userId}`;
    await this.revokeOtherSessions(userId, currentJti);
  }

  async beginTwoFactor(userId: string, password: unknown) {
    const user = await loadUser(userId);
    requirePassword(user, password);
    if (user.two_factor_enabled) {
      throw new HttpException(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already on');
    }
    const secret = generateTotpSecret();
    await sql`UPDATE "users" SET "two_factor_secret" = ${encryptSecret(secret)}, "updated_at" = NOW() WHERE "id" = ${userId}`;
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  async enableTwoFactor(userId: string, code: unknown) {
    const user = await loadUser(userId);
    if (user.two_factor_enabled) {
      throw new HttpException(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already on');
    }
    if (!user.two_factor_secret) {
      throw new HttpException(400, 'TWO_FACTOR_NOT_STARTED', 'Start two-factor setup first');
    }
    if (!verifyTotp(plainTwoFactorSecret(user.two_factor_secret), String(code ?? ''))) {
      throw new HttpException(400, 'INVALID_TWO_FACTOR_CODE', 'That code is not correct. Check the code in your authenticator app and try again');
    }
    const { codes, hashes } = newRecoveryCodes();
    await sql`
      UPDATE "users"
      SET "two_factor_enabled" = true, "two_factor_recovery_hashes" = ${JSON.stringify(hashes)}, "updated_at" = NOW()
      WHERE "id" = ${userId}
    `;
    return { recoveryCodes: codes };
  }

  async disableTwoFactor(userId: string, dto: { password?: unknown; code?: unknown }) {
    const user = await loadUser(userId);
    requirePassword(user, dto.password);
    if (!user.two_factor_enabled) return;
    if (!(await verifySecondFactor(userId, dto.code))) {
      throw new HttpException(403, 'INVALID_TWO_FACTOR_CODE', 'That code is not correct');
    }
    await sql`
      UPDATE "users"
      SET "two_factor_enabled" = false, "two_factor_secret" = NULL, "two_factor_recovery_hashes" = NULL, "updated_at" = NOW()
      WHERE "id" = ${userId}
    `;
  }

  async requestEmailChange(userId: string, dto: { newEmail?: unknown; password?: unknown }) {
    const user = await loadUser(userId);
    requirePassword(user, dto.password);
    const newEmail = typeof dto.newEmail === 'string' ? dto.newEmail.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) || newEmail.length > 255) {
      throw new HttpException(400, 'INVALID_EMAIL', 'A valid email address is required');
    }
    if (newEmail === user.email) {
      throw new HttpException(400, 'EMAIL_UNCHANGED', 'That is already your email address');
    }
    const taken = await sql`SELECT 1 FROM "users" WHERE "email" = ${newEmail} LIMIT 1`;
    if (taken[0]) {
      throw new HttpException(409, 'EMAIL_EXISTS', 'A user with this email address is already registered');
    }
    await authService.checkRateLimit(`email_change_${userId}`, 5, 60 * 60 * 1000);

    const raw = generateSecureToken('bsk_ec', 32);
    await withTransaction(async (tx) => {
      await tx`UPDATE "users" SET "pending_email" = ${newEmail}, "updated_at" = NOW() WHERE "id" = ${userId}`;
      await tx`
        INSERT INTO "email_verification_tokens" ("id", "user_id", "token_hash", "expires_at")
        VALUES (${randomUUID()}, ${userId}, ${hashToken(EMAIL_CHANGE_PREFIX + raw)}, ${new Date(Date.now() + 24 * 3600 * 1000)})
      `;
    });
    let sent = false;
    try {
      sent = (await emailService.sendEmailChangeVerification(newEmail, user.full_name, raw)).success;
    } catch (err) {
      console.error('[AccountService] Email change verification delivery error:', err);
    }
    return { pendingEmail: newEmail, verificationEmailSent: sent, ...(process.env.NODE_ENV !== 'production' ? { confirmToken: raw } : {}) };
  }

  async confirmEmailChange(token: unknown) {
    if (typeof token !== 'string' || !token.startsWith('bsk_ec_')) {
      throw new HttpException(400, 'INVALID_TOKEN', 'This confirmation link is invalid');
    }
    const hash = hashToken(EMAIL_CHANGE_PREFIX + token.trim());
    const userId = await withTransaction(async (tx) => {
      const rows = await tx`SELECT * FROM "email_verification_tokens" WHERE "token_hash" = ${hash} FOR UPDATE`;
      const rec = rows[0];
      if (!rec || rec.used_at !== null || new Date(rec.expires_at) <= new Date()) {
        throw new HttpException(400, 'INVALID_TOKEN', 'This confirmation link is invalid, expired, or already used');
      }
      const users = await tx`SELECT "pending_email" FROM "users" WHERE "id" = ${rec.user_id} FOR UPDATE`;
      const pending = users[0]?.pending_email as string | null | undefined;
      if (!pending) throw new HttpException(400, 'INVALID_TOKEN', 'There is no email change waiting for confirmation');
      const clash = await tx`SELECT 1 FROM "users" WHERE "email" = ${pending} AND "id" <> ${rec.user_id}`;
      if (clash[0]) throw new HttpException(409, 'EMAIL_EXISTS', 'That email address is now used by another account');
      await tx`UPDATE "email_verification_tokens" SET "used_at" = NOW() WHERE "id" = ${rec.id}`;
      await tx`
        UPDATE "users"
        SET "email" = ${pending}, "pending_email" = NULL, "is_email_verified" = true, "updated_at" = NOW()
        WHERE "id" = ${rec.user_id}
      `;
      return String(rec.user_id);
    });
    await this.revokeOtherSessions(userId);
    return { userId };
  }

  /**
   * Schedules the account for permanent deletion in 30 days and signs it out everywhere.
   * Nothing is erased yet: signing in again inside the hold restores the account untouched.
   */
  async requestDeletion(userId: string, dto: { password?: unknown; confirmEmail?: unknown; code?: unknown }) {
    const user = await loadUser(userId);
    if (user.deletion_scheduled_for) {
      throw new HttpException(409, 'DELETION_ALREADY_SCHEDULED', 'This account is already scheduled for deletion');
    }
    if (user.password_hash) requirePassword(user, dto.password);
    if (typeof dto.confirmEmail !== 'string' || dto.confirmEmail.trim().toLowerCase() !== user.email) {
      throw new HttpException(400, 'CONFIRMATION_MISMATCH', 'Type your account email exactly to confirm');
    }
    if (user.two_factor_enabled && !(await verifySecondFactor(userId, dto.code))) {
      throw new HttpException(403, 'INVALID_TWO_FACTOR_CODE', 'Enter a valid authenticator or recovery code to confirm');
    }

    // An owner cannot walk away from a workspace other people still use.
    const blocking = await sql<{ name: string }>`
      SELECT o."name"
      FROM "users_organizations" uo
      JOIN "organizations" o ON o."id" = uo."organization_id"
      WHERE uo."user_id" = ${userId} AND uo."role" = 'OWNER'
        AND EXISTS (
          SELECT 1 FROM "users_organizations" other
          WHERE other."organization_id" = o."id" AND other."user_id" <> ${userId}
        )
    `;
    if (blocking.length > 0) {
      throw new HttpException(
        409,
        'OWNERSHIP_TRANSFER_REQUIRED',
        `Transfer ownership of ${blocking.map((b) => b.name).join(', ')} to another member before deleting your account`,
      );
    }

    const scheduledFor = new Date(Date.now() + DELETION_HOLD_DAYS * 24 * 3600 * 1000);
    await sql`
      UPDATE "users"
      SET "deletion_requested_at" = NOW(), "deletion_scheduled_for" = ${scheduledFor}, "updated_at" = NOW()
      WHERE "id" = ${userId}
    `;
    await this.revokeOtherSessions(userId);
    return { scheduledFor, holdDays: DELETION_HOLD_DAYS };
  }

  /** Hands a workspace to another member. The current owner stays on as an admin. */
  async transferOwnership(
    userId: string,
    dto: { organizationId?: unknown; newOwnerId?: unknown; password?: unknown; code?: unknown },
  ) {
    const orgId = typeof dto.organizationId === 'string' ? dto.organizationId : '';
    const newOwnerId = typeof dto.newOwnerId === 'string' ? dto.newOwnerId : '';
    if (!/^[0-9a-f-]{36}$/i.test(orgId) || !/^[0-9a-f-]{36}$/i.test(newOwnerId)) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Choose a workspace and a member to hand it to');
    }
    if (newOwnerId === userId) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Choose someone other than yourself');
    }
    const user = await loadUser(userId);
    if (user.password_hash) requirePassword(user, dto.password);
    if (user.two_factor_enabled && !(await verifySecondFactor(userId, dto.code))) {
      throw new HttpException(403, 'INVALID_TWO_FACTOR_CODE', 'Enter a valid authenticator or recovery code to confirm');
    }
    await withTransaction(async (tx) => {
      const rows = await tx<{ user_id: string; role: string }>`
        SELECT "user_id", "role"::text AS role FROM "users_organizations"
        WHERE "organization_id" = ${orgId} AND "user_id" IN (${userId}, ${newOwnerId})
        FOR UPDATE
      `;
      if (rows.find((r) => r.user_id === userId)?.role !== 'OWNER') {
        throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only the owner can hand over a workspace');
      }
      if (!rows.some((r) => r.user_id === newOwnerId)) {
        throw new HttpException(404, 'MEMBER_NOT_FOUND', 'That person is not a member of this workspace');
      }
      await tx`UPDATE "users_organizations" SET "role" = 'OWNER'::"UserRole" WHERE "organization_id" = ${orgId} AND "user_id" = ${newOwnerId}`;
      await tx`UPDATE "users_organizations" SET "role" = 'ADMIN'::"UserRole" WHERE "organization_id" = ${orgId} AND "user_id" = ${userId}`;
      await dbStore.recordAudit(
        {
          organizationId: orgId,
          actorId: userId,
          actorType: 'USER',
          action: 'OWNERSHIP_TRANSFERRED',
          resourceType: 'ORGANIZATION',
          resourceId: orgId,
          newState: { newOwnerId },
        },
        tx,
      );
    });
  }

  async cancelDeletion(userId: string): Promise<boolean> {
    const rows = await sql`
      UPDATE "users"
      SET "deletion_requested_at" = NULL, "deletion_scheduled_for" = NULL, "updated_at" = NOW()
      WHERE "id" = ${userId} AND "deletion_scheduled_for" IS NOT NULL
      RETURNING "id"
    `;
    return rows.length > 0;
  }
}

export const accountService = new AccountService();
