import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate } from '../../core/guards.js';
import { dbStore } from '../../core/store.js';
import { ApiKeyScope, BriskError, PaymentProvider } from '@brisksms/shared';
import { DatabaseUnavailableError, sql } from '@brisksms/db';
import { ApiKeyService } from '../developer/api-key.service.js';
import { authService } from '../auth/auth.service.js';
import { stkPushService } from './stk-push.service.js';
import { CallbackVerificationRequest } from './verifiers/index.js';

const apiKeyService = new ApiKeyService();

async function resolveOrganizationContext(
  req: RouteRequest,
  requiredScopes: ApiKeyScope[] = [ApiKeyScope.PAYMENT_STK, ApiKeyScope.PAYMENTS_WRITE],
): Promise<string> {
  const authHeader = (req.headers.authorization || (req.headers as any)['Authorization'] || '') as string;
  const apiKeyHeader = (req.headers['x-api-key'] || (req.headers as any)['X-API-Key'] || '') as string;

  let rawKey: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer bsk_live_')) {
    rawKey = authHeader.replace('Bearer ', '').trim();
  } else if (apiKeyHeader && apiKeyHeader.startsWith('bsk_live_')) {
    rawKey = apiKeyHeader.trim();
  }

  if (rawKey) {
    const keyRecord = await apiKeyService.validateApiKey(rawKey);
    if (!keyRecord) {
      throw new HttpException(401, 'INVALID_API_KEY', 'Unauthorized: Invalid or revoked API key');
    }

    const hasScope = requiredScopes.some((s) => keyRecord.scopes.includes(s));
    if (!hasScope) {
      throw new HttpException(
        403,
        'INSUFFICIENT_SCOPE',
        `Forbidden: API key requires at least one of the following scopes: ${requiredScopes.join(', ')}`,
      );
    }

    return keyRecord.organizationId;
  }

  // Fallback to JWT Bearer / Session Cookie / OAuth access token
  await authenticate(req);
  if (req.context.authType === 'oauth') {
    const scopes = req.context.oauthScopes ?? [];
    const hasOAuthScope = requiredScopes.some((s) => scopes.includes(s));
    if (!hasOAuthScope) {
      throw new HttpException(
        403,
        'INSUFFICIENT_SCOPE',
        `Forbidden: OAuth token requires at least one of the following scopes: ${requiredScopes.join(', ')}`,
      );
    }
  }

  const userId = req.context.userId!;
  const contextOrgId = req.context.organizationId;
  const queryOrgId = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
  const bodyOrgId =
    req.body && typeof (req.body as any).organizationId === 'string'
      ? String((req.body as any).organizationId).trim()
      : '';
  const requestedOrgId = queryOrgId || bodyOrgId;

  if (contextOrgId && requestedOrgId && requestedOrgId !== contextOrgId) {
    throw new HttpException(
      403,
      'CROSS_ORGANIZATION_FORBIDDEN',
      'Cannot specify an organizationId outside the authenticated session organization context',
    );
  }

  const orgId = requestedOrgId || contextOrgId;
  if (!orgId) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
  }

  const membership = await dbStore.getMembership(orgId, userId);
  if (!membership) {
    throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
  }

  return orgId;
}

function resolveProviderParam(providerParam: string): PaymentProvider {
  const norm = providerParam.toLowerCase().replace(/[^a-z]/g, '');
  if (norm.includes('mpesa') || norm.includes('voda')) {
    return PaymentProvider.MPESA;
  }
  if (norm.includes('tigo') || norm.includes('mixx')) {
    return PaymentProvider.MIXX;
  }
  if (norm.includes('airtel')) {
    return PaymentProvider.AIRTEL_MONEY;
  }
  if (norm.includes('halo')) {
    return PaymentProvider.HALOPESA;
  }
  if (norm.includes('ttcl')) {
    return PaymentProvider.TTCL_PESA;
  }
  throw new HttpException(400, 'UNSUPPORTED_PROVIDER', `Unsupported STK provider: '${providerParam}'`);
}

