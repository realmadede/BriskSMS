import { Router } from './core/http.js';
import { registerAuthRoutes } from './modules/auth/auth.controller.js';
import { registerOrganizationRoutes } from './modules/organization/organization.controller.js';
import { registerDeviceRoutes } from './modules/device/device.controller.js';
import { registerSubscriptionRoutes } from './modules/subscription/subscription.controller.js';

export function createApp(): Router {
  const router = new Router();

  // Health check
  router.get('/v1/health', () => ({
    success: true,
    data: {
      status: 'UP',
      service: '@brisksms/api',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
  }));

  // Domain Routes
  registerAuthRoutes(router);
  registerOrganizationRoutes(router);
  registerDeviceRoutes(router);
  registerSubscriptionRoutes(router);

  return router;
}
