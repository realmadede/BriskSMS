import {
  DeviceStatus,
  DeviceIngestionMode,
  DeviceCommandType,
  DeviceCommandStatus,
} from '../enums/device-status.enum.js';

export const DEVICE_PAIRING_POP_PROTOCOL_VERSION = 'BRISKSMS-DEVICE-PAIRING-POP-V1' as const;
export const SUPPORTED_DEVICE_KEY_ALGORITHM = 'EC_P256' as const;
export const SUPPORTED_DEVICE_SIGNATURE_ALGORITHM = 'SHA256_ECDSA' as const;

export type DeviceKeyAlgorithm = typeof SUPPORTED_DEVICE_KEY_ALGORITHM;
export type DeviceSignatureAlgorithm = typeof SUPPORTED_DEVICE_SIGNATURE_ALGORITHM;

export enum PairingChallengeStatus {
  PENDING = 'PENDING',
  CONSUMED = 'CONSUMED',
  EXPIRED = 'EXPIRED',
  REJECTED = 'REJECTED',
}

export interface CreatePairingChallengeRequest {
  enrollmentToken: string;
  publicKeyPem: string;
  organizationId?: string;
  keyAlgorithm?: string;
  signatureAlgorithm?: string;
  deviceId?: string;
}

export interface CreatePairingChallengeResponse {
  protocolVersion: typeof DEVICE_PAIRING_POP_PROTOCOL_VERSION;
  challengeId: string;
  enrollmentId: string;
  organizationId: string;
  challenge: string;
  publicKeyFingerprint: string;
  keyAlgorithm: DeviceKeyAlgorithm;
  signatureAlgorithm: DeviceSignatureAlgorithm;
  issuedAt: string;
  expiresAt: string;
}

export interface DeviceRegistrationRequest {
  enrollmentToken: string;
  challengeId: string;
  challengeSignature: string;
  publicKeyPem: string;
  deviceModel: string;
  manufacturer: string;
  androidVersion: string;
  appVersion: string;
  label?: string;
  ingestionMode?: DeviceIngestionMode;
  organizationId?: string;
  enrollmentId?: string;
  keyAlgorithm?: string;
  signatureAlgorithm?: string;
  deviceId?: string;
}

export interface DeviceEnrollmentResponse {
  deviceId: string;
  organizationId: string;
  deviceToken: string;
  publicKeyFingerprint: string;
  keyAlgorithm: DeviceKeyAlgorithm;
  serverPublicKeyPem?: string;
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
  publicKeyFingerprint?: string | null;
  keyAlgorithm?: string;
  lastSyncAt: Date | null;
  createdAt: Date;
}

export type DeviceCommandTypeLiteral = `${DeviceCommandType}`;

export interface DeviceCommand {
  id: string;
  organizationId: string;
  deviceId: string;
  type: DeviceCommandTypeLiteral;
  payload?: Record<string, unknown>;
  status: DeviceCommandStatus;
  createdById?: string | null;
  source: string;
  deliveryAttempts: number;
  maxDeliveryAttempts: number;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  deliveredAt?: string | null;
  lastDeliveryAttemptAt?: string | null;
  acknowledgedAt?: string | null;
  ackResult?: Record<string, unknown> | null;
  failureReason?: string | null;
  cancelledAt?: string | null;
  cancelledById?: string | null;
  cancellationReason?: string | null;
  idempotencyKey?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceCommandAckInput {
  commandId: string;
  status: DeviceCommandStatus.ACKNOWLEDGED | DeviceCommandStatus.FAILED | 'ACKNOWLEDGED' | 'FAILED';
  leaseToken?: string;
  result?: Record<string, unknown>;
  failureReason?: string;
  executedAt?: string;
}

export interface QueueDeviceCommandRequest {
  type: DeviceCommandTypeLiteral;
  payload?: Record<string, unknown>;
  organizationId?: string;
  idempotencyKey?: string;
  ttlSeconds?: number;
}

export interface DeviceCommandAckResult {
  command: DeviceCommand;
  idempotentReplay: boolean;
}
