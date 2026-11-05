import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate } from '../../core/guards.js';
import { UserRole, BillingInterval } from '@brisksms/shared';
import { dbStore } from '../../core/store.js';
import { catalogService } from './catalog.service.js';
import { subscriptionService } from './subscription.service.js';
import { entitlementService } from './entitlement.service.js';

function assertOrgMemberRole(orgId: string, userId: string, allowedRoles: UserRole[]): void {
  const membership = dbStore.getMembership(orgId, userId);
  if (!membership) {
    throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
  }
  if (!allowedRoles.includes(membership.role)) {
    throw new HttpException(
      403,
      'INSUFFICIENT_PERMISSIONS',
      `Action requires one of the following roles: ${allowedRoles.join(', ')}`,
    );
  }
}

export function registerSubscriptionRoutes(router: Router): void {
  // 1. Dynamic Public Catalog (Public, No Auth Needed)
  router.get('/v1/catalog/public', async (): Promise<ApiResponse> => {
    const products = catalogService.getPublicCatalog();
    return {
      success: true,
      data: { products },
    };
  });

  // 2. Tenant Subscription Detail (Authenticated, Any Org Member)
  router.get('/v1/organizations/:orgId/subscription', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.params.orgId || '';
    assertOrgMemberRole(orgId, userId, [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.FINANCE,
      UserRole.CASHIER,
      UserRole.DEVELOPER,
    ]);

    const subscription = subscriptionService.getOrganizationSubscription(orgId);
    return {
      success: true,
      data: { subscription },
    };
  });

  // 3. Tenant Subscription Checkout / Plan Upgrade (OWNER or ADMIN only)
  router.post('/v1/organizations/:orgId/subscription/checkout', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.params.orgId || '';
    assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN]);

    const body = req.body as unknown as {
      planCode: string;
      currency: string;
      billingInterval: BillingInterval;
      paymentMethodRef?: string;
    };

    if (!body.planCode || !body.currency || !body.billingInterval) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        'planCode, currency, and billingInterval are required for checkout.',
      );
    }

    const subscription = subscriptionService.checkoutSubscription(orgId, userId, body);
    return {
      success: true,
      data: { subscription },
    };
  });

  // 4. Tenant Subscription Cancellation (OWNER only)
  router.post('/v1/organizations/:orgId/subscription/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.params.orgId || '';
    assertOrgMemberRole(orgId, userId, [UserRole.OWNER]);

    const body = (req.body as unknown as { immediate?: boolean }) || {};
    const subscription = subscriptionService.cancelSubscription(orgId, userId, body.immediate ?? false);
    return {
      success: true,
      data: { subscription },
    };
  });

  // 5. Tenant Entitlements Resolution (Any Org Member)
  router.get('/v1/organizations/:orgId/entitlements', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.params.orgId || '';
    assertOrgMemberRole(orgId, userId, [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.FINANCE,
      UserRole.CASHIER,
      UserRole.DEVELOPER,
    ]);

    const entitlements = entitlementService.getEntitlements(orgId);
    return {
      success: true,
      data: { entitlements },
    };
  });

  // 6. Administrative Catalog Management: Create Plan (Privileged)
  router.post('/v1/admin/catalog/plans', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const body = req.body as any;
    if (!body.productCode || !body.code || !body.name || !body.prices || !body.entitlements) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        'productCode, code, name, prices, and entitlements are required.',
      );
    }

    const result = catalogService.adminCreatePlan(body);
    return {
      success: true,
      data: result,
    };
  });

  // 7. Administrative Catalog Management: Create New Plan Version (Privileged)
  router.post('/v1/admin/catalog/plans/:code/versions', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const planCode = req.params.code || '';
    const body = req.body as any;
    if (!body.prices || !body.entitlements) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'prices and entitlements are required to version a plan.');
    }

    const result = catalogService.adminCreateNewPlanVersion(planCode, body);
    return {
      success: true,
      data: result,
    };
  });
}
