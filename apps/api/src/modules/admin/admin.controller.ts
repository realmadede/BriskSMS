import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate, assertPlatformAdmin } from '../../core/guards.js';
import { dbStore } from '../../core/store.js';
import { adminService } from './admin.service.js';
import { auditPlatformAction } from './platform-audit.js';
import { creditPackService, CreditPackInput } from '../messaging/credit-pack.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idParam(req: RouteRequest, name: string): string {
  const value = req.params[name] ?? '';
  if (!UUID.test(value)) {
    throw new HttpException(400, 'VALIDATION_ERROR', `${name} must be an id`);
  }
  return value;
}

async function adminOnly(req: RouteRequest): Promise<string> {
  await authenticate(req);
  assertPlatformAdmin(req);
  return req.context.userId!;
}

function packInput(req: RouteRequest): CreditPackInput {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const amount = typeof b.amountCents === 'string' || typeof b.amountCents === 'number' ? String(b.amountCents) : '';
  if (typeof b.code !== 'string' || typeof b.name !== 'string' || typeof b.currency !== 'string' || !/^[0-9]{1,15}$/.test(amount)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'code, name, currency and a whole-number amountCents are required');
  }
  return {
    code: b.code.trim().toUpperCase(),
    name: b.name,
    credits: Number(b.credits),
    currency: b.currency.trim().toUpperCase(),
    amountCents: BigInt(amount),
    isActive: typeof b.isActive === 'boolean' ? b.isActive : undefined,
    sortOrder: Number.isInteger(b.sortOrder) ? (b.sortOrder as number) : undefined,
  };
}

export function registerAdminRoutes(router: Router): void {
  // Credit packs customers can buy (Platform Admin Only)
  router.get('/v1/admin/credit-packs', async (req: RouteRequest): Promise<ApiResponse> => {
    await adminOnly(req);
    return { success: true, data: { packs: await creditPackService.list(false) } };
  });

  router.post('/v1/admin/credit-packs', async (req: RouteRequest): Promise<ApiResponse> => {
    await adminOnly(req);
    const pack = await creditPackService.create(packInput(req));
    await auditPlatformAction(req, 'CREDIT_PACK_CREATED', { type: 'CREDIT_PACK', id: pack.id, newState: { ...pack } });
    return { success: true, data: { pack } };
  });

  router.put('/v1/admin/credit-packs/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    await adminOnly(req);
    const { before, after } = await creditPackService.update(idParam(req, 'id'), packInput(req));
    await auditPlatformAction(req, 'CREDIT_PACK_CHANGED', {
      type: 'CREDIT_PACK',
      id: after.id,
      previousState: { ...before },
      newState: { ...after },
    });
    return { success: true, data: { pack: after } };
  });

  // Platform audit trail: every action taken from /nexus (Platform Admin Only)
  router.get('/v1/admin/audit', async (req: RouteRequest): Promise<ApiResponse> => {
    await adminOnly(req);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '', 10) || 50, 1), 200);
    const action = req.query.action?.trim() || undefined;
    return { success: true, data: { entries: await dbStore.listPlatformAudit({ limit, action }) } };
  });

  // Tenant directory
  router.get('/v1/admin/organizations', async (req: RouteRequest): Promise<ApiResponse> => {
    await adminOnly(req);
    const status = req.query.status === 'active' || req.query.status === 'suspended' ? req.query.status : undefined;
    const data = await adminService.listMerchants({
      search: req.query.q,
      status,
      limit: Number.parseInt(req.query.limit ?? '', 10),
      offset: Number.parseInt(req.query.offset ?? '', 10),
    });
    return { success: true, data };
  });

  router.get('/v1/admin/organizations/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    await adminOnly(req);
    return { success: true, data: await adminService.getMerchant(idParam(req, 'id')) };
  });

  // Kill switches. Each needs a reason and writes the customer's audit log and the platform audit log.
  router.post('/v1/admin/organizations/:id/suspend', async (req: RouteRequest): Promise<ApiResponse> => {
    const adminId = await adminOnly(req);
    const orgId = idParam(req, 'id');
    const merchant = await adminService.setMerchantActive(orgId, false, adminId, req.body?.reason);
    await auditPlatformAction(req, 'ORGANIZATION_SUSPENDED', {
      type: 'ORGANIZATION', id: orgId, organizationId: orgId,
      previousState: { isActive: true }, newState: { isActive: false },
    });
    return { success: true, data: { merchant } };
  });

  router.post('/v1/admin/organizations/:id/reactivate', async (req: RouteRequest): Promise<ApiResponse> => {
    const adminId = await adminOnly(req);
    const orgId = idParam(req, 'id');
    const merchant = await adminService.setMerchantActive(orgId, true, adminId, req.body?.reason);
    await auditPlatformAction(req, 'ORGANIZATION_REACTIVATED', {
      type: 'ORGANIZATION', id: orgId, organizationId: orgId,
      previousState: { isActive: false }, newState: { isActive: true },
    });
    return { success: true, data: { merchant } };
  });

  router.post('/v1/admin/organizations/:id/api-keys/:keyId/revoke', async (req: RouteRequest): Promise<ApiResponse> => {
    const adminId = await adminOnly(req);
    const orgId = idParam(req, 'id');
    const keyId = idParam(req, 'keyId');
    const data = await adminService.revokeMerchantApiKey(orgId, keyId, adminId, req.body?.reason);
    await auditPlatformAction(req, 'API_KEY_REVOKED', { type: 'API_KEY', id: keyId, organizationId: orgId });
    return { success: true, data };
  });

  router.post('/v1/admin/organizations/:id/devices/:deviceId/quarantine', async (req: RouteRequest): Promise<ApiResponse> => {
    const adminId = await adminOnly(req);
    const orgId = idParam(req, 'id');
    const deviceId = idParam(req, 'deviceId');
    const data = await adminService.setDeviceQuarantine(orgId, deviceId, true, adminId, req.body?.reason);
    await auditPlatformAction(req, 'DEVICE_QUARANTINED', {
      type: 'DEVICE', id: deviceId, organizationId: orgId,
      previousState: { status: 'ACTIVE' }, newState: { status: 'QUARANTINED' },
    });
    return { success: true, data };
  });

  router.post('/v1/admin/organizations/:id/devices/:deviceId/release', async (req: RouteRequest): Promise<ApiResponse> => {
    const adminId = await adminOnly(req);
    const orgId = idParam(req, 'id');
    const deviceId = idParam(req, 'deviceId');
    const data = await adminService.setDeviceQuarantine(orgId, deviceId, false, adminId, req.body?.reason);
    await auditPlatformAction(req, 'DEVICE_RELEASED', {
      type: 'DEVICE', id: deviceId, organizationId: orgId,
      previousState: { status: 'QUARANTINED' }, newState: { status: 'ACTIVE' },
    });
    return { success: true, data };
  });

  router.post('/v1/admin/organizations/:id/devices/:deviceId/revoke', async (req: RouteRequest): Promise<ApiResponse> => {
    const adminId = await adminOnly(req);
    const orgId = idParam(req, 'id');
    const deviceId = idParam(req, 'deviceId');
    const data = await adminService.revokeMerchantDevice(orgId, deviceId, adminId, req.body?.reason);
    await auditPlatformAction(req, 'DEVICE_REVOKED', { type: 'DEVICE', id: deviceId, organizationId: orgId });
    return { success: true, data };
  });
}
