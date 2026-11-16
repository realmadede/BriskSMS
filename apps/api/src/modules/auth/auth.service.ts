import { dbStore, UserRecord, mapUserRow } from '../../core/store.js';
import { hashPassword, verifyPassword, signJwt, generateSecureToken, hashToken } from '../../core/crypto.js';
import { HttpException } from '../../core/http.js';
import { tokenBlacklist } from '../../core/guards.js';
import { sql, withTransaction, redisClient, isSimulatedRedisOutage, RedisUnavailableError } from '@brisksms/db';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { GoogleTokenVerifier, googleTokenVerifier } from './providers/google.provider.js';
import { EmailService, emailService } from './services/email.service.js';
import { getGoogleNonceTtl } from '../../core/cookies.js';

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

interface GoogleNonceRecord {
  expiresAt: number;
  clientIp?: string;
}

export class AuthService {
  private googleVerifier: GoogleTokenVerifier = googleTokenVerifier;
  private emailService: EmailService = emailService;
  private rateLimitBuckets = new Map<string, RateLimitBucket>();
  private googleNonceStore = new Map<string, GoogleNonceRecord>();

  setGoogleVerifier(verifier: GoogleTokenVerifier): void {
    this.googleVerifier = verifier;
  }

  setEmailService(service: EmailService): void {
    this.emailService = service;
  }

  async clearRateLimits(): Promise<void> {
    this.rateLimitBuckets.clear();
    await this.clearGoogleNonces();
    try {
      if (!isSimulatedRedisOutage()) {
        const keys = await redisClient.keys('ratelimit:auth:*');
        for (const k of keys) {
          await redisClient.del(k);
        }
      }
    } catch {
      // Ignore cleanup error if Redis unavailable in tests
    }
  }

  async clearGoogleNonces(): Promise<void> {
    this.googleNonceStore.clear();
    try {
      if (!isSimulatedRedisOutage()) {
        const keys = await redisClient.keys('auth:google_nonce:*');
        for (const k of keys) {
          await redisClient.del(k);
        }
      }
    } catch {
      // Ignore cleanup error if Redis unavailable in tests
    }
  }

  async createGoogleNonce(clientIp?: string): Promise<{
    nonce: string;
    nonceHash: string;
    expiresIn: number;
  }> {
    const rawNonce = generateSecureToken('bsk_gn', 32);
    const nonceHash = hashToken(rawNonce);
    const ttlSec = getGoogleNonceTtl();
    const expiresAt = Date.now() + ttlSec * 1000;
    const isProdOrStaging = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

    try {
      if (!isSimulatedRedisOutage()) {
        await redisClient.set(
          `auth:google_nonce:${nonceHash}`,
          JSON.stringify({ ip: clientIp, createdAt: Date.now() }),
          ttlSec,
        );
      }
    } catch (err) {
      if (isProdOrStaging) {
        throw new RedisUnavailableError('Google nonce store is unavailable in production.', err);
      }
    }

    // Always register in memory fallback for dev/test resilience
    this.googleNonceStore.set(nonceHash, { expiresAt, clientIp });

    return {
      nonce: rawNonce,
      nonceHash,
      expiresIn: ttlSec,
    };
  }

  async consumeGoogleNonce(nonceHash: string): Promise<boolean> {
    const isProdOrStaging = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

    try {
      if (!isSimulatedRedisOutage()) {
        const deleted = await redisClient.del(`auth:google_nonce:${nonceHash}`);
        if (deleted > 0) {
          this.googleNonceStore.delete(nonceHash);
          return true;
        }
        return false;
      }
    } catch (err) {
      if (isProdOrStaging) {
        throw new RedisUnavailableError('Google nonce store is unavailable in production.', err);
      }
    }

    const record = this.googleNonceStore.get(nonceHash);
    if (!record) return false;
    if (record.expiresAt <= Date.now()) {
      this.googleNonceStore.delete(nonceHash);
      return false;
    }
    this.googleNonceStore.delete(nonceHash);
    return true;
  }

