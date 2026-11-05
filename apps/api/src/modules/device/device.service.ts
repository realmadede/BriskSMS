import { dbStore, DeviceRecord, DeviceTelemetryRecord } from '../../core/store.js';
import { DeviceStatus, DeviceIngestionMode, UserRole } from '@brisksms/shared';
import { HttpException } from '../../core/http.js';
import { generateSecureToken, hashToken } from '../../core/crypto.js';
import { entitlementService } from '../subscription/entitlement.service.js';

export interface PairingTokenResponse {
  pairingToken: string;
  organizationId: string;
  expiresAt: string;
  qrPayload: string;
}

export interface PairDeviceDto {
  enrollmentToken: string;
  label?: string;
  publicKeyPem: string;
  deviceModel: string;
  manufacturer: string;
  androidVersion: string;
  appVersion: string;
  ingestionMode?: DeviceIngestionMode;
}

export interface PairDeviceResult {
  deviceId: string;
  organizationId: string;
  deviceToken: string;
  syncIntervalSeconds: number;
}

export interface TelemetryDto {
  batteryPercentage: number;
  isCharging: boolean;
  networkType: string;
  signalStrengthDbm?: number | null;
  pendingOfflineCount?: number;
}

export class DeviceService {
  async createPairingToken(organizationId: string, actorUserId: string): Promise<PairingTokenResponse> {
    const mem = dbStore.getMembership(organizationId, actorUserId);
    if (!mem || ![UserRole.OWNER, UserRole.ADMIN].includes(mem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can pair new Android devices');
    }

    // Dynamic Entitlement: Prevent issuing pairing token if tenant exceeds configured device quota
    entitlementService.enforceDeviceQuota(organizationId);

    const rawToken = generateSecureToken('bsk_pair', 24);
    const pairingRecord = dbStore.createPairingToken({
      organizationId,
      createdById: actorUserId,
      token: rawToken,
      ttlSeconds: 300, // 5 minutes validity
    });

    const qrPayload = JSON.stringify({
      token: rawToken,
      org: organizationId,
      endpoint: process.env.API_BASE_URL || 'https://api.brisksms.co.tz/v1',
      exp: pairingRecord.expiresAt.toISOString(),
    });

    return {
      pairingToken: rawToken,
      organizationId,
      expiresAt: pairingRecord.expiresAt.toISOString(),
      qrPayload,
    };
  }

  async pairDevice(dto: PairDeviceDto): Promise<PairDeviceResult> {
    if (!dto.enrollmentToken || !dto.publicKeyPem || !dto.deviceModel) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'enrollmentToken, publicKeyPem, and deviceModel are required');
    }

    const tokenRecord = dbStore.getPairingToken(dto.enrollmentToken);
    if (!tokenRecord) {
      throw new HttpException(401, 'INVALID_PAIRING_TOKEN', 'Pairing token is invalid, already used, or expired');
    }

    // Mark pairing token as consumed
    tokenRecord.usedAt = new Date();

    const rawDeviceToken = generateSecureToken('bsk_dev', 32);
    const tokenHash = hashToken(rawDeviceToken);

    const device = dbStore.registerDevice({
      organizationId: tokenRecord.organizationId,
      label: dto.label || `${dto.manufacturer || 'Android'} ${dto.deviceModel}`,
      deviceModel: dto.deviceModel,
      manufacturer: dto.manufacturer || 'Generic',
      androidVersion: dto.androidVersion || '14',
      appVersion: dto.appVersion || '1.0.0',
      publicKeyPem: dto.publicKeyPem,
      ingestionMode: dto.ingestionMode || DeviceIngestionMode.NOTIFICATION_LISTENER,
      tokenHash,
    });

    return {
      deviceId: device.id,
      organizationId: device.organizationId,
      deviceToken: rawDeviceToken,
      syncIntervalSeconds: 30,
    };
  }

  async listDevices(organizationId: string, actorUserId: string): Promise<DeviceRecord[]> {
    const mem = dbStore.getMembership(organizationId, actorUserId);
    if (!mem) {
      throw new HttpException(403, 'FORBIDDEN', 'No access to organization devices');
    }
    return dbStore.getOrgDevices(organizationId);
  }

  async getDevice(deviceId: string, organizationId: string, actorUserId: string): Promise<{ device: DeviceRecord; telemetryHistory: DeviceTelemetryRecord[] }> {
    const mem = dbStore.getMembership(organizationId, actorUserId);
    if (!mem) {
      throw new HttpException(403, 'FORBIDDEN', 'No access to organization devices');
    }

    const device = dbStore.getDeviceById(deviceId, organizationId);
    if (!device) {
      throw new HttpException(404, 'DEVICE_NOT_FOUND', 'Device not found in this organization');
    }

    const telemetryHistory = dbStore.getDeviceTelemetry(deviceId, 20);
    return { device, telemetryHistory };
  }

  async recordTelemetry(deviceId: string, deviceToken: string, dto: TelemetryDto): Promise<DeviceTelemetryRecord> {
    const tokenHash = hashToken(deviceToken);
    const device = dbStore.getDeviceByTokenHash(tokenHash);

    if (!device || device.id !== deviceId) {
      throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Device authentication failed');
    }

    if (device.status === DeviceStatus.REVOKED) {
      throw new HttpException(403, 'DEVICE_REVOKED', 'This device has been revoked by the organization');
    }

    return dbStore.recordTelemetry({
      deviceId,
      batteryPct: Math.max(0, Math.min(100, dto.batteryPercentage ?? 100)),
      isCharging: Boolean(dto.isCharging),
      networkType: dto.networkType || 'WIFI',
      signalStrengthDbm: dto.signalStrengthDbm ?? null,
      pendingOfflineCount: dto.pendingOfflineCount || 0,
    });
  }

  async revokeDevice(deviceId: string, organizationId: string, actorUserId: string): Promise<DeviceRecord> {
    const mem = dbStore.getMembership(organizationId, actorUserId);
    if (!mem || ![UserRole.OWNER, UserRole.ADMIN].includes(mem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can revoke devices');
    }

    return dbStore.revokeDevice(deviceId, organizationId, actorUserId);
  }
}

export const deviceService = new DeviceService();
