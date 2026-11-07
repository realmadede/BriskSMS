import { Router } from './core/http.js';
import {
  checkDatabaseHealth,
  checkRedisHealth,
  checkWorkerHealth,
} from '@brisksms/db';
import { registerAuthRoutes } from './modules/auth/auth.controller.js';
import { registerOrganizationRoutes } from './modules/organization/organization.controller.js';
import { registerDeviceRoutes } from './modules/device/device.controller.js';
import { registerSubscriptionRoutes } from './modules/subscription/subscription.controller.js';

export function createApp(): Router {
  const router = new Router();

  // Production Health & Readiness Endpoint
  router.get('/v1/health', async () => {
    const [dbHealth, redisHealth, workerHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      checkWorkerHealth(),
    ]);

    const criticalHealthy = dbHealth.status === 'UP' && redisHealth.status === 'UP';
    const overallStatus = !criticalHealthy
      ? 'DOWN'
      : workerHealth.status === 'UP'
        ? 'UP'
        : 'DEGRADED';

    return {
      success: criticalHealthy,
      statusCode: criticalHealthy ? 200 : 503,
      data: {
        status: overallStatus,
        service: '@brisksms/api',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies: {
          process: { status: 'UP' },
          postgresql: dbHealth,
          redis: redisHealth,
          worker: workerHealth,
        },
      },
    };
  });

  // Domain Routes
  registerAuthRoutes(router);
  registerOrganizationRoutes(router);
  registerDeviceRoutes(router);
  registerSubscriptionRoutes(router);

  return router;
}
