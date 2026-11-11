import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate } from '../../core/guards.js';
import { ApiKeyScope, PaymentProvider } from '@brisksms/shared';
import { ApiKeyService } from '../developer/api-key.service.js';
import { stkPushService } from './stk-push.service.js';

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

  // Fallback to JWT Bearer / Session Cookie
  await authenticate(req);
  const orgId = req.query.organizationId || req.context.organizationId || (req.body as any)?.organizationId;
  if (!orgId) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
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
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;

    if (!body.phoneNumber || typeof body.phoneNumber !== 'string') {
      throw new HttpException(400, 'VALIDATION_ERROR', 'phoneNumber is required and must be a string');
    }

    if (body.amount === undefined || body.amount === null || isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'amount is required and must be a positive number');
    }

    try {
      const result = await stkPushService.initiateStkPush(orgId, {
        phoneNumber: String(body.phoneNumber).trim(),
        amount: Number(body.amount),
        currency: body.currency ? String(body.currency).toUpperCase() : 'TZS',
        invoiceId: body.invoiceId ? String(body.invoiceId).trim() : undefined,
        referenceNumber: body.referenceNumber ? String(body.referenceNumber).trim() : undefined,
        customerName: body.customerName ? String(body.customerName).trim() : undefined,
        memo: body.memo ? String(body.memo).trim() : undefined,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      });

      return {
        success: true,
        statusCode: 201,
        data: result,
      };
    } catch (err: any) {
      throw new HttpException(400, 'STK_PUSH_ERROR', err.message);
    }
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
      throw new HttpException(404, 'NOT_FOUND', err.message);
    }
  });

  /**
   * 3. Telco Webhook Callback Receiver
   * Handles asynchronous push notifications from Vodacom, Tigo, Airtel, Halotel
   */
  router.post('/v1/payments/stk-push/callback/:provider', async (req: RouteRequest): Promise<ApiResponse> => {
    const providerParam = req.params.provider || '';
    const provider = resolveProviderParam(providerParam);
    const body = req.body;

    if (!body || typeof body !== 'object') {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'Callback payload must be a JSON object');
    }

    try {
      const result = await stkPushService.handleCarrierCallback(provider, body);
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
      throw new HttpException(400, 'CALLBACK_PROCESSING_FAILED', err.message);
    }
  });
}
