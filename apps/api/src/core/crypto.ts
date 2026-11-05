import { createHmac, randomBytes, timingSafeEqual, scryptSync, createHash } from 'node:crypto';

export interface JwtPayload {
  sub: string;
  email?: string;
  organizationId?: string;
  role?: string;
  jti?: string;
  exp: number;
  iat: number;
}

const JWT_DEFAULT_SECRET = process.env.JWT_ACCESS_SECRET || 'brisksms_dev_jwt_access_secret_min_32_characters_long';

/**
 * Hash password securely using scrypt with random salt
 * Format: scrypt:salt:derivedKeyHex
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, 64);
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify password against hashed scrypt format
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return false;
    }
    const salt = parts[1]!;
    const originalDerivedKeyHex = parts[2]!;
    const derivedKey = scryptSync(password, salt, 64);
    const originalBuffer = Buffer.from(originalDerivedKeyHex, 'hex');

    if (derivedKey.length !== originalBuffer.length) {
      return false;
    }
    return timingSafeEqual(derivedKey, originalBuffer);
  } catch {
    return false;
  }
}

/**
 * Base64URL encode buffer or string
 */
export function base64UrlEncode(data: string | Buffer): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Base64URL decode to string
 */
export function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Issue a signed JWT token
 */
export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, expiresInSeconds: number = 900, secret: string = JWT_DEFAULT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();

  const encodedSignature = base64UrlEncode(signature);
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Verify and decode JWT token
 */
export function verifyJwt(token: string, secret: string = JWT_DEFAULT_SECRET): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    const expectedSignature = createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();

    const providedSignature = Buffer.from(encodedSignature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (providedSignature.length !== expectedSignature.length) return null;

    if (!timingSafeEqual(providedSignature, expectedSignature)) {
      return null;
    }

    const payload: JwtPayload = JSON.parse(base64UrlDecode(encodedPayload));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate cryptographically random token with prefix
 */
export function generateSecureToken(prefix: string, lengthBytes: number = 32): string {
  return `${prefix}_${randomBytes(lengthBytes).toString('hex')}`;
}

/**
 * Hash API Key or token for secure database storage
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}