  async checkRateLimit(key: string, maxAttempts: number, windowMs: number): Promise<void> {
    const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
    const redisKey = `ratelimit:auth:${key}`;
    const isProdOrStaging = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

    try {
      const count = await redisClient.incrWithExpire(redisKey, windowSec);
      if (count > maxAttempts) {
        throw new HttpException(429, 'TOO_MANY_REQUESTS', 'Rate limit exceeded. Please try again later.');
      }
      return;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // In production and staging, fail closed to protect distributed authentication security
      if (isProdOrStaging) {
        throw new RedisUnavailableError('Rate limiting broker is unavailable in production.', err);
      }
      // Fallback to in-memory only in development or test environments
    }

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

    const emailNorm = dto.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm) || emailNorm.length > 255) {
      throw new HttpException(400, 'INVALID_EMAIL', 'A valid email address is required');
    }

    if (dto.password.length < 8) {
      throw new HttpException(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters long');
    }
    if (dto.password.length > 256) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Password must not exceed 256 characters');
    }

    const existingUser = await dbStore.findUserByEmail(emailNorm);
    if (existingUser) {
      throw new HttpException(409, 'EMAIL_EXISTS', 'A user with this email address is already registered');
    }

    const passwordHash = hashPassword(dto.password);

    const txResult = await withTransaction(async (tx) => {
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
      const familyId = randomUUID();
      const refreshExpiresAt = new Date(Date.now() + 30 * 86400 * 1000);

      await tx`
        INSERT INTO "refresh_tokens" ("token_hash", "user_id", "family_id", "jti", "expires_at")
        VALUES (${refreshHash}, ${user.id}, ${familyId}, ${jti}, ${refreshExpiresAt})
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

      const { passwordHash: _, ...userSafe } = user;
      return {
        userSafe,
        userEmail: user.email,
        userFullName: user.fullName,
        rawVerificationToken,
        organizationId,
        tokens: {
          accessToken,
          refreshToken: rawRefreshToken,
          expiresIn: 900,
        },
      };
    });

    // 3. Dispatch verification email via Resend AFTER transaction is safely committed
    let verificationEmailSent = false;
    try {
      const dispatchRes = await this.emailService.sendVerificationEmail(
        txResult.userEmail,
        txResult.userFullName,
        txResult.rawVerificationToken,
      );
      verificationEmailSent = dispatchRes.success;
    } catch (emailErr) {
      console.error('[AuthService] Verification email delivery error:', emailErr);
    }

    return {
      user: txResult.userSafe,
      organizationId: txResult.organizationId,
      tokens: txResult.tokens,
      verificationEmailSent,
    };
  }

  async login(dto: LoginDto): Promise<{
    user: Omit<UserRecord, 'passwordHash'>;
    organizations: { id: string; name: string; role: string }[];
    tokens: AuthTokens;
  }> {
    if (!dto.email || !dto.password) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email and password are required');
    }
    if (dto.password.length > 256) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Password exceeds maximum permitted length');
    }

    const emailNorm = dto.email.trim().toLowerCase();
    const user = await dbStore.findUserByEmail(emailNorm);
    if (!user) {
      throw new HttpException(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (!user.passwordHash) {
      throw new HttpException(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
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
    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);

    await sql`
      INSERT INTO "refresh_tokens" ("token_hash", "user_id", "family_id", "jti", "expires_at")
      VALUES (${refreshHash}, ${user.id}, ${familyId}, ${jti}, ${expiresAt})
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

  async loginWithGoogle(
    idToken: string,
    clientIp?: string,
    expectedNonceHash?: string,
  ): Promise<{
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
      await this.checkRateLimit(`google_auth_${clientIp}`, 10, 60_000);
    }

    const isProdOrStaging = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
    if (!expectedNonceHash && isProdOrStaging) {
      throw new HttpException(401, 'INVALID_GOOGLE_NONCE', 'Authentication nonce is required in production');
    }

    if (expectedNonceHash) {
      if (!/^[0-9a-f]{64}$/i.test(expectedNonceHash)) {
        throw new HttpException(401, 'INVALID_GOOGLE_NONCE', 'Authentication nonce format is invalid');
      }
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

    // Validate nonce claim and atomically consume nonce
    if (expectedNonceHash) {
      if (!payload.nonce || typeof payload.nonce !== 'string') {
        throw new HttpException(401, 'INVALID_GOOGLE_NONCE', 'Google ID token is missing required nonce claim');
      }

      const tokenNonceHash = hashToken(payload.nonce);
      const h1 = Buffer.from(tokenNonceHash, 'hex');
      const h2 = Buffer.from(expectedNonceHash, 'hex');
      if (h1.length !== h2.length || !timingSafeEqual(h1, h2)) {
        throw new HttpException(401, 'INVALID_GOOGLE_NONCE', 'Google ID token nonce does not match browser session nonce');
      }

      const consumed = await this.consumeGoogleNonce(expectedNonceHash);
      if (!consumed) {
        throw new HttpException(401, 'INVALID_GOOGLE_NONCE', 'Authentication nonce has already been consumed or expired');
      }
    }

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await withTransaction(async (tx) => {
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
              if (existingEmailUser.googleId && existingEmailUser.googleId !== payload.sub) {
                throw new HttpException(
                  409,
                  'GOOGLE_ACCOUNT_CONFLICT',
                  'This email address is already linked to a different Google account.',
                );
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
          const familyId = randomUUID();
          const expiresAt = new Date(Date.now() + 30 * 86400 * 1000);

          await tx`
            INSERT INTO "refresh_tokens" ("token_hash", "user_id", "family_id", "jti", "expires_at")
            VALUES (${refreshHash}, ${user.id}, ${familyId}, ${jti}, ${expiresAt})
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
      } catch (err: any) {
        if (attempt < maxAttempts && (err?.code === '23505' || String(err).includes('unique'))) {
          // Retry under concurrency conflict with a fresh transaction
          continue;
        }
        throw err;
      }
    }
    throw new HttpException(500, 'INTERNAL_SERVER_ERROR', 'Google login transaction failed');
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
    const genericMsg = 'If an unverified account exists with that email address, a new verification link has been sent.';

    // 1. IP-level rate limit: max 5 resend requests per 15 minutes per IP
    if (clientIp) {
      await this.checkRateLimit(`resend_ip_${clientIp}`, 5, 15 * 60 * 1000);
    }

    // 2. Recipient-level rate limit: max 3 resend requests per 15 minutes per recipient
    // Uses a privacy-preserving SHA-256 hash so raw email addresses are never stored in Redis keys
    const recipientHash = createHash('sha256').update(`resend_recipient:${emailNorm}`).digest('hex').slice(0, 32);
    await this.checkRateLimit(`resend_target_${recipientHash}`, 3, 15 * 60 * 1000);

    // 3. Email syntax validation: return generic success for invalid email without leaking account existence
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailNorm)) {
      return { success: true, message: genericMsg };
    }

    const user = await dbStore.findUserByEmail(emailNorm);
    // Non-enumerating: Return identical success message if user does not exist or is already verified
    if (!user || user.isEmailVerified || !user.isActive) {
      return { success: true, message: genericMsg };
    }

    // Generate fresh verification token
    const rawVerificationToken = generateSecureToken('bsk_ev', 32);
    const tokenHash = hashToken(rawVerificationToken);
    const expiryHours = parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_HOURS || '24', 10);
    const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000);

    // Invalidate existing unused tokens and persist new token atomically
    await withTransaction(async (tx) => {
      await dbStore.revokeUserVerificationTokens(user.id, tx);
      await dbStore.createEmailVerificationToken(
        {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
        tx,
      );
    });

    // Dispatch email AFTER transaction commits
    try {
      await this.emailService.sendVerificationEmail(user.email, user.fullName, rawVerificationToken);
    } catch (err) {
      console.error('[AuthService] Resend verification email failed:', err);
    }

    return { success: true, message: genericMsg };
  }

  async revokeFamily(familyId: string, localBlacklist: Set<string> = tokenBlacklist): Promise<string[]> {
    if (!familyId) return [];

    // 1. Durably revoke all active refresh tokens in the family in PostgreSQL
    await sql`
      UPDATE "refresh_tokens"
      SET "revoked_at" = NOW()
      WHERE "family_id" = ${familyId}
        AND "revoked_at" IS NULL
    `;

    // 2. Query all access token JTIs issued in this family
    const familyTokens = await sql<{ jti: string; user_id: string }>`
      SELECT "jti", "user_id"
      FROM "refresh_tokens"
      WHERE "family_id" = ${familyId}
        AND "jti" IS NOT NULL
    `;

    const jtis = familyTokens.map((t) => t.jti).filter(Boolean);
    if (jtis.length === 0) return [];

    // 3. Durably persist revoked JTIs in PostgreSQL
    await sql`
      INSERT INTO "revoked_sessions" ("jti", "user_id", "expires_at", "revoked_at")
      SELECT "jti", "user_id", NOW() + INTERVAL '1 day', NOW()
      FROM "refresh_tokens"
      WHERE "family_id" = ${familyId}
        AND "jti" IS NOT NULL
      ON CONFLICT ("jti") DO UPDATE SET "revoked_at" = NOW()
    `;

    // 4. Update in-process cache
    for (const jti of jtis) {
      localBlacklist.add(jti);
    }

    // 5. Populate shared Redis store with 24h TTL (86,400s)
    try {
      await Promise.all(
        jtis.map((jti) => redisClient.set(`auth:revoked_jti:${jti}`, '1', 86400).catch(() => {}))
      );
    } catch {
      // Redis write failure does not rollback PostgreSQL durable record
    }

    return jtis;
  }

  async refreshToken(rawRefreshToken: string, localBlacklist: Set<string> = tokenBlacklist): Promise<AuthTokens> {
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

      if (!record) {
        throw new HttpException(401, 'INVALID_TOKEN', 'Refresh token is expired or invalid');
      }

      // Replay Detection: If the token was already consumed or revoked, revoke its entire family!
      if (record.revoked_at) {
        await this.revokeFamily(record.family_id, localBlacklist);
        throw new HttpException(401, 'INVALID_TOKEN', 'Refresh token is expired or invalid (consumed; entire session family revoked)');
      }

      if (new Date(record.expires_at) < new Date()) {
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

      // Child token inherits the exact same family_id
      await tx`
        INSERT INTO "refresh_tokens" ("token_hash", "user_id", "family_id", "jti", "expires_at")
        VALUES (${newRefreshHash}, ${user.id}, ${record.family_id}, ${newJti}, ${expiresAt})
      `;

      return {
        accessToken: newAccessToken,
        refreshToken: newRawRefreshToken,
        expiresIn: 900,
      };
    });
  }

  async revokeSession(jti: string, userId?: string, localBlacklist: Set<string> = tokenBlacklist): Promise<void> {
    if (jti) {
      localBlacklist.add(jti);
      const expiresAt = new Date(Date.now() + 86400 * 1000);
      await sql`
        INSERT INTO "revoked_sessions" ("jti", "user_id", "expires_at", "revoked_at")
        VALUES (${jti}, ${userId ?? null}, ${expiresAt}, NOW())
        ON CONFLICT ("jti") DO UPDATE SET "revoked_at" = NOW()
      `;

      try {
        await redisClient.set(`auth:revoked_jti:${jti}`, '1', 86400);
      } catch {
        // Redis best-effort
      }

      // Find the family_id bound to this jti
      const familyRows = await sql<{ family_id: string }>`
        SELECT "family_id" FROM "refresh_tokens" WHERE "jti" = ${jti} LIMIT 1
      `;
      const familyId = familyRows[0]?.family_id;

      if (familyId) {
        await this.revokeFamily(familyId, localBlacklist);
      }
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
