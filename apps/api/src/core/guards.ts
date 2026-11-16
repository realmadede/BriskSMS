import { RouteRequest, HttpException } from './http.js';
import { hashToken, verifyJwt } from './crypto.js';
import { ApiKeyScope, DeviceStatus, UserRole } from '@brisksms/shared';
import { sql, redisClient } from '@brisksms/db';
import { dbStore, DeviceRecord, mapDeviceRow } from './store.js';
import { OAuthService } from '../modules/oauth/oauth.service.js';
import { timingSafeEqual } from 'node:crypto';
import {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  verifyCsrfToken,
  isAllowedOrigin,
} from './cookies.js';

const oauthGuardService = new OAuthService();

// Fast in-process cache synchronized with PostgreSQL `revoked_sessions` table and Redis
export const tokenBlacklist = new Set<string>();
const syncedBlacklists = new WeakSet<Set<string>>();
const activeSyncPromises = new WeakMap<Set<string>, Promise<number>>();

export let isRevocationSyncReady = false;

export function isRevocationReady(targetBlacklist: Set<string> = tokenBlacklist): boolean {
  return syncedBlacklists.has(targetBlacklist);
}

export function setRevocationSyncReady(ready: boolean): void {
  isRevocationSyncReady = ready;
  if (ready) {
    syncedBlacklists.add(tokenBlacklist);
  } else {
    syncedBlacklists.delete(tokenBlacklist);
  }
}

export async function syncTokenBlacklistFromDb(targetBlacklist: Set<string> = tokenBlacklist): Promise<number> {
  const rows = await sql<{ jti: string }>`
    SELECT "jti" FROM "revoked_sessions" WHERE "expires_at" > NOW()
  `;
  for (const row of rows) {
    targetBlacklist.add(row.jti);
  }
  try {
    if (rows.length > 0) {
      await Promise.all(
        rows.map((row) =>
          redisClient.set(`auth:revoked_jti:${row.jti}`, '1', 86400).catch(() => {})
        ),
      );
    }
    await redisClient.set('auth:revocation_sync_marker', '1', 86400).catch(() => {});
  } catch {
    // Redis best-effort during database sync
  }
  syncedBlacklists.add(targetBlacklist);
  if (targetBlacklist === tokenBlacklist) {
    isRevocationSyncReady = true;
  }
  return rows.length;
}

export async function ensureRevocationSync(targetBlacklist: Set<string> = tokenBlacklist): Promise<void> {
  if (syncedBlacklists.has(targetBlacklist)) return;
  let pending = activeSyncPromises.get(targetBlacklist);
  if (!pending) {
    pending = syncTokenBlacklistFromDb(targetBlacklist).finally(() => {
      activeSyncPromises.delete(targetBlacklist);
    });
    activeSyncPromises.set(targetBlacklist, pending);
  }
  await pending;
}

export async function isTokenRevoked(
  jti: string,
  targetBlacklist: Set<string> = tokenBlacklist,
): Promise<boolean> {
  // 1. In-process cache check ($O(1)$)
  if (targetBlacklist.has(jti)) {
    return true;
  }

  // 2. Shared Redis lookup
  try {
    const [revokedVal, syncMarker] = await redisClient.mget(
      `auth:revoked_jti:${jti}`,
      'auth:revocation_sync_marker',
    );

    if (revokedVal) {
      targetBlacklist.add(jti);
      return true;
    }

    if (syncMarker) {
      return false;
    }

    // Sync marker is missing: Redis was restarted or flushed.
    // Resynchronize from durable PostgreSQL!
    await syncTokenBlacklistFromDb(targetBlacklist);
    if (targetBlacklist.has(jti)) {
      return true;
    }

    const checkAfter = await redisClient.get(`auth:revoked_jti:${jti}`);
    if (checkAfter) {
      targetBlacklist.add(jti);
      return true;
    }
    return false;
  } catch (err) {
    if (err instanceof HttpException) throw err;
    // 3. Fallback to PostgreSQL when Redis is unavailable or disconnected
    const rows = await sql<{ jti: string }>`
      SELECT "jti" FROM "revoked_sessions"
      WHERE "jti" = ${jti} AND "expires_at" > NOW()
      LIMIT 1
    `;
    if (rows.length > 0) {
      targetBlacklist.add(jti);
      return true;
    }
    return false;
  }
}

/**
 * Enforces CSRF validation for state-changing browser cookie requests.
 */
