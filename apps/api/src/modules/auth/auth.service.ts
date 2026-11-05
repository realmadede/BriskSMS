import { dbStore, UserRecord } from '../../core/store.js';
import { hashPassword, verifyPassword, signJwt, generateSecureToken, hashToken } from '../../core/crypto.js';
import { HttpException } from '../../core/http.js';
import { tokenBlacklist } from '../../core/guards.js';
import { randomUUID } from 'node:crypto';

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

export class AuthService {
  async register(dto: RegisterDto): Promise<{ user: Omit<UserRecord, 'passwordHash'>; organizationId?: string; tokens: AuthTokens }> {
    if (!dto.email || !dto.password || !dto.fullName) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email, password, and fullName are required');
    }

    if (dto.password.length < 8) {
      throw new HttpException(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters long');
    }

    const existingUser = dbStore.findUserByEmail(dto.email);
    if (existingUser) {
      throw new HttpException(409, 'EMAIL_EXISTS', 'A user with this email address is already registered');
    }

    const passwordHash = hashPassword(dto.password);
    const user = dbStore.createUser({
      email: dto.email,
      passwordHash,
      fullName: dto.fullName,
      phoneNumber: dto.phoneNumber,
    });

    // Optional default organization creation on signup
    let organizationId: string | undefined;
    let userRole: string | undefined;

    if (dto.organizationName) {
      const slug = dto.organizationName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const { org, membership } = dbStore.createOrganization({
        name: dto.organizationName,
        slug: `${slug}-${randomUUID().slice(0, 6)}`,
        creatorUserId: user.id,
      });
      organizationId = org.id;
      userRole = membership.role;
    }

    const jti = randomUUID();
    const accessToken = signJwt({
      sub: user.id,
      email: user.email,
      organizationId,
      role: userRole,
      jti,
    }, 900); // 15 mins

    const rawRefreshToken = generateSecureToken('bsk_ref');
    const refreshHash = hashToken(rawRefreshToken);
    dbStore.refreshTokens.set(refreshHash, {
      tokenHash: refreshHash,
      userId: user.id,
      jti,
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000), // 30 days
    });

    const { passwordHash: _, ...userSafe } = user;
    return {
      user: userSafe,
      organizationId,
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        expiresIn: 900,
      },
    };
  }

  async login(dto: LoginDto): Promise<{ user: Omit<UserRecord, 'passwordHash'>; organizations: { id: string; name: string; role: string }[]; tokens: AuthTokens }> {
    if (!dto.email || !dto.password) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Email and password are required');
    }

    const user = dbStore.findUserByEmail(dto.email);
    if (!user) {
      throw new HttpException(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const isMatch = verifyPassword(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new HttpException(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (!user.isActive) {
      throw new HttpException(403, 'ACCOUNT_DEACTIVATED', 'Your account has been deactivated. Please contact support.');
    }

    const userOrgs = dbStore.getUserOrganizations(user.id);
    const primaryOrg = userOrgs[0];

    const jti = randomUUID();
    const accessToken = signJwt({
      sub: user.id,
      email: user.email,
      organizationId: primaryOrg?.org.id,
      role: primaryOrg?.role,
      jti,
    }, 900);

    const rawRefreshToken = generateSecureToken('bsk_ref');
    const refreshHash = hashToken(rawRefreshToken);
    dbStore.refreshTokens.set(refreshHash, {
      tokenHash: refreshHash,
      userId: user.id,
      jti,
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
    });

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

  async refreshToken(rawRefreshToken: string): Promise<AuthTokens> {
    if (!rawRefreshToken) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Refresh token is required');
    }

    const refreshHash = hashToken(rawRefreshToken);
    const record = dbStore.refreshTokens.get(refreshHash);

    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new HttpException(401, 'INVALID_TOKEN', 'Refresh token is expired or invalid');
    }

    const user = dbStore.findUserById(record.userId);
    if (!user || !user.isActive) {
      throw new HttpException(401, 'USER_INACTIVE', 'User account is not active');
    }

    // Revoke old refresh token (Rotation)
    record.revokedAt = new Date();

    const userOrgs = dbStore.getUserOrganizations(user.id);
    const primaryOrg = userOrgs[0];

    const newJti = randomUUID();
    const newAccessToken = signJwt({
      sub: user.id,
      email: user.email,
      organizationId: primaryOrg?.org.id,
      role: primaryOrg?.role,
      jti: newJti,
    }, 900);

    const newRawRefreshToken = generateSecureToken('bsk_ref');
    const newRefreshHash = hashToken(newRawRefreshToken);
    dbStore.refreshTokens.set(newRefreshHash, {
      tokenHash: newRefreshHash,
      userId: user.id,
      jti: newJti,
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRawRefreshToken,
      expiresIn: 900,
    };
  }

  async revokeSession(jti: string): Promise<void> {
    if (jti) {
      tokenBlacklist.add(jti);
    }
  }

  async verifyEmail(userId: string): Promise<void> {
    const user = dbStore.findUserById(userId);
    if (!user) {
      throw new HttpException(404, 'USER_NOT_FOUND', 'User not found');
    }
    user.isEmailVerified = true;
    user.updatedAt = new Date();
  }

  async getMe(userId: string): Promise<{ user: Omit<UserRecord, 'passwordHash'>; organizations: { id: string; name: string; role: string; planTier: string }[] }> {
    const user = dbStore.findUserById(userId);
    if (!user) {
      throw new HttpException(404, 'USER_NOT_FOUND', 'User not found');
    }
    const userOrgs = dbStore.getUserOrganizations(user.id);
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
