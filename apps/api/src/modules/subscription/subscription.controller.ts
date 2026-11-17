import { timingSafeEqual } from 'node:crypto';
import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import {
  authenticate,
  assertHumanSessionAuth,
  resolveAuthorizedTenantOrgId,
} from '../../core/guards.js';
import { UserRole, BillingInterval } from '@brisksms/shared';
import { dbStore } from '../../core/store.js';
import { catalogService } from './catalog.service.js';
import { subscriptionService } from './subscription.service.js';
import { entitlementService } from './entitlement.service.js';
import { authService } from '../auth/auth.service.js';

function assertPlatformAdmin(req: RouteRequest): void {
  assertHumanSessionAuth(req, 'platform catalog administration');
  const configuredSecret = process.env.PLATFORM_ADMIN_SECRET?.trim();
  if (!configuredSecret || configuredSecret.length < 24) {
    throw new HttpException(
      503,
      'PLATFORM_ADMIN_UNCONFIGURED',
      'Platform admin catalog mutations are disabled until PLATFORM_ADMIN_SECRET is configured.',
    );
  }

  const provided =
    (typeof req.headers['x-platform-admin-key'] === 'string'
      ? req.headers['x-platform-admin-key'].trim()
      : undefined) || '';

  if (!provided) {
    throw new HttpException(403, 'PLATFORM_ADMIN_REQUIRED', 'Platform administrator credentials are required');
  }

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(configuredSecret, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpException(403, 'PLATFORM_ADMIN_FORBIDDEN', 'Invalid platform administrator credentials');
  }
}

async function assertOrgMemberRole(orgId: string, userId: string, allowedRoles: UserRole[]): Promise<void> {
  const membership = await dbStore.getMembership(orgId, userId);
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
    const products = await catalogService.getPublicCatalog();
    return {
      success: true,
      data: { products },
    };
  });

  // 2. Tenant Subscription Detail (Authenticated, Any Org Member)
  router.get('/v1/organizations/:orgId/subscription', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'reading organization subscription');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.FINANCE,
      UserRole.CASHIER,
      UserRole.DEVELOPER,
    ]);

    const subscription = await subscriptionService.getOrganizationSubscription(orgId);
    return {
      success: true,
      data: { subscription },
    };
  });

  // 3. Tenant Subscription Checkout / Plan Upgrade (OWNER or ADMIN only)
  router.post('/v1/organizations/:orgId/subscription/checkout', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'subscription checkout');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN]);
    await authService.checkRateLimit(`sub_checkout_${orgId}`, 20, 60_000);

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

    const subscription = await subscriptionService.checkoutSubscription(orgId, userId, body);
    return {
      success: true,
      data: { subscription },
    };
  });

  // 3b. Tenant Subscription Billing Invoices (OWNER, ADMIN, FINANCE)
  router.get('/v1/organizations/:orgId/subscription/invoices', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'reading subscription billing invoices');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE]);

    const invoices = await subscriptionService.listSubscriptionInvoices(orgId);
    return {
      success: true,
      data: { invoices },
    };
  });

  // 4. Tenant Subscription Cancellation (OWNER only)
  router.post('/v1/organizations/:orgId/subscription/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'subscription cancellation');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER]);

    const body = (req.body as unknown as { immediate?: boolean }) || {};
    const subscription = await subscriptionService.cancelSubscription(orgId, userId, body.immediate ?? false);
    return {
      success: true,
      data: { subscription },
    };
  });

  // 5. Tenant Entitlements Resolution (Any Org Member)
  router.get('/v1/organizations/:orgId/entitlements', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'reading organization entitlements');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [
      UserRole.OWNER,
      UserRole.ADMIN,
      UserRole.FINANCE,
      UserRole.CASHIER,
      UserRole.DEVELOPER,
    ]);

    const entitlements = await entitlementService.getEntitlements(orgId);
    return {
      success: true,
      data: { entitlements },
    };
  });

  // 6. Administrative Catalog Management: Create Plan (Platform Admin Only)
  router.post('/v1/admin/catalog/plans', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    const body = req.body as any;
    if (!body.productCode || !body.code || !body.name || !body.prices || !body.entitlements) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        'productCode, code, name, prices, and entitlements are required.',
      );
    }

    const result = await catalogService.adminCreatePlan(body);
    return {
      success: true,
      data: result,
    };
  });

  // 7. Administrative Catalog Management: Create New Plan Version (Platform Admin Only)
  router.post('/v1/admin/catalog/plans/:code/versions', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    const planCode = req.params.code || '';
    const body = req.body as any;
    if (!body.prices || !body.entitlements) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'prices and entitlements are required to version a plan.');
    }

    const result = await catalogService.adminCreateNewPlanVersion(planCode, body);
    return {
      success: true,
      data: result,
    };
  });
}