export function validateCsrf(req: RouteRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return;
  }

  // Fetch Metadata defense: reject explicit cross-site mutating requests from browsers
  const fetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined;
  if (fetchSite === 'cross-site') {
    throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
  }

  // Verify Origin / Referer if present
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (origin && !isAllowedOrigin(origin)) {
    throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${origin}' is not authorized`);
  }

  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
  if (!origin && referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (!isAllowedOrigin(refOrigin)) {
        throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Referer origin '${refOrigin}' is not authorized`);
      }
    } catch {
      throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', 'Malformed Referer header');
    }
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
export async function authenticate(req: RouteRequest): Promise<void> {
  const effectiveBlacklist = req.tokenBlacklist ?? tokenBlacklist;

  // Ensure initial synchronization has run before processing authenticated traffic
  await ensureRevocationSync(effectiveBlacklist);

  // If an Origin header is provided by a browser, verify that the origin is authorized
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (origin && !isAllowedOrigin(origin)) {
    throw new HttpException(403, 'CSRF_ORIGIN_MISMATCH', `Request origin '${origin}' is not authorized`);
  }

  const fetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined;
  if (fetchSite === 'cross-site') {
    throw new HttpException(403, 'CSRF_CROSS_SITE_FORBIDDEN', 'Cross-site request blocked by Fetch Metadata policy');
  }

  let token: string | undefined;
  let authType: 'bearer' | 'cookie' | 'oauth' | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const [scheme, bearerToken] = authHeader.split(' ');
    if (scheme === 'Bearer' && bearerToken) {
      token = bearerToken;
      authType = bearerToken.startsWith('bsk_at_') ? 'oauth' : 'bearer';
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

  if (authType === 'oauth') {
    const verifiedOAuth = await oauthGuardService.verifyAccessToken(token);
    if (!verifiedOAuth) {
      throw new HttpException(401, 'UNAUTHORIZED', 'Invalid or expired OAuth access token');
    }
    const user = await dbStore.findUserById(verifiedOAuth.userId);
    if (!user || !user.isActive) {
      throw new HttpException(401, 'ACCOUNT_DEACTIVATED', 'Account is deactivated or not found');
    }
    const membership = await dbStore.getMembership(verifiedOAuth.organizationId, verifiedOAuth.userId);
    if (!membership) {
      throw new HttpException(403, 'FORBIDDEN', 'Organization membership is no longer active');
    }
    req.context.userId = verifiedOAuth.userId;
    req.context.organizationId = verifiedOAuth.organizationId;
    req.context.role = membership.role;
    req.context.authType = 'oauth';
    req.context.oauthScopes = verifiedOAuth.scopes;
    return;
  }

  const payload = verifyJwt(token);
  if (!payload) {
    throw new HttpException(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  if (payload.jti && (await isTokenRevoked(payload.jti, effectiveBlacklist))) {
    throw new HttpException(401, 'TOKEN_REVOKED', 'This session has been revoked');
  }

  const user = await dbStore.findUserById(payload.sub);
  if (!user || !user.isActive) {
    throw new HttpException(401, 'ACCOUNT_DEACTIVATED', 'Account is deactivated or not found');
  }

  let effectiveRole = payload.role;
  if (payload.organizationId) {
    const membership = await dbStore.getMembership(payload.organizationId, payload.sub);
    if (!membership) {
      throw new HttpException(403, 'FORBIDDEN', 'Organization membership is no longer active');
    }
    effectiveRole = membership.role;
  }

  req.context.userId = payload.sub;
  req.context.organizationId = payload.organizationId;
  req.context.role = effectiveRole;
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
export async function authorizeRole(req: RouteRequest, allowedRoles: UserRole[]): Promise<void> {
  await authenticate(req);

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

/**
 * Blocks OAuth third-party access tokens from human/interactive-only administration,
 * organization switching, key management, and credential provisioning endpoints.
 */
export function assertHumanSessionAuth(req: RouteRequest, actionDescription = 'this operation'): void {
  if (req.context.authType === 'oauth') {
    throw new HttpException(
      403,
      'OAUTH_FORBIDDEN',
      `OAuth access tokens cannot perform ${actionDescription}; interactive session authentication is required`,
    );
  }
}

/**
 * Enforces explicit OAuth token scopes when `req.context.authType === 'oauth'`.
 */
export function assertOAuthScope(req: RouteRequest, requiredScopes: ApiKeyScope[]): void {
  if (req.context.authType !== 'oauth') {
    return;
  }
  const granted = req.context.oauthScopes ?? [];
  const hasScope = requiredScopes.some((scope) => granted.includes(scope));
  if (!hasScope) {
    throw new HttpException(
      403,
      'INSUFFICIENT_SCOPE',
      `Forbidden: OAuth token requires at least one of the following scopes: ${requiredScopes.join(', ')}`,
    );
  }
}

/**
 * Resolves the target organizationId while enforcing strict binding to `req.context.organizationId`
 * whenever the authenticated token/session is scoped to an organization.
 */
export function resolveAuthorizedTenantOrgId(
  req: RouteRequest,
  suppliedOrgId?: unknown,
): string {
  const requestedOrgId = typeof suppliedOrgId === 'string' ? suppliedOrgId.trim() : '';
  const contextOrgId = req.context.organizationId;

  if (contextOrgId && requestedOrgId && requestedOrgId !== contextOrgId) {
    throw new HttpException(
      403,
      'CROSS_ORGANIZATION_FORBIDDEN',
      'Cannot specify an organizationId outside the authenticated organization context',
    );
  }

  const resolvedOrgId = requestedOrgId || contextOrgId || '';
  if (!resolvedOrgId) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
  }
  return resolvedOrgId;
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
