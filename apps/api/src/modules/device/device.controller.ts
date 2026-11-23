import { Router, RouteRequest, ApiResponse, HttpException } from '../../core/http.js';
import { deviceService, PairDeviceDto, TelemetryDto, DeviceCommandType } from './device.service.js';
import {
  ApiKeyScope,
  BriskError,
  CreatePairingChallengeRequest,
  DeviceCommandAckInput,
  DeviceCommandStatus,
} from '@brisksms/shared';
import {
  authenticate,
  assertHumanSessionAuth,
  assertOAuthScope,
  resolveAuthorizedTenantOrgId,
} from '../../core/guards.js';
import { authService } from '../auth/auth.service.js';

function mapDeviceDomainError(err: unknown): never {
  if (err instanceof BriskError) {
    throw new HttpException(err.statusCode, err.code, err.message, err.details);
  }
  throw err;
}

function extractDeviceBearerToken(req: RouteRequest): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    throw new HttpException(401, 'UNAUTHORIZED', 'Missing Authorization header with device token');
  }

  const [scheme, deviceToken] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !deviceToken) {
    throw new HttpException(401, 'UNAUTHORIZED', 'Invalid device token format');
  }

  return deviceToken;
}

async function resolveAdminOrgContext(
  req: RouteRequest,
  suppliedOrgId?: unknown,
  options?: { allowOAuthScopes?: ApiKeyScope[]; actionDescription?: string },
): Promise<{ userId: string; orgId: string }> {
  await authenticate(req);
  if (options?.allowOAuthScopes && options.allowOAuthScopes.length > 0) {
    assertOAuthScope(req, options.allowOAuthScopes);
  } else {
    assertHumanSessionAuth(req, options?.actionDescription ?? 'device administration');
  }
  const userId = req.context.userId!;
  const orgId = resolveAuthorizedTenantOrgId(req, suppliedOrgId);
  return { userId, orgId };
}