export function registerStkPushRoutes(router: Router): void {
  /**
   * 1. Initiate Carrier STK / USSD Push
   * Authenticated by Scoped Developer API Key (bsk_live_...) or User JWT / Session Cookie
   */
  router.post('/v1/payments/stk-push', async (req: RouteRequest): Promise<ApiResponse> => {
    const orgId = await resolveOrganizationContext(req);
    await authService.checkRateLimit(`stk_init_${orgId}`, 60, 60_000);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;

    if (!body.phoneNumber || typeof body.phoneNumber !== 'string') {
      throw new HttpException(400, 'VALIDATION_ERROR', 'phoneNumber is required and must be a string');
    }

    if (body.amount === undefined || body.amount === null || isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'amount is required and must be a positive number');
    }

    const rawHeaderIdem = req.headers['idempotency-key'];
    const headerIdem = typeof rawHeaderIdem === 'string' ? rawHeaderIdem.trim() : undefined;
    const bodyIdem = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : undefined;

    if (rawHeaderIdem !== undefined && !headerIdem) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'Idempotency-Key header cannot be blank');
    }
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== 'string' || !bodyIdem)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey must be a non-empty string when provided');
    }
    if (headerIdem && bodyIdem && headerIdem !== bodyIdem) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        'Conflicting Idempotency-Key header and body.idempotencyKey values',
      );
    }
    const idempotencyKey = headerIdem || bodyIdem;
    if (idempotencyKey && idempotencyKey.length > 120) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey must be 120 characters or fewer');
    }

    try {
      const result = await stkPushService.initiateStkPush(orgId, {
        phoneNumber: String(body.phoneNumber).trim(),
        provider:
          body.provider !== undefined
            ? (String(body.provider).trim().toUpperCase() as any)
            : undefined,
        amount: Number(body.amount),
        currency: body.currency ? String(body.currency).trim().toUpperCase() : 'TZS',
        invoiceId: body.invoiceId ? String(body.invoiceId).trim() : undefined,
        referenceNumber: body.referenceNumber ? String(body.referenceNumber).trim() : undefined,
        customerName: body.customerName ? String(body.customerName).trim() : undefined,
        memo: body.memo ? String(body.memo).trim() : undefined,
        idempotencyKey,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      });

      return {
        success: true,
        statusCode: 201,
        data: result,
      };
    } catch (err: any) {
      if (err instanceof HttpException || err instanceof BriskError || err instanceof DatabaseUnavailableError) {
        throw err;
      }
      throw new HttpException(500, 'STK_PUSH_ERROR', 'STK push initiation failed due to an unexpected internal error');
    }
  });

  /**
   * 1b. List Organization STK Push Transactions
   */
  router.get('/v1/payments/stk-push', async (req: RouteRequest): Promise<ApiResponse> => {
    const orgId = await resolveOrganizationContext(req, [
      ApiKeyScope.PAYMENT_STK,
      ApiKeyScope.PAYMENTS_WRITE,
      ApiKeyScope.PAYMENTS_READ,
    ]);
    const rows = await sql`
      SELECT *
      FROM "stk_push_transactions"
      WHERE "organization_id" = ${orgId}
      ORDER BY "created_at" DESC
      LIMIT 100
    `;
    const transactions = rows.map((r: any) => ({
      id: String(r.id),
      organizationId: String(r.organization_id),
      provider: String(r.provider),
      phoneNumber: String(r.phone_number),
      amountCents: BigInt(r.amount_cents).toString(),
      currency: String(r.currency),
      referenceNumber: r.reference_number ? String(r.reference_number) : null,
      invoiceId: r.invoice_id ? String(r.invoice_id) : null,
      status: String(r.status),
      checkoutRequestId: String(r.id),
      providerReference: r.provider_reference ? String(r.provider_reference) : null,
      settledPaymentId: r.settled_payment_id ? String(r.settled_payment_id) : null,
      resultCode: r.result_code !== null && r.result_code !== undefined ? Number(r.result_code) : null,
      resultDescription: r.result_description ? String(r.result_description) : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
    return {
      success: true,
      data: { transactions },
    };
  });

  /**
   * 2. Query STK Push Checkout Status
   * Authenticated by Scoped Developer API Key or User Session
   */
  router.get('/v1/payments/stk-push/:checkoutId', async (req: RouteRequest): Promise<ApiResponse> => {
    const orgId = await resolveOrganizationContext(req, [
      ApiKeyScope.PAYMENT_STK,
      ApiKeyScope.PAYMENTS_WRITE,
      ApiKeyScope.PAYMENTS_READ,
    ]);
    const checkoutId = req.params.checkoutId || '';
    if (!checkoutId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'checkoutId parameter is required');
    }

    try {
      const status = await stkPushService.getStkTransactionStatus(orgId, checkoutId);
      return {
        success: true,
        data: status,
      };
    } catch (err: any) {
      if (err instanceof HttpException || err instanceof BriskError || err instanceof DatabaseUnavailableError) {
        throw err;
      }
      if (typeof err?.message === 'string' && err.message.toLowerCase().includes('not found')) {
        throw new HttpException(404, 'NOT_FOUND', err.message);
      }
      throw err;
    }
  });

  /**
   * 3. Telco Webhook Callback Receiver
   * Handles asynchronous push notifications from Vodacom, Tigo, Airtel, Halotel
   * Enforces provider-specific cryptographic callback authentication before processing.
   */
  router.post('/v1/payments/stk-push/callback/:provider', async (req: RouteRequest): Promise<ApiResponse> => {
    const providerParam = req.params.provider || '';
    const provider = resolveProviderParam(providerParam);
    const body = req.body;

    if (!body || typeof body !== 'object') {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Callback payload must be a JSON object');
    }

    const verificationReq: CallbackVerificationRequest = {
      provider,
      headers: req.headers,
      rawBody: req.rawBody,
      rawBodyBuffer: req.rawBodyBuffer,
      body: req.body,
      query: req.query,
      urlPath: req.path,
      ipAddress: (req.rawReq?.socket?.remoteAddress || '').replace(/^.*:/, ''),
    };

    try {
      const result = await stkPushService.handleCarrierCallback(provider, verificationReq);
      return {
        success: true,
        data: {
          acknowledged: true,
          status: result.status,
          checkoutId: result.checkoutId,
          providerReference: result.providerReference,
        },
      };
    } catch (err: any) {
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(400, 'CALLBACK_PROCESSING_FAILED', err.message);
    }
  });
}
