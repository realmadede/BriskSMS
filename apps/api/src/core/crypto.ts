import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  scryptSync,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';

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

/**
 * Resolves 32-byte key buffer for AES-256-GCM from ENCRYPTION_MASTER_KEY.
 * Fails closed if the master key is missing, empty, or unconfigured.
 */
function getMasterKeyBuffer(customKey?: string): Buffer {
  const rawKey = customKey || process.env.ENCRYPTION_MASTER_KEY;
  if (!rawKey || typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new Error('Encryption failed: ENCRYPTION_MASTER_KEY is not configured or empty');
  }
  const trimmed = rawKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

/**
 * Encrypts a secret at rest using AES-256-GCM.
 * Output format: "aes-256-gcm:ivHex:tagHex:cipherHex"
 */
export function encryptSecret(plaintext: string, masterKey?: string): string {
  if (plaintext === undefined || plaintext === null) {
    throw new Error('Plaintext secret cannot be null or undefined');
  }
  const key = getMasterKeyBuffer(masterKey);
  const iv = randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes-256-gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted secret.
 * Throws if tampering is detected, format is invalid, or master key is incorrect.
 */
export function decryptSecret(ciphertext: string, masterKey?: string): string {
  if (!ciphertext || typeof ciphertext !== 'string') {
    throw new Error('Ciphertext is required for decryption');
  }
  const key = getMasterKeyBuffer(masterKey);
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'aes-256-gcm') {
    throw new Error('Invalid ciphertext format for AES-256-GCM');
  }
  const iv = Buffer.from(parts[1]!, 'hex');
  const tag = Buffer.from(parts[2]!, 'hex');
  const encrypted = Buffer.from(parts[3]!, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Checks whether a given string is formatted as an AES-256-GCM encrypted secret.
 */
export function isEncryptedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'aes-256-gcm' && parts[1]!.length === 24 && parts[2]!.length === 32;
}
