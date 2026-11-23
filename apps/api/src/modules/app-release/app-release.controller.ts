import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { authService } from '../auth/auth.service.js';
import { extractClientIp } from '../auth/auth.controller.js';
import { checkForUpdate } from './app-release.service.js';

export function registerAppReleaseRoutes(router: Router): void {
  // Public: the Android direct build checks this before and after pairing.
  router.get('/v1/app/releases/latest', async (req: RouteRequest): Promise<ApiResponse> => {
    const clientIp = extractClientIp(req);
    if (clientIp) {
      await authService.checkRateLimit(`app_release_${clientIp}`, 60, 60_000);
    }

    const raw = (req.query.versionCode ?? '').trim();
    const versionCode = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(versionCode) || versionCode < 1) {
      throw new HttpException(400, 'INVALID_VERSION_CODE', 'versionCode must be a positive integer');
    }

    return { success: true, data: checkForUpdate(versionCode) };
  });
}
