import { RouteRequest } from '../../core/http.js';
import { dbStore } from '../../core/store.js';
import { extractClientIp } from '../auth/auth.controller.js';

/** Writes the platform audit entry for an action taken from /nexus. Call it after the action succeeds. */
export function auditPlatformAction(
  req: RouteRequest,
  action: string,
  target: {
    type: string;
    id: string;
    organizationId?: string;
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
  },
): Promise<void> {
  const reason = (req.body as { reason?: unknown } | undefined)?.reason;
  return dbStore.recordPlatformAudit({
    adminUserId: req.context.userId!,
    ipAddress: extractClientIp(req),
    action,
    targetType: target.type,
    targetId: target.id,
    targetOrganizationId: target.organizationId,
    reason: typeof reason === 'string' ? reason.trim().slice(0, 500) || null : null,
    previousState: target.previousState,
    newState: target.newState,
  });
}
