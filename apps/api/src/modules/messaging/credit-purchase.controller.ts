import { UserRole } from '@brisksms/shared';
import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate, assertHumanSessionAuth, resolveAuthorizedTenantOrgId } from '../../core/guards.js';
import { authService } from '../auth/auth.service.js';
import { assertOrgMemberRole } from '../subscription/subscription.controller.js';
import { creditPackService } from './credit-pack.service.js';
import { creditPurchaseService } from './credit-purchase.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerCreditPurchaseRoutes(router: Router): void {
  // Packs a workspace can buy: only active ones, with the prices configured on /nexus
  router.get('/v1/organizations/:orgId/messaging/credit-packs', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'reading credit packs');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE]);
    return { success: true, data: { packs: await creditPackService.list(true) } };
  });

  router.post('/v1/organizations/:orgId/messaging/credits/request', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'credit purchase');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN]);
    await authService.checkRateLimit(`credit_request_${orgId}`, 10, 60_000);

    const body = (req.body ?? {}) as { packId?: unknown; payerPhone?: unknown };
    if (typeof body.packId !== 'string' || !UUID.test(body.packId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'packId must be a credit pack id.');
    }
    const payerPhone = typeof body.payerPhone === 'string' ? body.payerPhone.trim() : '';
    if (payerPhone && !/^\+?[0-9]{9,15}$/.test(payerPhone)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'payerPhone must be a phone number with 9 to 15 digits.');
    }
    const purchase = await creditPurchaseService.createRequest(orgId, userId, {
      packId: body.packId,
      payerPhone: payerPhone || undefined,
    });
    return { success: true, data: { purchase } };
  });

  router.get('/v1/organizations/:orgId/messaging/credits/request', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'reading credit purchase');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE]);
    return { success: true, data: { purchase: await creditPurchaseService.getCurrentRequest(orgId) } };
  });

  router.post('/v1/organizations/:orgId/messaging/credits/request/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'cancelling credit purchase');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN]);
    await creditPurchaseService.cancelRequest(orgId, userId);
    return { success: true, data: { cancelled: true } };
  });
}
