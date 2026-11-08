import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate } from '../../core/guards.js';
import { reconciliationService } from './reconciliation.service.js';
import { dbStore } from '../../core/store.js';
import { TransactionState, UserRole, VerificationMethod } from '@brisksms/shared';

async function assertOrgAccess(
  orgId: string,
  userId: string,
  allowedRoles?: UserRole[],
): Promise<UserRole> {
  const membership = await dbStore.getMembership(orgId, userId);
  if (!membership) {
    throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
  }
  if (allowedRoles && !allowedRoles.includes(membership.role)) {
    throw new HttpException(
      403,
      'INSUFFICIENT_PERMISSIONS',
      `Action requires one of the following roles: ${allowedRoles.join(', ')}`,
    );
  }
  return membership.role;
}

export function registerReconciliationRoutes(router: Router): void {
  // 1. List Normalized Payments with Filters
  router.get('/v1/reconciliation/payments', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertOrgAccess(orgId, userId);

    const stateFilter = req.query.state as TransactionState | undefined;
    const providerFilter = req.query.provider as string | undefined;

    const payments = await reconciliationService.listPayments(orgId, {
      state: stateFilter,
      provider: providerFilter,
    });

    return {
      success: true,
      data: { payments },
    };
  });

  // 2. Get Normalized Payment Detail
  router.get('/v1/reconciliation/payments/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const paymentId = req.params.id || '';
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertOrgAccess(orgId, userId);

    const payment = await reconciliationService.findPaymentById(orgId, paymentId);
    if (!payment) {
      throw new HttpException(404, 'NOT_FOUND', `Payment '${paymentId}' not found`);
    }

    const verifications = await reconciliationService.getPaymentVerifications(orgId, paymentId);

    let candidateInvoice = null;
    if (payment.candidateInvoiceId) {
      candidateInvoice = await reconciliationService.findInvoiceById(orgId, payment.candidateInvoiceId);
    }

    return {
      success: true,
      data: {
        payment,
        candidateInvoice,
        verifications,
      },
    };
  });

  // 3. List Invoices
  router.get('/v1/reconciliation/invoices', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertOrgAccess(orgId, userId);

    const invoices = await reconciliationService.listInvoices(orgId);
    return {
      success: true,
      data: { invoices },
    };
  });

  // 4. Create Invoice
  router.post('/v1/reconciliation/invoices', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = (req.body.organizationId as string) || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertOrgAccess(orgId, userId, [UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE]);

    const body = req.body as Record<string, any>;
    if (!body.referenceNumber || body.totalAmountCents === undefined) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'referenceNumber and totalAmountCents are required');
    }

    const invoice = await reconciliationService.createInvoice(orgId, {
      referenceNumber: String(body.referenceNumber),
      totalAmountCents: BigInt(body.totalAmountCents),
      currency: body.currency ? String(body.currency) : 'TZS',
      customerId: body.customerId ? String(body.customerId) : undefined,
      customerPhone: body.customerPhone ? String(body.customerPhone) : undefined,
      customerName: body.customerName ? String(body.customerName) : undefined,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    });

    return {
      success: true,
      statusCode: 201,
      data: { invoice },
    };
  });

  // 5. Get Specific Invoice Detail
  router.get('/v1/reconciliation/invoices/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const invoiceId = req.params.id || '';
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertOrgAccess(orgId, userId);

    const invoice = await reconciliationService.findInvoiceById(orgId, invoiceId);
    if (!invoice) {
      throw new HttpException(404, 'NOT_FOUND', `Invoice '${invoiceId}' not found`);
    }

    return {
      success: true,
      data: { invoice },
    };
  });

  // 6. Verify Payment (Manual or Independent Verification Settlement)
  router.post('/v1/reconciliation/verify', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const body = req.body as Record<string, any>;
    const orgId = (body.organizationId as string) || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertOrgAccess(orgId, userId, [UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE]);

    if (!body.paymentId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'paymentId is required');
    }

    const verificationMethod: VerificationMethod = body.verificationMethod || VerificationMethod.MANUAL_FINANCE_APPROVAL;

    const settlementResult = await reconciliationService.verifyPayment(orgId, {
      paymentId: String(body.paymentId),
      invoiceId: body.invoiceId ? String(body.invoiceId) : undefined,
      verificationMethod,
      verifiedById: userId,
      externalVerificationRef: body.externalVerificationRef ? String(body.externalVerificationRef) : undefined,
      notes: body.notes ? String(body.notes) : undefined,
    });

    return {
      success: true,
      data: settlementResult,
    };
  });

  // 7. Reject Payment (Manual Review Queue Rejection)
  router.post('/v1/reconciliation/reject', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const body = req.body as Record<string, any>;
    const orgId = (body.organizationId as string) || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertOrgAccess(orgId, userId, [UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE]);

    if (!body.paymentId || !body.notes) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'paymentId and notes are required');
    }

    const rejected = await reconciliationService.rejectPayment(orgId, {
      paymentId: String(body.paymentId),
      verifiedById: userId,
      notes: String(body.notes),
    });

    return {
      success: true,
      data: rejected,
    };
  });
}
