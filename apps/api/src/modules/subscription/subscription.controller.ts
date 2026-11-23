import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import {
  authenticate,
  assertHumanSessionAuth,
  assertPlatformAdmin,
  resolveAuthorizedTenantOrgId,
} from '../../core/guards.js';
import { UserRole, BillingInterval, EntitlementType } from '@brisksms/shared';
import { dbStore } from '../../core/store.js';
import { catalogService } from './catalog.service.js';
import { subscriptionService, BILLING_WORKSPACE_SETTING, BILLING_INSTRUCTIONS_SETTING } from './subscription.service.js';
import { billingRequestService } from './billing-request.service.js';
import { entitlementService } from './entitlement.service.js';
import { authService } from '../auth/auth.service.js';
import { auditPlatformAction } from '../admin/platform-audit.js';

export async function assertOrgMemberRole(orgId: string, userId: string, allowedRoles: UserRole[]): Promise<void> {
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

  // 3a. Pay for a paid plan: creates a payment request (an invoice in the billing workspace)
  router.post('/v1/organizations/:orgId/subscription/payment-request', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'subscription payment request');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN]);
    await authService.checkRateLimit(`sub_request_${orgId}`, 10, 60_000);

    const body = req.body as unknown as {
      planCode?: string;
      currency?: string;
      billingInterval?: BillingInterval;
      payerPhone?: string;
    };
    if (!body.planCode || !body.currency || !body.billingInterval) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'planCode, currency, and billingInterval are required.');
    }
    const payerPhone = typeof body.payerPhone === 'string' ? body.payerPhone.trim() : '';
    if (payerPhone && !/^\+?[0-9]{9,15}$/.test(payerPhone)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'payerPhone must be a phone number with 9 to 15 digits.');
    }

    const paymentRequest = await billingRequestService.createRequest(orgId, userId, {
      planCode: body.planCode,
      currency: body.currency,
      billingInterval: body.billingInterval,
      payerPhone: payerPhone || undefined,
    });
    return { success: true, data: { paymentRequest } };
  });

  router.get('/v1/organizations/:orgId/subscription/payment-request', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'reading subscription payment request');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE]);
    return { success: true, data: { paymentRequest: await billingRequestService.getCurrentRequest(orgId) } };
  });

  router.post('/v1/organizations/:orgId/subscription/payment-request/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertHumanSessionAuth(req, 'cancelling subscription payment request');
    const userId = req.context.userId!;
    const orgId = resolveAuthorizedTenantOrgId(req, req.params.orgId);
    await assertOrgMemberRole(orgId, userId, [UserRole.OWNER, UserRole.ADMIN]);
    await billingRequestService.cancelRequest(orgId, userId);
    return { success: true, data: { cancelled: true } };
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
    await auditPlatformAction(req, 'PLAN_CREATED', {
      type: 'PLAN',
      id: String(body.code),
      newState: { code: body.code, name: body.name },
    });
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
    await auditPlatformAction(req, 'PLAN_VERSION_CREATED', { type: 'PLAN', id: planCode });
    return {
      success: true,
      data: result,
    };
  });

  // Every plan, including private ones, for the platform admin console
  router.get('/v1/admin/catalog/plans', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    return { success: true, data: { products: await catalogService.getPublicCatalog(true) } };
  });

  // The workspace whose verified payments fund BriskSMS's own subscriptions (Platform Admin Only)
  router.get('/v1/admin/billing-workspace', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    const id = await dbStore.getPlatformSetting(BILLING_WORKSPACE_SETTING);
    const org = id ? await dbStore.findOrgById(id) : null;
    const instructions = (await dbStore.getPlatformSetting(BILLING_INSTRUCTIONS_SETTING)) || '';
    return { success: true, data: { organizationId: org?.id ?? null, name: org?.name ?? null, instructions } };
  });

  // Where and how customers pay BriskSMS, shown with their payment reference (Platform Admin Only)
  router.put('/v1/admin/billing-workspace/instructions', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    const text = (req.body as { instructions?: unknown } | undefined)?.instructions;
    if (typeof text !== 'string' || text.length > 1000) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'instructions must be text of at most 1000 characters');
    }
    const previous = (await dbStore.getPlatformSetting(BILLING_INSTRUCTIONS_SETTING)) || '';
    await dbStore.setPlatformSetting(BILLING_INSTRUCTIONS_SETTING, text.trim());
    await auditPlatformAction(req, 'BILLING_INSTRUCTIONS_CHANGED', {
      type: 'PLATFORM_SETTING',
      id: BILLING_INSTRUCTIONS_SETTING,
      previousState: { instructions: previous },
      newState: { instructions: text.trim() },
    });
    return { success: true, data: { instructions: text.trim() } };
  });

  router.put('/v1/admin/billing-workspace', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    const organizationId = (req.body as { organizationId?: unknown } | undefined)?.organizationId;
    if (typeof organizationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId must be a workspace id');
    }
    const org = await dbStore.findOrgById(organizationId);
    if (!org) {
      throw new HttpException(404, 'NOT_FOUND', 'Workspace not found');
    }
    const previous = await dbStore.getPlatformSetting(BILLING_WORKSPACE_SETTING);
    await dbStore.setPlatformSetting(BILLING_WORKSPACE_SETTING, org.id);
    await auditPlatformAction(req, 'BILLING_WORKSPACE_SET', {
      type: 'PLATFORM_SETTING',
      id: BILLING_WORKSPACE_SETTING,
      organizationId: org.id,
      previousState: { organizationId: previous },
      newState: { organizationId: org.id },
    });
    return { success: true, data: { organizationId: org.id, name: org.name } };
  });

  // 8. Feature defaults: what a workspace without an active subscription gets (Platform Admin Only)
  router.get('/v1/admin/catalog/features', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    return { success: true, data: { features: await dbStore.getFeatureDefinitions() } };
  });

  router.put('/v1/admin/catalog/features/:key', async (req: RouteRequest): Promise<ApiResponse> => {
    await authenticate(req);
    assertPlatformAdmin(req);
    const featureKey = req.params.key || '';
    const value = (req.body as { defaultValue?: unknown } | undefined)?.defaultValue;
    const feature = (await dbStore.getFeatureDefinitions()).find((f) => f.key === featureKey);
    if (!feature) {
      throw new HttpException(404, 'NOT_FOUND', `Feature '${featureKey}' does not exist`);
    }
    const valid =
      feature.type === EntitlementType.BOOLEAN_FLAG
        ? value === 'true' || value === 'false'
        : typeof value === 'string' && /^\d{1,9}$/.test(value);
    if (!valid) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        feature.type === EntitlementType.BOOLEAN_FLAG
          ? "defaultValue must be 'true' or 'false'"
          : 'defaultValue must be a whole number of 0 or more, sent as a string',
      );
    }
    await dbStore.setFeatureDefinitionDefaultValue(featureKey, value as string);
    await auditPlatformAction(req, 'FEATURE_DEFAULT_CHANGED', {
      type: 'FEATURE',
      id: featureKey,
      previousState: { defaultValue: feature.defaultValue },
      newState: { defaultValue: value },
    });
    return { success: true, data: { key: featureKey, defaultValue: value } };
  });
}
