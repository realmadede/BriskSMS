import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate } from '../../core/guards.js';
import { ApiKeyService } from './api-key.service.js';
import { WebhookService } from './webhook.service.js';
import { DeveloperActionService } from './developer-action.service.js';
import { dbStore } from '../../core/store.js';
import { ApiKeyScope, UserRole } from '@brisksms/shared';
import { MessagingService } from '../messaging/messaging.service.js';

const apiKeyService = new ApiKeyService();
const webhookService = new WebhookService();
const developerActionService = new DeveloperActionService(apiKeyService);
const messagingService = new MessagingService();

async function assertDeveloperAccess(orgId: string, userId: string): Promise<void> {
  const membership = await dbStore.getMembership(orgId, userId);
  if (!membership) {
    throw new HttpException(403, 'FORBIDDEN', 'You are not a member of this organization');
  }
  const allowed = [UserRole.OWNER, UserRole.ADMIN, UserRole.DEVELOPER];
  if (!allowed.includes(membership.role)) {
    throw new HttpException(
      403,
      'INSUFFICIENT_PERMISSIONS',
      `Action requires one of the following roles: ${allowed.join(', ')}`,
    );
  }
}

export function registerDeveloperRoutes(router: Router): void {
  // 1. List API Keys
  router.get('/v1/developer/api-keys', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    const apiKeys = await apiKeyService.listApiKeys(orgId);
    return {
      success: true,
      data: { apiKeys },
    };
  });

  // 2. Create API Key
  router.post('/v1/developer/api-keys', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const body = req.body as Record<string, any>;
    const orgId = (body.organizationId as string) || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    if (!body.name || !body.scopes || !Array.isArray(body.scopes) || body.scopes.length === 0) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'name and non-empty scopes array are required');
    }

    const result = await apiKeyService.createApiKey(orgId, {
      organizationId: orgId,
      name: String(body.name),
      scopes: body.scopes as ApiKeyScope[],
    });

    return {
      success: true,
      statusCode: 201,
      data: result,
    };
  });

  // 3. Revoke API Key
  router.delete('/v1/developer/api-keys/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const keyId = req.params.id || '';
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    const revoked = await apiKeyService.revokeApiKey(orgId, keyId);
    if (!revoked) {
      throw new HttpException(404, 'NOT_FOUND', `API key '${keyId}' not found or already revoked`);
    }

    return {
      success: true,
      data: { revoked: true },
    };
  });

  // 4. List Registered Webhooks
  router.get('/v1/developer/webhooks', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    const endpoints = await webhookService.listEndpoints(orgId);
    return {
      success: true,
      data: { endpoints },
    };
  });

  // 5. Register Webhook Endpoint
  router.post('/v1/developer/webhooks', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const body = req.body as Record<string, any>;
    const orgId = (body.organizationId as string) || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    if (!body.url || !body.subscribedEvents || !Array.isArray(body.subscribedEvents)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'url and subscribedEvents array are required');
    }

    const endpoint = await webhookService.registerEndpoint(orgId, {
      url: String(body.url),
      subscribedEvents: body.subscribedEvents,
      secret: body.secret ? String(body.secret) : undefined,
    });

    return {
      success: true,
      statusCode: 201,
      data: { endpoint },
    };
  });

  // 6. Delete Webhook Endpoint
  router.delete('/v1/developer/webhooks/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const endpointId = req.params.id || '';
    const orgId = req.query.organizationId || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    const deleted = await webhookService.deleteEndpoint(orgId, endpointId);
    if (!deleted) {
      throw new HttpException(404, 'NOT_FOUND', `Webhook endpoint '${endpointId}' not found`);
    }

    return {
      success: true,
      data: { deleted: true },
    };
  });

  // 7. Developer Dispatch Message Action (Zapier / Google Sheets / API Key Integration)
  const handleSendMessage = async (req: RouteRequest): Promise<ApiResponse> => {
    let token: string | undefined;

    // Check x-api-key header first (case-insensitive fallback)
    const xApiKey = (req.headers['x-api-key'] || req.headers['X-API-Key']) as string | undefined;
    if (xApiKey && typeof xApiKey === 'string' && xApiKey.trim()) {
      token = xApiKey.trim();
    } else {
      const authHeader = req.headers.authorization;
      if (authHeader && typeof authHeader === 'string') {
        const [scheme, bearerToken] = authHeader.split(' ');
        if (scheme === 'Bearer' && bearerToken) {
          token = bearerToken.trim();
        }
      }
    }

    if (!token) {
      throw new HttpException(
        401,
        'UNAUTHORIZED',
        'Missing authentication credentials (Authorization: Bearer <token> or x-api-key required)',
      );
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const recipientPhone = String(body.recipientPhone || body.recipient || body.to || '').trim();
    const message = String(body.message || body.content || '').trim();

    if (!recipientPhone || !message) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'recipientPhone (or recipient) and message are required');
    }

    // Scoped API Key authentication (e.g. bsk_live_...)
    if (token.startsWith('bsk_live_')) {
      try {
        const result = await developerActionService.handleSendMessageAction(token, {
          recipientPhone,
          message,
          simSlot: body.simSlot ? Number(body.simSlot) : 1,
        });

        return {
          success: true,
          data: result,
        };
      } catch (err: any) {
        const errMsg = err?.message || 'API key authorization failed';
        if (errMsg.includes('requires sms:send') || errMsg.includes('scope')) {
          throw new HttpException(403, 'INSUFFICIENT_SCOPE', errMsg);
        }
        throw new HttpException(401, 'UNAUTHORIZED', errMsg);
      }
    }

    // Otherwise standard JWT user authentication
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = (body.organizationId as string) || req.context.organizationId;
    if (!orgId) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'organizationId is required');
    }
    await assertDeveloperAccess(orgId, userId);

    const msg = await messagingService.sendSingleMessage(orgId, {
      to: recipientPhone,
      content: message,
      simSlot: body.simSlot ? Number(body.simSlot) : 1,
    });

    return {
      success: true,
      data: {
        success: true,
        messageId: msg.id,
        status: msg.status,
        recipientPhone: msg.recipientPhone,
        costCredits: msg.costCredits,
      },
    };
  };

  router.post('/v1/developer/messages/send', handleSendMessage);
  router.post('/v1/messages/send', handleSendMessage);
}
