import { dbStore, UserRecord, mapUserRow } from '../../core/store.js';
import { hashPassword, verifyPassword, signJwt, generateSecureToken, hashToken } from '../../core/crypto.js';
import { HttpException } from '../../core/http.js';
import { tokenBlacklist } from '../../core/guards.js';
import { sql, withTransaction } from '@brisksms/db';
import { randomUUID } from 'node:crypto';
import { GoogleTokenVerifier, googleTokenVerifier } from './providers/google.provider.js';
import { EmailService, emailService } from './services/email.service.js';

export interface RegisterDto {
  email: string;
  password: string;
  fullName: string;
  phoneNumber?: string;
  organizationName?: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class AuthService {
  private googleVerifier: GoogleTokenVerifier = googleTokenVerifier;
  private emailService: EmailService = emailService;
  private rateLimitBuckets = new Map<string, RateLimitBucket>();

  setGoogleVerifier(verifier: GoogleTokenVerifier): void {
    this.googleVerifier = verifier;
  }

  setEmailService(service: EmailService): void {
    this.emailService = service;
  }

  clearRateLimits(): void {
    this.rateLimitBuckets.clear();
  }

  private checkRateLimit(key: string, maxAttempts: number, windowMs: number): void {
    const now = Date.now();
    const bucket = this.rateLimitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }

    if (bucket.count >= maxAttempts) {
      const waitSec = Math.ceil((bucket.resetAt - now) / 1000);
      throw new HttpException(429, 'TOO_MANY_REQUESTS', `Rate limit exceeded. Please try again in ${waitSec} seconds.`);
    }

    bucket.count += 1;
  }

  async register(dto: RegisterDto): Promise<{
    user: Omit<UserRecord, 'passwordHash'>;
    organizationId?: string;
    tokens: AuthTokens;
    verificationEmailSent: boolean;
  }> {
    if (!dto.email || !dto.password || !dto.fullName) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email, password, and fullName are required');
    }

