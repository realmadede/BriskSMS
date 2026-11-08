import { RouteRequest, HttpException } from './http.js';
import { hashToken, verifyJwt } from './crypto.js';
import { DeviceStatus, UserRole } from '@brisksms/shared';
import { sql } from '@brisksms/db';
import { DeviceRecord, mapDeviceRow } from './store.js';
import { timingSafeEqual } from 'node:crypto';
import {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  verifyCsrfToken,
  isAllowedOrigin,
} from './cookies.js';

// Fast in-process cache synchronized with PostgreSQL `revoked_sessions` table
export const tokenBlacklist = new Set<string>();

export async function isTokenRevoked(jti: string): Promise<boolean> {
  if (tokenBlacklist.has(jti)) return true;
  const rows = await sql<{ jti: string }>`
    SELECT "jti" FROM "revoked_sessions" WHERE "jti" = ${jti} AND "expires_at" > NOW() LIMIT 1
  `;
  if (rows.length > 0) {
    tokenBlacklist.add(jti);
    return true;
  }
  return false;
}

/**
 * Enforces CSRF validation for state-changing browser cookie requests.
 */
export function validateCsrf(req: RouteRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return;
  }

  // Verify Origin / Referer if present
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (origin && !isAllowedOrigin(origin)) {
    throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${origin}' is not authorized`);
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken =
    (typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined) ||
    (typeof req.headers['x-xsrf-token'] === 'string' ? req.headers['x-xsrf-token'] : undefined);

  if (!headerToken) {
    throw new HttpException(403, 'CSRF_TOKEN_MISSING', 'Missing required X-CSRF-Token header on state-changing request');
  }

  if (!cookieToken) {
    throw new HttpException(403, 'CSRF_COOKIE_MISSING', 'Missing required bsk_csrf cookie');
  }

  if (!verifyCsrfToken(cookieToken, headerToken)) {
    throw new HttpException(403, 'CSRF_TOKEN_INVALID', 'Invalid or expired CSRF token');
  }
}

/**
 * Extracts and verifies JWT from Authorization header or HttpOnly session cookie
 */
export function authenticate(req: RouteRequest): void {
  let token: string | undefined;
  let authType: 'bearer' | 'cookie' | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const [scheme, bearerToken] = authHeader.split(' ');
    if (scheme === 'Bearer' && bearerToken) {
      token = bearerToken;
      authType = 'bearer';
    } else {
      throw new HttpException(401, 'UNAUTHORIZED', 'Invalid authorization format. Expected Bearer <token>');
    }
  } else if (req.cookies && req.cookies[SESSION_COOKIE_NAME]) {
    token = req.cookies[SESSION_COOKIE_NAME];
    authType = 'cookie';
  }

  if (!token || !authType) {
    throw new HttpException(
      401,
      'UNAUTHORIZED',
      'Missing authentication credentials (Authorization header or session cookie)',
    );
  }

  const payload = verifyJwt(token);
  if (!payload) {
    throw new HttpException(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  if (payload.jti && tokenBlacklist.has(payload.jti)) {
    throw new HttpException(401, 'TOKEN_REVOKED', 'This session has been revoked');
  }

  req.context.userId = payload.sub;
  req.context.organizationId = payload.organizationId;
  req.context.role = payload.role;
  req.context.authType = authType;
  req.context.jti = payload.jti;

  // Enforce CSRF protection for cookie-authenticated browser requests
  if (authType === 'cookie') {
    validateCsrf(req);
  }
}

/**
 * Enforces that user is authenticated and has required role
 */
export function authorizeRole(req: RouteRequest, allowedRoles: UserRole[]): void {
  authenticate(req);

  const userRole = req.context.role as UserRole | undefined;
  if (!userRole) {
    throw new HttpException(403, 'FORBIDDEN', 'No role assigned in organization context');
  }

  if (!allowedRoles.includes(userRole)) {
    throw new HttpException(
      403,
      'INSUFFICIENT_PERMISSIONS',
      `Action requires one of the following roles: ${allowedRoles.join(', ')}`,
    );
  }
}

export interface AuthenticatedDeviceContext {
  deviceId: string;
  organizationId: string;
  device: DeviceRecord;
}

/**
 * Extracts and verifies device Bearer token from Authorization header.
 * Validates constant-time hash, ensures device is ACTIVE, verifies organization is ACTIVE,
 * and sets trusted req.context.deviceId and req.context.organizationId.
 * Strictly clears req.context.userId and req.context.role to prevent device auth from
 * being treated as human-user auth.
 */
export async function authenticateDevice(req: RouteRequest): Promise<AuthenticatedDeviceContext> {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    throw new HttpException(401, 'UNAUTHORIZED', 'Missing Authorization header with device token');
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new HttpException(401, 'UNAUTHORIZED', 'Invalid authorization format. Expected Bearer <deviceToken>');
  }

  if (!token.startsWith('bsk_dev_')) {
    throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Invalid device token format');
  }

  const tokenHash = hashToken(token);
  const rows = await sql<Record<string, any>>`
    SELECT * FROM "devices"
    WHERE "device_token_hash" = ${tokenHash}
    LIMIT 1
  `;

  if (rows.length === 0) {
    throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Device authentication failed: unknown device token');
  }

  const device = mapDeviceRow(rows[0]!);

  // Constant-time verification against stored token hash
  const computedHashBuf = Buffer.from(tokenHash, 'hex');
  const storedHashBuf = Buffer.from(device.deviceTokenHash, 'hex');
  if (computedHashBuf.length !== storedHashBuf.length || !timingSafeEqual(computedHashBuf, storedHashBuf)) {
    throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Device authentication failed: token hash verification failed');
  }

  if (device.status === DeviceStatus.REVOKED) {
    throw new HttpException(403, 'DEVICE_REVOKED', 'This device has been revoked and cannot perform operations');
  }

  if (device.status !== DeviceStatus.ACTIVE) {
    throw new HttpException(403, 'DEVICE_INACTIVE', `Device is not active (current status: ${device.status})`);
  }

  // Ensure organization exists and is active
  const orgRows = await sql<{ id: string; is_active: boolean }>`
    SELECT "id", "is_active" FROM "organizations"
    WHERE "id" = ${device.organizationId}
    LIMIT 1
  `;

  if (orgRows.length === 0 || !orgRows[0]?.is_active) {
    throw new HttpException(403, 'ORGANIZATION_INACTIVE', 'Device organization is inactive or not found');
  }

  // Establish trusted device context
  req.context.deviceId = device.id;
  req.context.organizationId = device.organizationId;
  req.context.userId = undefined;
  req.context.role = undefined;

  return {
    deviceId: device.id,
    organizationId: device.organizationId,
    device,
  };
}
