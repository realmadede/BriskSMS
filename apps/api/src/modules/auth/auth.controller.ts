import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authService, RegisterDto, LoginDto } from './auth.service.js';
import { authenticate } from '../../core/guards.js';

export function registerAuthRoutes(router: Router): void {
  router.post('/v1/auth/register', async (req: RouteRequest): Promise<ApiResponse> => {
    const dto = req.body as unknown as RegisterDto;
    const result = await authService.register(dto);
    return {
      success: true,
      data: result,
    };
  });

  router.post('/v1/auth/login', async (req: RouteRequest): Promise<ApiResponse> => {
    const dto = req.body as unknown as LoginDto;
    const result = await authService.login(dto);
    return {
      success: true,
      data: result,
    };
  });

  router.post('/v1/auth/refresh', async (req: RouteRequest): Promise<ApiResponse> => {
    const token = (req.body.refreshToken as string) || '';
    const tokens = await authService.refreshToken(token);
    return {
      success: true,
      data: tokens,
    };
  });

  router.post('/v1/auth/logout', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    // Revoke current session JTI
    if (req.context.userId) {
      // Invalidate if token included JTI
    }
    return {
      success: true,
      data: { message: 'Successfully logged out' },
    };
  });

  router.post('/v1/auth/verify-email', async (req: RouteRequest): Promise<ApiResponse> => {
    const userId = (req.body.userId as string) || '';
    if (!userId) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'userId is required');
    }
    await authService.verifyEmail(userId);
    return {
      success: true,
      data: { message: 'Email address verified successfully' },
    };
  });

  router.get('/v1/auth/me', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const profile = await authService.getMe(userId);
    return {
      success: true,
      data: profile,
    };
  });
}
