import { DeviceStatus, DeviceIngestionMode } from '../enums/device-status.enum.js';

export interface DeviceRegistrationRequest {
  enrollmentToken: string;
  publicKeyPem: string;
  deviceModel: string;
  manufacturer: string;
  androidVersion: string;
  appVersion: string;
  ingestionMode: DeviceIngestionMode;
}

export interface DeviceEnrollmentResponse {
  deviceId: string;
  organizationId: string;
  deviceToken: string;
  serverPublicKeyPem: string;
  syncIntervalSeconds: number;
}

export interface DeviceHeartbeatTelemetry {
  deviceId: string;
  batteryPercentage: number;
  isCharging: boolean;
  networkType: 'WIFI' | 'CELLULAR' | 'NONE';
  signalStrengthDbm: number | null;
  pendingOfflineCount: number;
  uptimeSeconds: number;
  timestamp: string;
}

export interface DeviceSummary {
  id: string;
  organizationId: string;
  label: string;
  model: string;
  status: DeviceStatus;
  ingestionMode: DeviceIngestionMode;
  lastSyncAt: Date | null;
  createdAt: Date;
}