    if (dto.password.length < 8) {
      throw new HttpException(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters long');
    }

    const emailNorm = dto.email.trim().toLowerCase();
    const existingUser = await dbStore.findUserByEmail(emailNorm);
    if (existingUser) {
      throw new HttpException(409, 'EMAIL_EXISTS', 'A user with this email address is already registered');
    }

    const passwordHash = hashPassword(dto.password);

    return withTransaction(async (tx) => {
      const user = await dbStore.createUser(
        {
          email: emailNorm,
          passwordHash,
          fullName: dto.fullName.trim(),
          phoneNumber: dto.phoneNumber?.trim(),
          isEmailVerified: false,
          authProvider: 'LOCAL',
        },
        tx,
      );

      let organizationId: string | undefined;
      let userRole: string | undefined;

      const orgName = dto.organizationName?.trim() || `${user.fullName}'s Workspace`;
      const slug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'workspace';
      const { org, membership } = await dbStore.createOrganization(
        {
          name: orgName,
          slug: `${slug}-${randomUUID().slice(0, 6)}`,
          creatorUserId: user.id,
        },
        tx,
      );
      organizationId = org.id;
      userRole = membership.role;

      // 1. Issue short-lived session tokens
      const jti = randomUUID();
      const accessToken = signJwt(
        {
          sub: user.id,
          email: user.email,
          organizationId,
          role: userRole,
          jti,
        },
        900,
      );

      const rawRefreshToken = generateSecureToken('bsk_ref');
      const refreshHash = hashToken(rawRefreshToken);
      const refreshExpiresAt = new Date(Date.now() + 30 * 86400 * 1000);

      await tx`
        INSERT INTO "refresh_tokens" ("token_hash", "user_id", "jti", "expires_at")
        VALUES (${refreshHash}, ${user.id}, ${jti}, ${refreshExpiresAt})
      `;

      // 2. Generate and persist single-use email verification token
      const rawVerificationToken = generateSecureToken('bsk_ev', 32);
      const tokenHash = hashToken(rawVerificationToken);
      const expiryHours = parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_HOURS || '24', 10);
      const verificationExpiresAt = new Date(Date.now() + expiryHours * 3600 * 1000);

      await dbStore.createEmailVerificationToken(
        {
          userId: user.id,
          tokenHash,
          expiresAt: verificationExpiresAt,
        },
        tx,
      );

      // 3. Dispatch verification email via Resend
      let verificationEmailSent = false;
      try {
        const dispatchRes = await this.emailService.sendVerificationEmail(
          user.email,
          user.fullName,
          rawVerificationToken,
        );
        verificationEmailSent = dispatchRes.success;
      } catch (emailErr) {
        console.error('[AuthService] Verification email delivery error:', emailErr);
      }

      const { passwordHash: _, ...userSafe } = user;
      return {
        user: userSafe,
        organizationId,
        tokens: {
          accessToken,
          refreshToken: rawRefreshToken,
          expiresIn: 900,
        },
        verificationEmailSent,
      };
    });
  }

  async login(dto: LoginDto): Promise<{
    user: Omit<UserRecord, 'passwordHash'>;
    organizations: { id: string; name: string; role: string }[];
    tokens: AuthTokens;
  }> {
    if (!dto.email || !dto.password) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email and password are required');
    }

    const emailNorm = dto.email.trim().toLowerCase();
    const user = await dbStore.findUserByEmail(emailNorm);
    if (!user) {
      throw new HttpException(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (!user.passwordHash) {
      throw new HttpException(401, 'INVALID_CREDENTIALS', 'Account is configured for Google Sign-In. Please sign in with Google.');
    }

    const isMatch = verifyPassword(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new HttpException(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (!user.isActive) {
      throw new HttpException(403, 'ACCOUNT_DEACTIVATED', 'Your account has been deactivated. Please contact support.');
    }

    const userOrgs = await dbStore.getUserOrganizations(user.id);
    const primaryOrg = userOrgs[0];

    const jti = randomUUID();
    const accessToken = signJwt(
      {
        sub: user.id,
        email: user.email,
        organizationId: primaryOrg?.org.id,
        role: primaryOrg?.role,
        jti,
      },
      900,
    );

    const rawRefreshToken = generateSecureToken('bsk_ref');
    const refreshHash = hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);

    await sql`
      INSERT INTO "refresh_tokens" ("token_hash", "user_id", "jti", "expires_at")
      VALUES (${refreshHash}, ${user.id}, ${jti}, ${expiresAt})
    `;

    const { passwordHash: _, ...userSafe } = user;
    return {
      user: userSafe,
      organizations: userOrgs.map((o) => ({ id: o.org.id, name: o.org.name, role: o.role })),
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        expiresIn: 900,
      },
    };
  }

  async loginWithGoogle(idToken: string, clientIp?: string): Promise<{
    user: Omit<UserRecord, 'passwordHash'>;
    organizationId?: string;
    organizations: { id: string; name: string; role: string }[];
    tokens: AuthTokens;
  }> {
    if (!idToken || typeof idToken !== 'string') {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'idToken is required');
    }

    // Rate limit: max 10 attempts per minute per IP
    if (clientIp) {
      this.checkRateLimit(`google_auth_${clientIp}`, 10, 60_000);
    }

    let payload;
    try {
      payload = await this.googleVerifier.verifyIdToken(idToken);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Google token verification failed';
      if (msg.toLowerCase().includes('email is not verified')) {
        throw new HttpException(400, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Google account email is not verified');
      }
      throw new HttpException(401, 'INVALID_GOOGLE_TOKEN', msg);
    }

    if (!payload.email_verified) {
      throw new HttpException(400, 'GOOGLE_EMAIL_NOT_VERIFIED', 'Google account email is not verified');
    }

    return withTransaction(async (tx) => {
      // 1. Check if user exists by google_id
      let user = await dbStore.findUserByGoogleId(payload.sub, tx);

      if (user) {
        if (!user.isActive) {
          throw new HttpException(403, 'ACCOUNT_DEACTIVATED', 'Your account has been deactivated. Please contact support.');
        }
      } else {
        // 2. Check if user exists by verified email (Safe Account Linking)
        const existingEmailUser = await dbStore.findUserByEmail(payload.email, tx);
        if (existingEmailUser) {
          if (!existingEmailUser.isActive) {
            throw new HttpException(403, 'ACCOUNT_DEACTIVATED', 'Your account has been deactivated. Please contact support.');
          }
          user = await dbStore.linkGoogleAccount(existingEmailUser.id, payload.sub, payload.picture, tx);
        } else {
          // 3. Auto-provision new user with verified email
          const fullName = payload.name?.trim() || payload.email.split('@')[0] || 'Merchant Admin';
          user = await dbStore.createUser(
            {
              email: payload.email,
              fullName,
              googleId: payload.sub,
              authProvider: 'GOOGLE',
              avatarUrl: payload.picture,
              isEmailVerified: true,
            },
            tx,
          );

          // Create default organization
          const orgName = `${fullName}'s Workspace`;
          const slug = orgName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'workspace';
          await dbStore.createOrganization(
            {
              name: orgName,
              slug: `${slug}-${randomUUID().slice(0, 6)}`,
              creatorUserId: user.id,
            },
            tx,
          );
        }
      }

      const userOrgs = await dbStore.getUserOrganizations(user.id, tx);
      const primaryOrg = userOrgs[0];

      const jti = randomUUID();
      const accessToken = signJwt(
        {
          sub: user.id,
          email: user.email,
          organizationId: primaryOrg?.org.id,
          role: primaryOrg?.role,
          jti,
        },
        900,
      );

      const rawRefreshToken = generateSecureToken('bsk_ref');
      const refreshHash = hashToken(rawRefreshToken);
      const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);

      await tx`
        INSERT INTO "refresh_tokens" ("token_hash", "user_id", "jti", "expires_at")
        VALUES (${refreshHash}, ${user.id}, ${jti}, ${expiresAt})
      `;

      const { passwordHash: _, ...userSafe } = user;
      return {
        user: userSafe,
        organizationId: primaryOrg?.org.id,
        organizations: userOrgs.map((o) => ({ id: o.org.id, name: o.org.name, role: o.role })),
        tokens: {
          accessToken,
          refreshToken: rawRefreshToken,
          expiresIn: 900,
        },
      };
    });
  }

  async verifyEmailToken(token: string): Promise<{ userId: string; verified: boolean }> {
    if (!token || typeof token !== 'string') {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Verification token is required');
    }

    const tokenTrimmed = token.trim();
    if (tokenTrimmed.length < 16) {
      throw new HttpException(400, 'INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or malformed');
    }

    const tokenHash = hashToken(tokenTrimmed);

    return withTransaction(async (tx) => {
      // Row-level lock on token record
      const rows = await tx`
        SELECT * FROM "email_verification_tokens"
        WHERE "token_hash" = ${tokenHash}
        FOR UPDATE
      `;
      const record = rows[0];

      if (!record || record.used_at !== null || new Date(record.expires_at) <= new Date()) {
        throw new HttpException(
          400,
          'INVALID_VERIFICATION_TOKEN',
          'Verification token is invalid, expired, or already used',
        );
      }

      // Mark token consumed atomically
      await tx`
        UPDATE "email_verification_tokens"
        SET "used_at" = NOW()
        WHERE "id" = ${record.id}
      `;

      // Update user verification status
      await tx`
        UPDATE "users"
        SET "is_email_verified" = true, "updated_at" = NOW()
        WHERE "id" = ${record.user_id}
      `;

      // Invalidate other pending verification tokens for this user
      await tx`
        UPDATE "email_verification_tokens"
        SET "expires_at" = NOW()
        WHERE "user_id" = ${record.user_id} AND "used_at" IS NULL AND "expires_at" > NOW()
      `;

      return {
        userId: record.user_id,
        verified: true,
      };
    });
  }

  async resendVerificationEmail(email: string, clientIp?: string): Promise<{ success: boolean; message: string }> {
    if (!email || typeof email !== 'string') {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email address is required');
    }

    const emailNorm = email.trim().toLowerCase();
    const rateLimitKey = `resend_ev_${emailNorm}_${clientIp || ''}`;
    // Limit to 3 resend attempts per 15 minutes per email/IP
    this.checkRateLimit(rateLimitKey, 3, 15 * 60 * 1000);

    const genericMsg = 'If an unverified account exists with that email address, a new verification link has been sent.';

    const user = await dbStore.findUserByEmail(emailNorm);
    // Non-enumerating: Return identical success message if user does not exist or is already verified
    if (!user || user.isEmailVerified || !user.isActive) {
      return { success: true, message: genericMsg };
    }

    // Invalidate existing unused tokens
    await dbStore.revokeUserVerificationTokens(user.id);

    // Generate fresh verification token
    const rawVerificationToken = generateSecureToken('bsk_ev', 32);
    const tokenHash = hashToken(rawVerificationToken);
    const expiryHours = parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_HOURS || '24', 10);
    const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000);

    await dbStore.createEmailVerificationToken({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    try {
      await this.emailService.sendVerificationEmail(user.email, user.fullName, rawVerificationToken);
    } catch (err) {
      console.error('[AuthService] Resend verification email failed:', err);
    }

    return { success: true, message: genericMsg };
  }

  async refreshToken(rawRefreshToken: string): Promise<AuthTokens> {
    if (!rawRefreshToken) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Refresh token is required');
    }

    const refreshHash = hashToken(rawRefreshToken);

    return withTransaction(async (tx) => {
      const tokenRows = await tx`
        SELECT * FROM "refresh_tokens"
        WHERE "token_hash" = ${refreshHash}
        FOR UPDATE
      `;
      const record = tokenRows[0];

      if (!record || record.revoked_at || new Date(record.expires_at) < new Date()) {
        throw new HttpException(401, 'INVALID_TOKEN', 'Refresh token is expired or invalid');
      }

      const userRows = await tx`SELECT * FROM "users" WHERE "id" = ${record.user_id} LIMIT 1`;
      const user = userRows[0] ? mapUserRow(userRows[0]) : null;
      if (!user || !user.isActive) {
        throw new HttpException(401, 'USER_INACTIVE', 'User account is not active');
      }

      // Revoke old refresh token (Rotation)
      await tx`
        UPDATE "refresh_tokens" SET "revoked_at" = NOW() WHERE "token_hash" = ${refreshHash}
      `;

      const userOrgs = await dbStore.getUserOrganizations(user.id, tx);
      const primaryOrg = userOrgs[0];

      const newJti = randomUUID();
      const newAccessToken = signJwt(
        {
          sub: user.id,
          email: user.email,
          organizationId: primaryOrg?.org.id,
          role: primaryOrg?.role,
          jti: newJti,
        },
        900,
      );

      const newRawRefreshToken = generateSecureToken('bsk_ref');
      const newRefreshHash = hashToken(newRawRefreshToken);
      const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);

      await tx`
        INSERT INTO "refresh_tokens" ("token_hash", "user_id", "jti", "expires_at")
        VALUES (${newRefreshHash}, ${user.id}, ${newJti}, ${expiresAt})
      `;

      return {
        accessToken: newAccessToken,
        refreshToken: newRawRefreshToken,
        expiresIn: 900,
      };
    });
  }

  async revokeSession(jti: string, userId?: string): Promise<void> {
    if (jti) {
      tokenBlacklist.add(jti);
      const expiresAt = new Date(Date.now() + 86400 * 1000);
      await sql`
        INSERT INTO "revoked_sessions" ("jti", "user_id", "expires_at", "revoked_at")
        VALUES (${jti}, ${userId ?? null}, ${expiresAt}, NOW())
        ON CONFLICT ("jti") DO NOTHING
      `;
    }
  }

  async verifyEmail(userId: string): Promise<void> {
    const rows = await sql`
      UPDATE "users"
      SET "is_email_verified" = true, "updated_at" = NOW()
      WHERE "id" = ${userId}
      RETURNING "id"
    `;
    if (rows.length === 0) {
      throw new HttpException(404, 'USER_NOT_FOUND', 'User not found');
    }
  }

  async getMe(userId: string): Promise<{
    user: Omit<UserRecord, 'passwordHash'>;
    organizations: { id: string; name: string; role: string; planTier: string }[];
  }> {
    const user = await dbStore.findUserById(userId);
    if (!user) {
      throw new HttpException(404, 'USER_NOT_FOUND', 'User not found');
    }
    const userOrgs = await dbStore.getUserOrganizations(user.id);
    const { passwordHash: _, ...userSafe } = user;
    return {
      user: userSafe,
      organizations: userOrgs.map((o) => ({
        id: o.org.id,
        name: o.org.name,
        role: o.role,
        planTier: o.org.planTier,
      })),
    };
  }
}

export const authService = new AuthService();
