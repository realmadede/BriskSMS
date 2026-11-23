import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authenticate } from '../../core/guards.js';
import { accountService } from './account.service.js';

async function requireUserSession(req: RouteRequest): Promise<string> {
  await authenticate(req);
  if (req.context.authType === 'oauth') {
    throw new HttpException(403, 'OAUTH_FORBIDDEN', 'OAuth access tokens cannot manage the account');
  }
  return req.context.userId!;
}

export function registerAccountRoutes(router: Router): void {
  router.get('/v1/account', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    return { success: true, data: await accountService.getAccount(userId, req.context.organizationId) };
  });

  router.post('/v1/account/profile', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    await accountService.updateProfile(userId, req.body);
    return { success: true, data: { updated: true } };
  });

  router.post('/v1/account/password', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    await accountService.changePassword(userId, req.body, req.context.jti);
    return { success: true, data: { changed: true } };
  });

  router.post('/v1/account/2fa/begin', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    return { success: true, data: await accountService.beginTwoFactor(userId, req.body.password) };
  });

  router.post('/v1/account/2fa/enable', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    return { success: true, data: await accountService.enableTwoFactor(userId, req.body.code) };
  });

  router.post('/v1/account/2fa/disable', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    await accountService.disableTwoFactor(userId, req.body);
    return { success: true, data: { disabled: true } };
  });

  router.post('/v1/account/email', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    return { success: true, data: await accountService.requestEmailChange(userId, req.body) };
  });

  // The link in the confirmation email carries a single-use token, so it needs no session
  router.post('/v1/account/email/confirm', async (req: RouteRequest): Promise<ApiResponse> => {
    await accountService.confirmEmailChange(req.body.token);
    return { success: true, data: { confirmed: true } };
  });

  router.post('/v1/account/transfer-ownership', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    await accountService.transferOwnership(userId, req.body);
    return { success: true, data: { transferred: true } };
  });

  router.post('/v1/account/delete', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    return { success: true, data: await accountService.requestDeletion(userId, req.body) };
  });

  router.post('/v1/account/delete/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = await requireUserSession(req);
    return { success: true, data: { restored: await accountService.cancelDeletion(userId) } };
  });
}
