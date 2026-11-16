import { createHash } from 'node:crypto';
import {
  DeviceCommand,
  DeviceCommandAckInput,
  DeviceCommandStatus,
  DeviceCommandType,
  DeviceCommandTypeLiteral,
} from '@brisksms/shared';
import { HttpException } from '../../core/http.js';

export const ALLOWED_DEVICE_COMMAND_TYPES: readonly DeviceCommandTypeLiteral[] = [
  DeviceCommandType.PAUSE_RELAY,
  DeviceCommandType.RESUME_RELAY,
  DeviceCommandType.SWITCH_SIM,
  DeviceCommandType.WIPE_AND_REVOKE,
] as const;

export const DEFAULT_COMMAND_TTL_SECONDS = 3600;
export const MIN_COMMAND_TTL_SECONDS = 5;
export const MAX_COMMAND_TTL_SECONDS = 604800;

export const DEFAULT_COMMAND_LEASE_SECONDS = 60;
export const MIN_COMMAND_LEASE_SECONDS = 5;
export const MAX_COMMAND_LEASE_SECONDS = 3600;

export const DEFAULT_COMMAND_MAX_ATTEMPTS = 5;
export const WIPE_COMMAND_MAX_ATTEMPTS = 1;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|private_?key|authorization|api_?key)/i;
const MAX_ACK_RESULT_BYTES = 2048;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

export function resolveCommandTtlSeconds(override?: unknown): number {
  if (override !== undefined) {
    const parsed = Number(override);
    if (!Number.isInteger(parsed) || parsed < MIN_COMMAND_TTL_SECONDS || parsed > MAX_COMMAND_TTL_SECONDS) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        `ttlSeconds must be an integer between ${MIN_COMMAND_TTL_SECONDS} and ${MAX_COMMAND_TTL_SECONDS}`,
      );
    }
    return parsed;
  }

  const rawEnv = process.env.DEVICE_COMMAND_TTL_SECONDS;
  if (!rawEnv || rawEnv.trim().length === 0) {
    return DEFAULT_COMMAND_TTL_SECONDS;
  }
  const parsedEnv = Number(rawEnv);
  if (!Number.isInteger(parsedEnv) || parsedEnv < MIN_COMMAND_TTL_SECONDS || parsedEnv > MAX_COMMAND_TTL_SECONDS) {
    throw new HttpException(
      500,
      'INVALID_DEVICE_COMMAND_CONFIG',
      `DEVICE_COMMAND_TTL_SECONDS must be an integer between ${MIN_COMMAND_TTL_SECONDS} and ${MAX_COMMAND_TTL_SECONDS}`,
    );
  }
  return parsedEnv;
}

export function resolveCommandLeaseSeconds(override?: unknown): number {
  if (override !== undefined) {
    const parsed = Number(override);
    if (!Number.isInteger(parsed) || parsed < MIN_COMMAND_LEASE_SECONDS || parsed > MAX_COMMAND_LEASE_SECONDS) {
      throw new HttpException(
        400,
        'VALIDATION_ERROR',
        `leaseSeconds must be an integer between ${MIN_COMMAND_LEASE_SECONDS} and ${MAX_COMMAND_LEASE_SECONDS}`,
      );
    }
    return parsed;
  }

  const rawEnv = process.env.DEVICE_COMMAND_LEASE_SECONDS;
  if (!rawEnv || rawEnv.trim().length === 0) {
    return DEFAULT_COMMAND_LEASE_SECONDS;
  }
  const parsedEnv = Number(rawEnv);
  if (
    !Number.isInteger(parsedEnv) ||
    parsedEnv < MIN_COMMAND_LEASE_SECONDS ||
    parsedEnv > MAX_COMMAND_LEASE_SECONDS
  ) {
    throw new HttpException(
      500,
      'INVALID_DEVICE_COMMAND_CONFIG',
      `DEVICE_COMMAND_LEASE_SECONDS must be an integer between ${MIN_COMMAND_LEASE_SECONDS} and ${MAX_COMMAND_LEASE_SECONDS}`,
    );
  }
  return parsedEnv;
}

function assertPlainObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpException(400, 'INVALID_COMMAND_PAYLOAD', `${fieldName} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertNoSensitiveKeys(obj: Record<string, unknown>, path = ''): void {
  for (const [k, v] of Object.entries(obj)) {
    const fullPath = path ? `${path}.${k}` : k;
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      throw new HttpException(
        400,
        'INVALID_COMMAND_PAYLOAD',
        `Sensitive credential field '${fullPath}' is not allowed in command payloads or results`,
      );
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      assertNoSensitiveKeys(v as Record<string, unknown>, fullPath);
    }
  }
}

export function validateDeviceCommandInput(
  typeRaw: unknown,
  payloadRaw?: unknown,
): { commandType: DeviceCommandTypeLiteral; normalizedPayload: Record<string, unknown> } {
  if (
    typeof typeRaw !== 'string' ||
    !ALLOWED_DEVICE_COMMAND_TYPES.includes(typeRaw as DeviceCommandTypeLiteral)
  ) {
    throw new HttpException(
      400,
      'INVALID_COMMAND',
      'type must be PAUSE_RELAY, RESUME_RELAY, SWITCH_SIM, or WIPE_AND_REVOKE',
    );
  }

  const commandType = typeRaw as DeviceCommandTypeLiteral;

  if (commandType === DeviceCommandType.PAUSE_RELAY || commandType === DeviceCommandType.RESUME_RELAY) {
    if (payloadRaw !== undefined && payloadRaw !== null) {
      const obj = assertPlainObject(payloadRaw, 'payload');
      const keys = Object.keys(obj);
      if (keys.length > 0) {
        throw new HttpException(
          400,
          'INVALID_COMMAND_PAYLOAD',
          `${commandType} does not accept payload fields (unexpected: ${keys.join(', ')})`,
        );
      }
    }
    return { commandType, normalizedPayload: {} };
  }

  if (commandType === DeviceCommandType.SWITCH_SIM) {
    if (payloadRaw === undefined || payloadRaw === null) {
      throw new HttpException(400, 'INVALID_COMMAND_PAYLOAD', 'SWITCH_SIM requires payload.simSlot (1 or 2)');
    }
    const obj = assertPlainObject(payloadRaw, 'payload');
    const unexpectedKeys = Object.keys(obj).filter((k) => k !== 'simSlot');
    if (unexpectedKeys.length > 0) {
      throw new HttpException(
        400,
        'INVALID_COMMAND_PAYLOAD',
        `SWITCH_SIM only accepts 'simSlot' (unexpected: ${unexpectedKeys.join(', ')})`,
      );
    }
    const simSlot = obj.simSlot;
    if (typeof simSlot !== 'number' || !Number.isInteger(simSlot) || (simSlot !== 1 && simSlot !== 2)) {
      throw new HttpException(400, 'INVALID_COMMAND_PAYLOAD', 'SWITCH_SIM payload.simSlot must be integer 1 or 2');
    }
    return { commandType, normalizedPayload: { simSlot } };
  }

  // WIPE_AND_REVOKE
  if (payloadRaw !== undefined && payloadRaw !== null) {
    const obj = assertPlainObject(payloadRaw, 'payload');
    const unexpectedKeys = Object.keys(obj).filter((k) => k !== 'reason');
    if (unexpectedKeys.length > 0) {
      throw new HttpException(
        400,
        'INVALID_COMMAND_PAYLOAD',
        `WIPE_AND_REVOKE only accepts optional 'reason' (unexpected: ${unexpectedKeys.join(', ')})`,
      );
    }
    if (obj.reason !== undefined) {
      if (typeof obj.reason !== 'string' || obj.reason.trim().length === 0 || obj.reason.trim().length > 255) {
        throw new HttpException(
          400,
          'INVALID_COMMAND_PAYLOAD',
          'WIPE_AND_REVOKE payload.reason must be a non-empty string up to 255 characters',
        );
      }
      return { commandType, normalizedPayload: { reason: obj.reason.trim() } };
    }
  }

  return { commandType, normalizedPayload: {} };
}

export function normalizeIdempotencyKey(raw?: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey must be a non-empty string when provided');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey cannot be blank when provided');
  }
  if (trimmed.length > 120) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'idempotencyKey must be 120 characters or fewer');
  }
  return trimmed;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeCommandRequestFingerprint(params: {
  organizationId: string;
  deviceId: string;
  commandType: DeviceCommandTypeLiteral;
  payload: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify(canonicalizeValue(params));
  return createHash('sha256').update(canonical).digest('hex');
}

export interface ValidatedCommandAck {
  commandId: string;
  status: DeviceCommandStatus.ACKNOWLEDGED | DeviceCommandStatus.FAILED;
  leaseToken?: string;
  result: Record<string, unknown> | null;
  failureReason: string | null;
}

export function validateCommandAckInput(raw: unknown): ValidatedCommandAck {
  const obj = assertPlainObject(raw, 'acknowledgement');

  if (!isValidUuid(obj.commandId)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'commandId must be a valid UUID');
  }
  const commandId = obj.commandId.trim();

  if (obj.status !== DeviceCommandStatus.ACKNOWLEDGED && obj.status !== DeviceCommandStatus.FAILED) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'status must be ACKNOWLEDGED or FAILED');
  }

  let leaseToken: string | undefined;
  if (obj.leaseToken !== undefined && obj.leaseToken !== null) {
    if (!isValidUuid(obj.leaseToken)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'leaseToken must be a valid UUID when provided');
    }
    leaseToken = obj.leaseToken.trim();
  }

  let failureReason: string | null = null;
  if (obj.failureReason !== undefined && obj.failureReason !== null) {
    if (typeof obj.failureReason !== 'string' || obj.failureReason.trim().length === 0) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'failureReason must be a non-empty string when provided');
    }
    failureReason = obj.failureReason.trim().slice(0, 255);
  }
  if (obj.status === DeviceCommandStatus.FAILED && !failureReason) {
    failureReason = 'Device reported command execution failure';
  }

  let result: Record<string, unknown> | null = null;
  if (obj.result !== undefined && obj.result !== null) {
    const resObj = assertPlainObject(obj.result, 'result');
    assertNoSensitiveKeys(resObj);
    const serialized = JSON.stringify(resObj);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ACK_RESULT_BYTES) {
      throw new HttpException(
        400,
        'INVALID_COMMAND_PAYLOAD',
        `ack result payload exceeds ${MAX_ACK_RESULT_BYTES} bytes`,
      );
    }
    result = resObj;
  }

  return {
    commandId,
    status: obj.status,
    leaseToken,
    result,
    failureReason,
  };
}

function parseJsonObjectColumn(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function mapDeviceCommandRow(row: Record<string, any>): DeviceCommand {
  const parsedPayload = parseJsonObjectColumn(row.payload) ?? {};
  const payload = Object.keys(parsedPayload).length > 0 ? parsedPayload : undefined;
  const rawAckResult = parseJsonObjectColumn(row.ack_result);

  return {
    id: row.id,
    organizationId: row.organization_id,
    deviceId: row.device_id,
    type: row.command_type as DeviceCommandTypeLiteral,
    payload,
    status: row.status as DeviceCommandStatus,
    createdById: row.created_by_id ?? null,
    source: row.source ?? 'ADMIN_API',
    deliveryAttempts: Number(row.delivery_attempts ?? 0),
    maxDeliveryAttempts: Number(row.max_delivery_attempts ?? DEFAULT_COMMAND_MAX_ATTEMPTS),
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    lastDeliveryAttemptAt: row.last_delivery_attempt_at
      ? new Date(row.last_delivery_attempt_at).toISOString()
      : null,
    acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : null,
    ackResult: rawAckResult,
    failureReason: row.failure_reason ?? null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    cancelledById: row.cancelled_by_id ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function parseTelemetryCommandAcks(rawAcks: unknown): DeviceCommandAckInput[] {
  if (rawAcks === undefined || rawAcks === null) {
    return [];
  }
  if (!Array.isArray(rawAcks)) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'commandAcknowledgements must be an array');
  }
  if (rawAcks.length > 50) {
    throw new HttpException(400, 'VALIDATION_ERROR', 'commandAcknowledgements cannot exceed 50 items per request');
  }
  return rawAcks.map((item) => {
    const validated = validateCommandAckInput(item);
    return {
      commandId: validated.commandId,
      status: validated.status,
      leaseToken: validated.leaseToken,
      result: validated.result ?? undefined,
      failureReason: validated.failureReason ?? undefined,
    };
  });
}
