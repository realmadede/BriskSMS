import { RouteRequest, HttpException } from './http.js';
import { verifyJwt } from './crypto.js';
import { UserRole } from '@brisksms/shared';

// In-memory token revocation blacklist (JTI -> expiration)
export const tokenBlacklist = new Set<string>();

/**
 * Extracts and verifies JWT from Authorization header
 */
export function authenticate(req: RouteRequest): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    throw new HttpException(401, 'UNAUTHORIZED', 'Missing Authorization header');
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new HttpException(401, 'UNAUTHORIZED', 'Invalid authorization format. Expected Bearer <token>');
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
