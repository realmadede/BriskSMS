import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { deviceService, PairDeviceDto, TelemetryDto } from './device.service.js';
import { authenticate } from '../../core/guards.js';

export function registerDeviceRoutes(router: Router): void {
  // Generate QR pairing token
  router.post('/v1/devices/pairing-token', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.context.organizationId || (req.body.organizationId as string);

    if (!orgId) {
      throw new HttpException(400, 'MISSING_ORG', 'Organization context or organizationId is required');
    }

    const tokenData = await deviceService.createPairingToken(orgId, userId);
    return {
      success: true,
      data: tokenData,
    };
  });

  // Pair device (called from Android app with enrollment token)
  router.post('/v1/devices/pair', async (req: RouteRequest): Promise<ApiResponse> => {
    const dto = req.body as unknown as PairDeviceDto;
    const result = await deviceService.pairDevice(dto);
    return {
      success: true,
      data: result,
    };
  });

  // List organization devices
  router.get('/v1/devices', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.context.organizationId || (req.query.organizationId as string);

    if (!orgId) {
      throw new HttpException(400, 'MISSING_ORG', 'Organization context or query param organizationId is required');
    }

    const devices = await deviceService.listDevices(orgId, userId);
    return {
      success: true,
      data: devices,
    };
  });

  // Get specific device and telemetry
  router.get('/v1/devices/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.context.organizationId || (req.query.organizationId as string);
    const deviceId = req.params.id || '';

    if (!orgId) {
      throw new HttpException(400, 'MISSING_ORG', 'Organization context or query param organizationId is required');
    }

    const details = await deviceService.getDevice(deviceId, orgId, userId);
    return {
      success: true,
      data: details,
    };
  });

  // Record device telemetry heartbeat
  router.post('/v1/devices/:id/telemetry', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceId = req.params.id || '';
    const authHeader = req.headers.authorization;

    if (!authHeader || typeof authHeader !== 'string') {
      throw new HttpException(401, 'UNAUTHORIZED', 'Missing Authorization header with device token');
    }

    const [scheme, deviceToken] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !deviceToken) {
      throw new HttpException(401, 'UNAUTHORIZED', 'Invalid device token format');
    }

    const dto = req.body as unknown as TelemetryDto;
    const telemetry = await deviceService.recordTelemetry(deviceId, deviceToken, dto);
    return {
      success: true,
      data: telemetry,
    };
  });

  // Revoke device
  router.post('/v1/devices/:id/revoke', async (req: RouteRequest): Promise<ApiResponse> => {
    authenticate(req);
    const userId = req.context.userId!;
    const orgId = req.context.organizationId || (req.body.organizationId as string);
    const deviceId = req.params.id || '';

    if (!orgId) {
      throw new HttpException(400, 'MISSING_ORG', 'Organization context or body organizationId is required');
    }

    const revoked = await deviceService.revokeDevice(deviceId, orgId, userId);
    return {
      success: true,
      data: revoked,
    };
  });
}