function extractIdempotencyKey(req: RouteRequest, body: Record<string, unknown>): string | undefined {
  const rawHeader = req.headers['idempotency-key'] ?? req.headers['Idempotency-Key'];
  const headerIdem = typeof rawHeader === 'string' ? rawHeader.trim() : undefined;
  const bodyIdem = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : undefined;

  if (rawHeader !== undefined && !headerIdem) {
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
  return idempotencyKey;
}

export function registerDeviceRoutes(router: Router): void {
  // Generate QR pairing token
  router.post('/v1/devices/pairing-token', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { userId, orgId } = await resolveAdminOrgContext(req, body.organizationId, {
      actionDescription: 'generating device pairing tokens',
    });

    try {
      const tokenData = await deviceService.createPairingToken(orgId, userId);
      return {
        success: true,
        data: tokenData,
      };
    } catch (err) {
      mapDeviceDomainError(err);
    }
  });

  // Step 1: Request single-use PoP challenge bound to token, org, enrollment, and public key
  router.post('/v1/devices/pairing-challenge', async (req: RouteRequest): Promise<ApiResponse> => {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.includes('bsk_dev_')) {
      throw new HttpException(
        409,
        'DEVICE_KEY_REPLACEMENT_FORBIDDEN',
        'Authenticated devices cannot silently re-pair or replace device keys via pairing',
      );
    }

    const dto = (req.body || {}) as unknown as CreatePairingChallengeRequest;
    await authService.checkRateLimit(`pair_chal_${dto.enrollmentToken || (req.body as any)?.pairingToken || 'anon'}`, 20, 60_000);
    try {
      const challenge = await deviceService.createPairingChallenge(dto);
      return {
        success: true,
        data: challenge,
      };
    } catch (err) {
      mapDeviceDomainError(err);
    }
  });

  // Step 2: Pair device after verifying ECDSA P-256 challenge signature
  router.post('/v1/devices/pair', async (req: RouteRequest): Promise<ApiResponse> => {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.includes('bsk_dev_')) {
      throw new HttpException(
        409,
        'DEVICE_KEY_REPLACEMENT_FORBIDDEN',
        'Authenticated devices cannot silently re-pair or replace device keys via pairing',
      );
    }

    const dto = (req.body || {}) as unknown as PairDeviceDto;
    await authService.checkRateLimit(`pair_exec_${dto.enrollmentToken || (req.body as any)?.pairingToken || 'anon'}`, 15, 60_000);
    try {
      const result = await deviceService.pairDevice(dto);
      return {
        success: true,
        data: result,
      };
    } catch (err) {
      mapDeviceDomainError(err);
    }
  });

  // List organization devices
  router.get('/v1/devices', async (req: RouteRequest): Promise<ApiResponse> => {
    const { userId, orgId } = await resolveAdminOrgContext(req, req.query.organizationId, {
      allowOAuthScopes: [ApiKeyScope.DEVICES_READ],
      actionDescription: 'listing organization devices',
    });

    const devices = await deviceService.listDevices(orgId, userId);
    return {
      success: true,
      data: devices,
    };
  });

  // Get specific device and telemetry
  router.get('/v1/devices/:id', async (req: RouteRequest): Promise<ApiResponse> => {
    const { userId, orgId } = await resolveAdminOrgContext(req, req.query.organizationId, {
      allowOAuthScopes: [ApiKeyScope.DEVICES_READ],
      actionDescription: 'inspecting device details',
    });
    const deviceId = req.params.id || '';

    const details = await deviceService.getDevice(deviceId, orgId, userId);
    return {
      success: true,
      data: details,
    };
  });

  // Record device telemetry heartbeat and claim pending/lease-expired commands
  router.post('/v1/devices/:id/telemetry', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceId = req.params.id || '';
    const deviceToken = extractDeviceBearerToken(req);
    await authService.checkRateLimit(`dev_telem_${deviceId}`, 120, 60_000);

    const dto = (req.body || {}) as unknown as TelemetryDto;
    const telemetry = await deviceService.recordTelemetry(deviceId, deviceToken, dto);
    return {
      success: true,
      data: telemetry,
    };
  });

  // Acknowledge execution of a delivered remote device command
  router.post('/v1/devices/:id/commands/:commandId/ack', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceId = req.params.id || '';
    const commandId = req.params.commandId || '';
    const deviceToken = extractDeviceBearerToken(req);

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as unknown as Omit<
      DeviceCommandAckInput,
      'commandId'
    >;

    const result = await deviceService.acknowledgeCommand(deviceId, deviceToken, commandId, body);
    return {
      success: true,
      data: result,
    };
  });

  // The phone unpairs itself (device token), so its plan slot is freed
  router.post('/v1/devices/:id/disconnect', async (req: RouteRequest): Promise<ApiResponse> => {
    const deviceId = req.params.id || '';
    const deviceToken = extractDeviceBearerToken(req);
    await authService.checkRateLimit(`dev_disc_${deviceId}`, 10, 60_000);

    const device = await deviceService.disconnectDevice(deviceId, deviceToken);
    return {
      success: true,
      data: { deviceId: device.id, status: device.status },
    };
  });

  // Revoke device
  router.post('/v1/devices/:id/revoke', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { userId, orgId } = await resolveAdminOrgContext(req, body.organizationId);
    const deviceId = req.params.id || '';

    const revoked = await deviceService.revokeDevice(deviceId, orgId, userId);
    return {
      success: true,
      data: revoked,
    };
  });

  // Queue remote device command (Fleet Management)
  router.post('/v1/devices/:id/command', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { userId, orgId } = await resolveAdminOrgContext(req, body.organizationId);
    const deviceId = req.params.id || '';
    const idempotencyKey = extractIdempotencyKey(req, body);

    const commandType = body.type as DeviceCommandType;
    const ttlSeconds = body.ttlSeconds as number | undefined;

    const cmd = await deviceService.queueCommand(
      deviceId,
      orgId,
      userId,
      commandType,
      body.payload as Record<string, unknown> | undefined,
      { idempotencyKey, ttlSeconds },
    );

    return {
      success: true,
      data: cmd,
    };
  });

  // List durable remote command history for a device
  router.get('/v1/devices/:id/commands', async (req: RouteRequest): Promise<ApiResponse> => {
    const { userId, orgId } = await resolveAdminOrgContext(req, req.query.organizationId, {
      allowOAuthScopes: [ApiKeyScope.DEVICES_READ],
      actionDescription: 'listing device commands',
    });
    const deviceId = req.params.id || '';
    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const limit = rawLimit !== undefined && !Number.isNaN(rawLimit) ? rawLimit : undefined;
    const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;

    if (
      rawStatus &&
      !Object.values(DeviceCommandStatus).includes(rawStatus as DeviceCommandStatus)
    ) {
      throw new HttpException(400, 'VALIDATION_ERROR', `Invalid status filter '${rawStatus}'`);
    }

    const commands = await deviceService.listDeviceCommands(deviceId, orgId, userId, {
      limit,
      status: rawStatus as DeviceCommandStatus | undefined,
    });

    return {
      success: true,
      data: commands,
    };
  });

  // Cancel a pending or leased remote device command
  router.post('/v1/devices/:id/commands/:commandId/cancel', async (req: RouteRequest): Promise<ApiResponse> => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const { userId, orgId } = await resolveAdminOrgContext(req, body.organizationId);
    const deviceId = req.params.id || '';
    const commandId = req.params.commandId || '';
    const reason = typeof body.reason === 'string' ? body.reason : undefined;

    const cancelled = await deviceService.cancelDeviceCommand(deviceId, commandId, orgId, userId, reason);
    return {
      success: true,
      data: cancelled,
    };
  });
}
