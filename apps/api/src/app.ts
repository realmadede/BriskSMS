import { Router } from './core/http.js';
import { syncTokenBlacklistFromDb, ensureRevocationSync, isRevocationReady } from './core/guards.js';
import {
  checkDatabaseHealth,
  checkRedisHealth,
  checkWorkerHealth,
  checkQueueHealth,
} from '@brisksms/db';
import { registerAuthRoutes } from './modules/auth/auth.controller.js';
import { registerAccountRoutes } from './modules/account/account.controller.js';
import { registerOrganizationRoutes } from './modules/organization/organization.controller.js';
import { registerDeviceRoutes } from './modules/device/device.controller.js';
import { registerSubscriptionRoutes } from './modules/subscription/subscription.controller.js';
import { registerAdminRoutes } from './modules/admin/admin.controller.js';
import { registerCreditPurchaseRoutes } from './modules/messaging/credit-purchase.controller.js';
import { registerIngestionRoutes } from './modules/ingestion/ingestion.controller.js';
import { registerMessagingRoutes } from './modules/messaging/messaging.controller.js';
import { registerReconciliationRoutes } from './modules/reconciliation/reconciliation.controller.js';
import { registerDeveloperRoutes } from './modules/developer/developer.controller.js';
import { registerOAuthRoutes } from './modules/oauth/oauth.controller.js';
import { registerStkPushRoutes } from './modules/stk-push/stk-push.controller.js';
import { registerAppReleaseRoutes } from './modules/app-release/app-release.controller.js';

export function createApp(options?: { tokenBlacklist?: Set<string> }): Router {
  const router = new Router();
  if (options?.tokenBlacklist) {
    router.tokenBlacklist = options.tokenBlacklist;
  }

  // Synchronize active revoked access tokens from PostgreSQL into in-memory fast blacklist
  syncTokenBlacklistFromDb(router.tokenBlacklist).catch(() => {});

  // Dedicated Liveness Probe (distinguished from readiness)
  router.get('/v1/health/live', async () => {
    return {
      success: true,
      statusCode: 200,
      data: {
        status: 'UP',
        service: '@brisksms/api',
        process: { status: 'UP', pid: process.pid, uptime: process.uptime() },
      },
    };
  });

  // Dedicated Readiness Probe (strictly validates DB, Redis, and revocation synchronization)
  router.get('/v1/health/ready', async () => {
    await ensureRevocationSync(router.tokenBlacklist).catch(() => {});
    const [dbHealth, redisHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
    ]);

    const revReady = isRevocationReady(router.tokenBlacklist);
    const isReady = dbHealth.status === 'UP' && redisHealth.status === 'UP' && revReady;
    return {
      success: isReady,
      statusCode: isReady ? 200 : 503,
      data: {
        status: isReady ? 'UP' : 'DOWN',
        service: '@brisksms/api',
        revocationSync: revReady ? 'UP' : 'DOWN',
        postgresql: dbHealth.status,
        redis: redisHealth.status,
      },
    };
  });

  // Production Health & Readiness Endpoint
  router.get('/v1/health', async () => {
    await ensureRevocationSync(router.tokenBlacklist).catch(() => {});
    const [dbHealth, redisHealth, workerHealth, queueHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      checkWorkerHealth(),
      checkQueueHealth(),
    ]);

    const revReady = isRevocationReady(router.tokenBlacklist);
    const criticalHealthy = dbHealth.status === 'UP' && redisHealth.status === 'UP' && revReady;
    const overallStatus = !criticalHealthy
      ? 'DOWN'
      : workerHealth.status === 'UP' && queueHealth.status === 'UP'
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
          revocationSync: { status: revReady ? 'UP' : 'DOWN' },
          worker: workerHealth,
          queues: queueHealth,
        },
      },
    };
  });

  // Domain Routes
  registerAuthRoutes(router);
  registerAccountRoutes(router);
  registerOrganizationRoutes(router);
  registerDeviceRoutes(router);
  registerSubscriptionRoutes(router);
  registerAdminRoutes(router);
  registerCreditPurchaseRoutes(router);
  registerIngestionRoutes(router);
  registerMessagingRoutes(router);
  registerReconciliationRoutes(router);
  registerDeveloperRoutes(router);
  registerOAuthRoutes(router);
  registerStkPushRoutes(router);
  registerAppReleaseRoutes(router);

  return router;
}
