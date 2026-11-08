import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { INSECURE_DEFAULT_KEYS } from './crypto.js';

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  maxAge?: number; // seconds
  domain?: string;
  expires?: Date;
}

export interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

/**
 * Standard cookie configuration for BriskSMS web sessions
 */
export const SESSION_COOKIE_NAME = 'bsk_session';
export const REFRESH_COOKIE_NAME = 'bsk_refresh';
export const CSRF_COOKIE_NAME = 'bsk_csrf';

export const SESSION_COOKIE_MAX_AGE = 900; // 15 minutes (matches JWT access token)
export const REFRESH_COOKIE_MAX_AGE = 30 * 86400; // 30 days
export const CSRF_COOKIE_MAX_AGE = 86400; // 24 hours

export function getSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE,
  };
}

export function getRefreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    path: '/v1/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE,
  };
}

export function getCsrfCookieOptions(): CookieOptions {
  return {
    httpOnly: false, // Accessible to browser JavaScript to attach in X-CSRF-Token header
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: CSRF_COOKIE_MAX_AGE,
  };
}

export function getClearedCookieOptions(path: string = '/'): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path,
    maxAge: 0,
    expires: new Date(0),
  };
}

/**
 * Parses raw Cookie header string into key-value map
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return cookies;
  }

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }

  return cookies;
}

/**
 * Serializes a cookie name, value, and options into a Set-Cookie string
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts: string[] = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  } else {
    parts.push('Path=/');
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join('; ');
}

/**
 * Returns allowed web console frontend origins
 */
export function getAllowedOrigins(): Set<string> {
  const isProd = process.env.NODE_ENV === 'production';

  const rawEnvOrigins = [
    ...(process.env.ALLOWED_ORIGINS || '').split(','),
    ...(process.env.CORS_ORIGIN || '').split(','),
    process.env.FRONTEND_URL || '',
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  // Reject wildcard '*' - wildcard cannot be used with credentials or as an authorized origin
  const envOrigins = rawEnvOrigins.filter((origin) => origin !== '*' && origin !== 'null');

  // In production, require explicit configuration of allowed origins
  if (isProd) {
    return new Set(envOrigins);
  }

  const defaults = [
    'http://localhost:4200',
    'http://127.0.0.1:4200',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];

  return new Set([...defaults, ...envOrigins]);
}

/**
 * Validates whether an incoming Origin is an authorized frontend origin
 */
export function isAllowedOrigin(origin?: string): boolean {
  if (!origin || typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (trimmed === '*' || trimmed === 'null' || trimmed.length === 0) return false;
  const allowed = getAllowedOrigins();
  return allowed.has(trimmed);
}

/**
 * Resolves CSRF secret, failing closed in production if insecure, missing, or reusing other secrets.
 */
export function getCsrfSecret(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const rawSecret = process.env.CSRF_SECRET;

  if (isProd) {
    if (!rawSecret || rawSecret.trim().length === 0) {
      throw new Error('FATAL: CSRF_SECRET is required in production environment.');
    }
    const trimmed = rawSecret.trim();
    if (INSECURE_DEFAULT_KEYS.has(trimmed) || trimmed.length < 32) {
      throw new Error('FATAL: Insecure or insufficient-entropy CSRF_SECRET detected in production environment.');
    }
    // Independent key requirement: must not reuse access secret or encryption master key
    if (process.env.JWT_ACCESS_SECRET && trimmed === process.env.JWT_ACCESS_SECRET.trim()) {
      throw new Error('FATAL: CSRF_SECRET must be independently configured and not reuse JWT_ACCESS_SECRET.');
    }
    if (process.env.ENCRYPTION_MASTER_KEY && trimmed === process.env.ENCRYPTION_MASTER_KEY.trim()) {
      throw new Error('FATAL: CSRF_SECRET must be independently configured and not reuse ENCRYPTION_MASTER_KEY.');
    }
    return trimmed;
  }

  return rawSecret || 'brisksms_dev_csrf_secret_32_bytes_min!';
}

/**
 * Generates an HMAC-signed CSRF token with embedded timestamp.
 * Format: nonce.timestamp.signature
 */
export function generateCsrfToken(secret?: string): string {
  const activeSecret = secret || getCsrfSecret();
  const nonce = randomBytes(24).toString('hex');
  const expiresAt = Date.now() + CSRF_COOKIE_MAX_AGE * 1000;
  const payload = `${nonce}.${expiresAt}`;
  const signature = createHmac('sha256', activeSecret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

/**
 * Verifies that the submitted CSRF header matches the CSRF cookie and is cryptographically signed and non-expired.
 */
export function verifyCsrfToken(
  cookieToken?: string,
  headerToken?: string,
  secret?: string,
): boolean {
  if (!cookieToken || !headerToken) {
    return false;
  }
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') {
    return false;
  }
  // Enforce size bounds to prevent parsing/comparison DoS
  if (cookieToken.length > 512 || headerToken.length > 512 || cookieToken.length < 32) {
    return false;
  }

  // Tokens must match in constant time
  const cookieBuf = Buffer.from(cookieToken, 'utf-8');
  const headerBuf = Buffer.from(headerToken, 'utf-8');
  if (cookieBuf.length !== headerBuf.length || !timingSafeEqual(cookieBuf, headerBuf)) {
    return false;
  }

  const parts = cookieToken.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [nonce, expiresAtStr, signature] = parts;
  if (!nonce || !expiresAtStr || !signature) {
    return false;
  }

  // Validate nonce: exactly 48 hex characters (24 bytes)
  if (!/^[0-9a-f]{48}$/i.test(nonce)) {
    return false;
  }

  // Validate signature: exactly 64 hex characters (32 bytes HMAC-SHA256)
  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() > expiresAt) {
    return false; // Expired or invalid timestamp
  }

  const activeSecret = secret || getCsrfSecret();
  const payload = `${nonce}.${expiresAtStr}`;
  const expectedSig = createHmac('sha256', activeSecret).update(payload).digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false; // Signature mismatch
  }

  return true;
}
