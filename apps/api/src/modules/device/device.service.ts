import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dbStore, DeviceRecord, DeviceTelemetryRecord } from '../../core/store.js';
import {
  BriskError,
  CreatePairingChallengeRequest,
  CreatePairingChallengeResponse,
  DEVICE_PAIRING_POP_PROTOCOL_VERSION,
  DeviceCommand,
  DeviceCommandAckInput,
  DeviceCommandAckResult,
  DeviceCommandStatus,
  DeviceCommandTypeLiteral,
  DeviceEnrollmentResponse,
  DeviceIngestionMode,
  DeviceKeyAlgorithm,
  DeviceRegistrationRequest,
  DeviceSignatureAlgorithm,
  DeviceStatus,
  UserRole,
} from '@brisksms/shared';
import { HttpException } from '../../core/http.js';
import { generateSecureToken, hashToken } from '../../core/crypto.js';
import { entitlementService } from '../subscription/entitlement.service.js';
import { SqlExecutor, withTransaction } from '@brisksms/db';
import {
  buildPairingChallengeTranscript,
  parseAndValidateDevicePublicKey,
  validatePairingAlgorithms,
  verifyDevicePairingSignature,
} from './device-crypto.js';
import {
  computeCommandRequestFingerprint,
  DEFAULT_COMMAND_MAX_ATTEMPTS,
  isValidUuid,
  mapDeviceCommandRow,
  normalizeIdempotencyKey,
  parseTelemetryCommandAcks,
  resolveCommandLeaseSeconds,
  resolveCommandTtlSeconds,
  validateCommandAckInput,
  ValidatedCommandAck,
  validateDeviceCommandInput,
  WIPE_COMMAND_MAX_ATTEMPTS,
} from './device-command.validation.js';

export type { DeviceCommand, DeviceCommandTypeLiteral as DeviceCommandType };

export interface DeviceTelemetryAckOutcome {
  commandId: string;
  accepted: boolean;
  status?: DeviceCommandStatus;
  errorCode?: string;
  idempotentReplay?: boolean;
}

export interface DeviceTelemetryResult extends DeviceTelemetryRecord {
  commands: DeviceCommand[];
  ackResults?: DeviceTelemetryAckOutcome[];
}

export interface PairingTokenResponse {
  pairingToken: string;
  organizationId: string;
  expiresAt: string;
  qrPayload: string;
}

export type PairDeviceDto = DeviceRegistrationRequest;
export type PairDeviceResult = DeviceEnrollmentResponse;

export interface TelemetryDto {
  batteryPercentage: number;
  isCharging: boolean;
  networkType: string;
  signalStrengthDbm?: number | null;
  pendingOfflineCount?: number;
  commandAcknowledgements?: DeviceCommandAckInput[];
}

export interface QueueCommandOptions {
  idempotencyKey?: string;
  ttlSeconds?: number;
  source?: string;
}

export interface RecordTelemetryOptions {
  leaseSeconds?: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CHALLENGE_TTL_SECONDS = 120;
const MIN_CHALLENGE_TTL_SECONDS = 10;
const MAX_CHALLENGE_TTL_SECONDS = 300;
const MAX_CHALLENGES_PER_PAIRING_TOKEN = 10;

type PairTxOutcome =
  | { ok: true; result: PairDeviceResult }
  | { ok: false; statusCode: number; code: string; message: string };

export function resolvePairingChallengeTtlSeconds(): number {
  const raw = process.env.PAIRING_CHALLENGE_TTL_SECONDS;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_CHALLENGE_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_CHALLENGE_TTL_SECONDS || parsed > MAX_CHALLENGE_TTL_SECONDS) {
    throw new HttpException(
      500,
      'INVALID_PAIRING_CONFIG',
      `PAIRING_CHALLENGE_TTL_SECONDS must be an integer between ${MIN_CHALLENGE_TTL_SECONDS} and ${MAX_CHALLENGE_TTL_SECONDS}`,
    );
  }
  return parsed;
}

export class DeviceService {
  private readonly instanceId: string;

  constructor(instanceId: string = `api-${process.pid}-${randomUUID().slice(0, 8)}`) {
    this.instanceId = instanceId;
  }
  async createPairingToken(organizationId: string, actorUserId: string): Promise<PairingTokenResponse> {
    const mem = await dbStore.getMembership(organizationId, actorUserId);
    if (!mem || ![UserRole.OWNER, UserRole.ADMIN].includes(mem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can pair new Android devices');
    }

    await entitlementService.enforceDeviceQuota(organizationId);

    const rawToken = generateSecureToken('bsk_pair', 24);
    const pairingRecord = await dbStore.createPairingToken({
      organizationId,
      createdById: actorUserId,
      token: rawToken,
      ttlSeconds: 300,
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

  /**
   * Step 1 of Proof-of-Possession enrollment:
   * Validates pairing token, public key format/curve/size, and key uniqueness,
   * then issues a cryptographically random, single-use challenge bound to the
   * token, organization, enrollment ID, public key fingerprint, algorithms, and expiry.
   */
  async createPairingChallenge(dto: CreatePairingChallengeRequest): Promise<CreatePairingChallengeResponse> {
    if (!dto || !dto.enrollmentToken || typeof dto.enrollmentToken !== 'string') {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'enrollmentToken and publicKeyPem are required');
    }

    if (dto.deviceId || (dto as unknown as Record<string, unknown>).existingDeviceId) {
      throw new HttpException(
        409,
        'DEVICE_KEY_REPLACEMENT_FORBIDDEN',
        'Re-pairing cannot silently replace an existing device key. Revoke the device or use a separate key rotation workflow.',
      );
    }

    const { keyAlgorithm, signatureAlgorithm } = validatePairingAlgorithms(
      dto.keyAlgorithm,
      dto.signatureAlgorithm,
    );
    const parsedKey = parseAndValidateDevicePublicKey(dto.publicKeyPem);
    const ttlSeconds = resolvePairingChallengeTtlSeconds();

    return withTransaction(async (tx) => {
      const tokenRows = await tx`
        SELECT * FROM "pairing_tokens"
        WHERE "token" = ${dto.enrollmentToken}
        FOR UPDATE
      `;
      const tokenRecord = tokenRows[0];

      if (
        !tokenRecord ||
        tokenRecord.used_at !== null ||
        tokenRecord.used_by_device_id !== null ||
        new Date(tokenRecord.expires_at) <= new Date()
      ) {
        throw new HttpException(401, 'INVALID_PAIRING_TOKEN', 'Pairing token is invalid, already used, or expired');
      }

      if (dto.organizationId && dto.organizationId !== tokenRecord.organization_id) {
        await dbStore.recordAudit(
          {
            organizationId: tokenRecord.organization_id,
            actorId: tokenRecord.created_by_id,
            actorType: 'SYSTEM',
            action: 'PAIRING_CHALLENGE_ORG_MISMATCH',
            resourceType: 'PAIRING_TOKEN',
            resourceId: tokenRecord.id,
            metadata: { requestedOrganizationId: dto.organizationId },
          },
          tx,
        );
        throw new HttpException(
          403,
          'CROSS_ORGANIZATION_FORBIDDEN',
          'Pairing token does not belong to the requested organization',
        );
      }

      await entitlementService.enforceDeviceQuota(tokenRecord.organization_id, tx);

      const existingKeyRows = await tx`
        SELECT "id", "status" FROM "devices"
        WHERE "public_key_fingerprint" = ${parsedKey.fingerprint}
        LIMIT 1
        FOR UPDATE
      `;
      if (existingKeyRows.length > 0) {
        throw new HttpException(
          409,
          'PUBLIC_KEY_ALREADY_REGISTERED',
          'This device public key is already registered. Silent key replacement is forbidden.',
        );
      }

      const countRows = await tx<{ cnt: number }>`
        SELECT COUNT(*)::int AS cnt FROM "device_pairing_challenges"
        WHERE "pairing_token_id" = ${tokenRecord.id}
      `;
      if ((countRows[0]?.cnt ?? 0) >= MAX_CHALLENGES_PER_PAIRING_TOKEN) {
        throw new HttpException(
          429,
          'TOO_MANY_PAIRING_CHALLENGES',
          'Maximum pairing challenge attempts exceeded for this pairing token',
        );
      }

      const issuedAtMs = Date.now();
      const issuedAt = new Date(issuedAtMs);
      const tokenExpiresMs = new Date(tokenRecord.expires_at).getTime();
      const expiresAtMs = Math.min(issuedAtMs + ttlSeconds * 1000, tokenExpiresMs);

      if (expiresAtMs <= issuedAtMs) {
        throw new HttpException(401, 'INVALID_PAIRING_TOKEN', 'Pairing token is invalid, already used, or expired');
      }

      const expiresAt = new Date(expiresAtMs);
      const challengeId = randomUUID();
      const enrollmentId = randomUUID();
      const challengeNonce = randomBytes(32).toString('base64url');

      await tx`
        INSERT INTO "device_pairing_challenges" (
          "id", "pairing_token_id", "organization_id", "enrollment_id",
          "challenge_nonce", "public_key_pem", "public_key_fingerprint",
          "key_algorithm", "signature_algorithm", "protocol_version",
          "status", "issued_at", "expires_at"
        )
        VALUES (
          ${challengeId}, ${tokenRecord.id}, ${tokenRecord.organization_id}, ${enrollmentId},
          ${challengeNonce}, ${parsedKey.canonicalPem}, ${parsedKey.fingerprint},
          ${keyAlgorithm}, ${signatureAlgorithm}, ${DEVICE_PAIRING_POP_PROTOCOL_VERSION},
          'PENDING'::"PairingChallengeStatus", ${issuedAt}, ${expiresAt}
        )
      `;

      await dbStore.recordAudit(
        {
          organizationId: tokenRecord.organization_id,
          actorId: tokenRecord.created_by_id,
          actorType: 'SYSTEM',
          action: 'PAIRING_CHALLENGE_ISSUED',
          resourceType: 'DEVICE_PAIRING_CHALLENGE',
          resourceId: challengeId,
          metadata: {
            enrollmentId,
            pairingTokenId: tokenRecord.id,
            publicKeyFingerprint: parsedKey.fingerprint,
            keyAlgorithm,
            signatureAlgorithm,
            expiresAt: expiresAt.toISOString(),
          },
        },
        tx,
      );

      return {
        protocolVersion: DEVICE_PAIRING_POP_PROTOCOL_VERSION,
        challengeId,
        enrollmentId,
        organizationId: tokenRecord.organization_id,
        challenge: challengeNonce,
        publicKeyFingerprint: parsedKey.fingerprint,
        keyAlgorithm,
        signatureAlgorithm,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /**
   * Step 2 of Proof-of-Possession enrollment:
   * Atomically locks pairing token & challenge, verifies canonical ECDSA P-256 signature
   * proving possession of the private key for the registered public key, consumes both token
   * and challenge in a single transaction, and registers the device.
   */
  async pairDevice(dto: PairDeviceDto): Promise<PairDeviceResult> {
    if (!dto || !dto.enrollmentToken || !dto.publicKeyPem || !dto.deviceModel) {
      throw new HttpException(400, 'INVALID_PAYLOAD', 'enrollmentToken, publicKeyPem, and deviceModel are required');
    }

    if (dto.deviceId || (dto as unknown as Record<string, unknown>).existingDeviceId) {
      throw new HttpException(
        409,
        'DEVICE_KEY_REPLACEMENT_FORBIDDEN',
        'Re-pairing cannot silently replace an existing device key. Revoke the device or use a separate key rotation workflow.',
      );
    }

    if (!dto.challengeId || typeof dto.challengeId !== 'string' || !dto.challengeSignature || typeof dto.challengeSignature !== 'string') {
      throw new HttpException(
        401,
        'PROOF_OF_POSSESSION_REQUIRED',
        'challengeId and challengeSignature proving private-key possession are required',
      );
    }

    if (!UUID_REGEX.test(dto.challengeId)) {
      throw new HttpException(400, 'INVALID_PAIRING_CHALLENGE', 'challengeId must be a valid UUID');
    }

    validatePairingAlgorithms(dto.keyAlgorithm, dto.signatureAlgorithm);
    const parsedKey = parseAndValidateDevicePublicKey(dto.publicKeyPem);

    let outcome: PairTxOutcome;
    try {
      outcome = await withTransaction(async (tx): Promise<PairTxOutcome> => {
        // Strict Lock Order: pairing_tokens -> device_pairing_challenges -> devices
        const tokenRows = await tx`
          SELECT * FROM "pairing_tokens"
          WHERE "token" = ${dto.enrollmentToken}
          FOR UPDATE
        `;
        const tokenRecord = tokenRows[0];

        if (
          !tokenRecord ||
          tokenRecord.used_at !== null ||
          tokenRecord.used_by_device_id !== null ||
          new Date(tokenRecord.expires_at) <= new Date()
        ) {
          return {
            ok: false,
            statusCode: 401,
            code: 'INVALID_PAIRING_TOKEN',
            message: 'Pairing token is invalid, already used, or expired',
          };
        }

        const challengeRows = await tx`
          SELECT * FROM "device_pairing_challenges"
          WHERE "id" = ${dto.challengeId}
          FOR UPDATE
        `;
        const challengeRow = challengeRows[0];

        if (!challengeRow) {
          return {
            ok: false,
            statusCode: 401,
            code: 'INVALID_PAIRING_CHALLENGE',
            message: 'Pairing challenge is invalid or does not exist',
          };
        }

        if (
          challengeRow.pairing_token_id !== tokenRecord.id ||
          challengeRow.organization_id !== tokenRecord.organization_id ||
          (dto.organizationId && dto.organizationId !== challengeRow.organization_id) ||
          (dto.enrollmentId && dto.enrollmentId !== challengeRow.enrollment_id)
        ) {
          await dbStore.recordAudit(
            {
              organizationId: tokenRecord.organization_id,
              actorId: tokenRecord.created_by_id,
              actorType: 'SYSTEM',
              action: 'PAIRING_CHALLENGE_BINDING_MISMATCH',
              resourceType: 'DEVICE_PAIRING_CHALLENGE',
              resourceId: challengeRow.id,
              metadata: {
                tokenId: tokenRecord.id,
                challengeTokenId: challengeRow.pairing_token_id,
                tokenOrgId: tokenRecord.organization_id,
                challengeOrgId: challengeRow.organization_id,
              },
            },
            tx,
          );
          return {
            ok: false,
            statusCode: 403,
            code: 'CHALLENGE_BINDING_MISMATCH',
            message: 'Pairing challenge is not bound to this pairing token, organization, or enrollment',
          };
        }

        if (challengeRow.status === 'CONSUMED') {
          return {
            ok: false,
            statusCode: 401,
            code: 'CHALLENGE_ALREADY_CONSUMED',
            message: 'Pairing challenge has already been consumed and cannot be replayed',
          };
        }

        if (challengeRow.status === 'EXPIRED') {
          return {
            ok: false,
            statusCode: 401,
            code: 'CHALLENGE_EXPIRED',
            message: 'Pairing challenge has expired',
          };
        }

        if (challengeRow.status !== 'PENDING') {
          return {
            ok: false,
            statusCode: 401,
            code: 'INVALID_PAIRING_CHALLENGE',
            message: 'Pairing challenge is no longer valid',
          };
        }

        if (new Date(challengeRow.expires_at) <= new Date()) {
          await tx`
            UPDATE "device_pairing_challenges"
            SET "status" = 'EXPIRED'::"PairingChallengeStatus",
                "failure_reason" = 'Challenge expired before proof verification',
                "updated_at" = NOW()
            WHERE "id" = ${challengeRow.id}
          `;
          await dbStore.recordAudit(
            {
              organizationId: tokenRecord.organization_id,
              actorId: tokenRecord.created_by_id,
              actorType: 'SYSTEM',
              action: 'PAIRING_CHALLENGE_EXPIRED',
              resourceType: 'DEVICE_PAIRING_CHALLENGE',
              resourceId: challengeRow.id,
            },
            tx,
          );
          return {
            ok: false,
            statusCode: 401,
            code: 'CHALLENGE_EXPIRED',
            message: 'Pairing challenge has expired',
          };
        }

        if (challengeRow.public_key_fingerprint !== parsedKey.fingerprint) {
          await tx`
            UPDATE "device_pairing_challenges"
            SET "status" = 'REJECTED'::"PairingChallengeStatus",
                "rejected_at" = NOW(),
                "failure_reason" = 'Submitted public key does not match challenged key fingerprint',
                "updated_at" = NOW()
            WHERE "id" = ${challengeRow.id}
          `;
          await dbStore.recordAudit(
            {
              organizationId: tokenRecord.organization_id,
              actorId: tokenRecord.created_by_id,
              actorType: 'SYSTEM',
              action: 'PAIRING_CHALLENGE_FAILED',
              resourceType: 'DEVICE_PAIRING_CHALLENGE',
              resourceId: challengeRow.id,
              metadata: {
                reason: 'PUBLIC_KEY_MISMATCH',
                expectedFingerprint: challengeRow.public_key_fingerprint,
                submittedFingerprint: parsedKey.fingerprint,
              },
            },
            tx,
          );
          return {
            ok: false,
            statusCode: 403,
            code: 'PUBLIC_KEY_MISMATCH',
            message: 'Submitted public key does not match the challenged public key',
          };
        }

        const transcriptBytes = buildPairingChallengeTranscript({
          challengeId: challengeRow.id,
          enrollmentId: challengeRow.enrollment_id,
          organizationId: challengeRow.organization_id,
          pairingTokenHash: hashToken(tokenRecord.token),
          publicKeyFingerprint: challengeRow.public_key_fingerprint,
          keyAlgorithm: challengeRow.key_algorithm as DeviceKeyAlgorithm,
          signatureAlgorithm: challengeRow.signature_algorithm as DeviceSignatureAlgorithm,
          challengeNonce: challengeRow.challenge_nonce,
          expiresAtIso: new Date(challengeRow.expires_at).toISOString(),
        });

        const sigVerification = verifyDevicePairingSignature({
          publicKeyPem: challengeRow.public_key_pem,
          transcriptBytes,
          signatureBase64: dto.challengeSignature,
        });

        if (!sigVerification.valid) {
          const reason = sigVerification.reason || 'Invalid ECDSA proof-of-possession signature';
          await tx`
            UPDATE "device_pairing_challenges"
            SET "status" = 'REJECTED'::"PairingChallengeStatus",
                "rejected_at" = NOW(),
                "failure_reason" = ${reason},
                "updated_at" = NOW()
            WHERE "id" = ${challengeRow.id}
          `;
          await dbStore.recordAudit(
            {
              organizationId: tokenRecord.organization_id,
              actorId: tokenRecord.created_by_id,
              actorType: 'SYSTEM',
              action: 'PAIRING_CHALLENGE_FAILED',
              resourceType: 'DEVICE_PAIRING_CHALLENGE',
              resourceId: challengeRow.id,
              metadata: { reason },
            },
            tx,
          );
          return {
            ok: false,
            statusCode: 401,
            code: 'INVALID_CHALLENGE_SIGNATURE',
            message: reason,
          };
        }

        const existingKeyRows = await tx`
          SELECT "id", "status" FROM "devices"
          WHERE "public_key_fingerprint" = ${parsedKey.fingerprint}
          LIMIT 1
          FOR UPDATE
        `;
        if (existingKeyRows.length > 0) {
          await tx`
            UPDATE "device_pairing_challenges"
            SET "status" = 'REJECTED'::"PairingChallengeStatus",
                "rejected_at" = NOW(),
                "failure_reason" = 'Attempted reuse or replacement of an already registered device key',
                "updated_at" = NOW()
            WHERE "id" = ${challengeRow.id}
          `;
          await dbStore.recordAudit(
            {
              organizationId: tokenRecord.organization_id,
              actorId: tokenRecord.created_by_id,
              actorType: 'SYSTEM',
              action: 'PAIRING_KEY_REPLACEMENT_BLOCKED',
              resourceType: 'DEVICE_PAIRING_CHALLENGE',
              resourceId: challengeRow.id,
              metadata: {
                existingDeviceId: existingKeyRows[0]!.id,
                publicKeyFingerprint: parsedKey.fingerprint,
              },
            },
            tx,
          );
          return {
            ok: false,
            statusCode: 409,
            code: 'PUBLIC_KEY_ALREADY_REGISTERED',
            message: 'This device public key is already registered. Silent key replacement is forbidden.',
          };
        }

        await entitlementService.enforceDeviceQuota(tokenRecord.organization_id, tx);

        const rawDeviceToken = generateSecureToken('bsk_dev', 32);
        const tokenHash = hashToken(rawDeviceToken);

        const device = await dbStore.registerDevice(
          {
            organizationId: tokenRecord.organization_id,
            label: dto.label || `${dto.manufacturer || 'Android'} ${dto.deviceModel}`,
            deviceModel: dto.deviceModel,
            manufacturer: dto.manufacturer || 'Generic',
            androidVersion: dto.androidVersion || '14',
            appVersion: dto.appVersion || '1.0.0',
            publicKeyPem: parsedKey.canonicalPem,
            publicKeyFingerprint: parsedKey.fingerprint,
            keyAlgorithm: parsedKey.keyAlgorithm,
            ingestionMode: dto.ingestionMode || DeviceIngestionMode.NOTIFICATION_LISTENER,
            tokenHash,
          },
          tx,
        );

        await tx`
          UPDATE "device_pairing_challenges"
          SET "status" = 'CONSUMED'::"PairingChallengeStatus",
              "consumed_at" = NOW(),
              "resulting_device_id" = ${device.id},
              "updated_at" = NOW()
          WHERE "id" = ${challengeRow.id}
        `;

        // Mark pairing token as consumed and bind to the registered device (preserves separation of duties)
        await tx`
          UPDATE "pairing_tokens"
          SET "used_at" = NOW(), "used_by_device_id" = ${device.id}
          WHERE "id" = ${tokenRecord.id}
        `;

        await dbStore.recordAudit(
          {
            organizationId: device.organizationId,
            actorId: device.id,
            actorType: 'DEVICE',
            action: 'DEVICE_PAIRING_POP_VERIFIED',
            resourceType: 'DEVICE_PAIRING_CHALLENGE',
            resourceId: challengeRow.id,
            metadata: {
              enrollmentId: challengeRow.enrollment_id,
              pairingTokenId: tokenRecord.id,
              publicKeyFingerprint: parsedKey.fingerprint,
              keyAlgorithm: parsedKey.keyAlgorithm,
            },
          },
          tx,
        );

        return {
          ok: true,
          result: {
            deviceId: device.id,
            organizationId: device.organizationId,
            deviceToken: rawDeviceToken,
            publicKeyFingerprint: parsedKey.fingerprint,
            keyAlgorithm: parsedKey.keyAlgorithm,
            syncIntervalSeconds: 30,
          },
        };
      });
    } catch (err: unknown) {
      if (err instanceof HttpException || err instanceof BriskError) {
        throw err;
      }
      const pgCode = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
      const constraint =
        typeof err === 'object' && err !== null && 'constraint' in err ? String((err as { constraint?: unknown }).constraint) : '';
      if (pgCode === '23505' && constraint.includes('public_key_fingerprint')) {
        throw new HttpException(
          409,
          'PUBLIC_KEY_ALREADY_REGISTERED',
          'This device public key is already registered. Silent key replacement is forbidden.',
        );
      }
      throw err;
    }

    if (!outcome.ok) {
      throw new HttpException(outcome.statusCode, outcome.code, outcome.message);
    }

    return outcome.result;
  }

  async listDevices(organizationId: string, actorUserId: string): Promise<DeviceRecord[]> {
    const mem = await dbStore.getMembership(organizationId, actorUserId);
    if (!mem) {
      throw new HttpException(403, 'FORBIDDEN', 'No access to organization devices');
    }
    return dbStore.getOrgDevices(organizationId);
  }

  async getDevice(
    deviceId: string,
    organizationId: string,
    actorUserId: string,
  ): Promise<{ device: DeviceRecord; telemetryHistory: DeviceTelemetryRecord[] }> {
    const mem = await dbStore.getMembership(organizationId, actorUserId);
    if (!mem) {
      throw new HttpException(403, 'FORBIDDEN', 'No access to organization devices');
    }

    const device = await dbStore.getDeviceById(deviceId, organizationId);
    if (!device) {
      throw new HttpException(404, 'DEVICE_NOT_FOUND', 'Device not found in this organization');
    }

    const telemetryHistory = await dbStore.getDeviceTelemetry(deviceId, 20);
    return { device, telemetryHistory };
  }

  private async authenticateDeviceForCommandPlane(
    deviceId: string,
    deviceToken: string,
  ): Promise<DeviceRecord> {
    if (!deviceToken || typeof deviceToken !== 'string' || !isValidUuid(deviceId)) {
      throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Device authentication failed');
    }

    const tokenHash = hashToken(deviceToken);
    const device = await dbStore.getDeviceByTokenHash(tokenHash);
    if (!device || device.id !== deviceId) {
      throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Device authentication failed');
    }

    const computedBuf = Buffer.from(tokenHash, 'hex');
    const storedBuf = Buffer.from(device.deviceTokenHash, 'hex');
    if (computedBuf.length !== storedBuf.length || !timingSafeEqual(computedBuf, storedBuf)) {
      throw new HttpException(401, 'INVALID_DEVICE_TOKEN', 'Device authentication failed');
    }

    if (device.status === DeviceStatus.REVOKED) {
      throw new HttpException(403, 'DEVICE_REVOKED', 'This device has been revoked by the organization');
    }

    if (device.status !== DeviceStatus.ACTIVE) {
      throw new HttpException(403, 'DEVICE_INACTIVE', `Device is not active (current status: ${device.status})`);
    }

    return device;
  }

  private async lockActiveDeviceAndOrgInTx(
    tx: SqlExecutor,
    deviceId: string,
    organizationId: string,
  ): Promise<
    | { ok: true }
    | { ok: false; statusCode: number; code: string; message: string }
  > {
    const devRows = await tx<{ id: string; status: DeviceStatus; is_active: boolean }>`
      SELECT d."id", d."status", o."is_active"
      FROM "devices" d
      INNER JOIN "organizations" o ON o."id" = d."organization_id"
      WHERE d."id" = ${deviceId} AND d."organization_id" = ${organizationId}
      FOR UPDATE OF d
    `;
    const row = devRows[0];
    if (!row) {
      return { ok: false, statusCode: 401, code: 'INVALID_DEVICE_TOKEN', message: 'Device authentication failed' };
    }
    if (row.status === DeviceStatus.REVOKED) {
      return {
        ok: false,
        statusCode: 403,
        code: 'DEVICE_REVOKED',
        message: 'This device has been revoked by the organization',
      };
    }
    if (row.status !== DeviceStatus.ACTIVE) {
      return {
        ok: false,
        statusCode: 403,
        code: 'DEVICE_INACTIVE',
        message: `Device is not active (current status: ${row.status})`,
      };
    }
    if (!row.is_active) {
      return {
        ok: false,
        statusCode: 403,
        code: 'ORGANIZATION_INACTIVE',
        message: 'Device organization is inactive or not found',
      };
    }
    return { ok: true };
  }

  private async reconcileExpiredAndExhaustedCommandsInTx(
    tx: SqlExecutor,
    organizationId: string,
    deviceId: string,
  ): Promise<void> {
    const expiredRows = await tx<{ id: string; command_type: string }>`
      UPDATE "device_commands"
      SET
        "status" = 'EXPIRED'::"DeviceCommandStatus",
        "failure_reason" = COALESCE("failure_reason", 'Command expired before acknowledgement'),
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = NOW()
      WHERE "organization_id" = ${organizationId}
        AND "device_id" = ${deviceId}
        AND "status" IN ('PENDING', 'DELIVERED')
        AND "expires_at" <= NOW()
      RETURNING "id", "command_type"
    `;

    for (const row of expiredRows) {
      await dbStore.recordAudit(
        {
          organizationId,
          actorId: deviceId,
          actorType: 'SYSTEM',
          action: 'DEVICE_COMMAND_EXPIRED',
          resourceType: 'DEVICE_COMMAND',
          resourceId: row.id,
          metadata: { deviceId, commandType: row.command_type },
        },
        tx,
      );
    }

    const exhaustedRows = await tx<{ id: string; command_type: string; delivery_attempts: number }>`
      UPDATE "device_commands"
      SET
        "status" = 'FAILED'::"DeviceCommandStatus",
        "failure_reason" = 'Maximum delivery attempts exhausted without acknowledgement',
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = NOW()
      WHERE "organization_id" = ${organizationId}
        AND "device_id" = ${deviceId}
        AND "status" = 'DELIVERED'::"DeviceCommandStatus"
        AND "expires_at" > NOW()
        AND "lease_expires_at" IS NOT NULL
        AND "lease_expires_at" <= NOW()
        AND "delivery_attempts" >= "max_delivery_attempts"
      RETURNING "id", "command_type", "delivery_attempts"
    `;

    for (const row of exhaustedRows) {
      await dbStore.recordAudit(
        {
          organizationId,
          actorId: deviceId,
          actorType: 'SYSTEM',
          action: 'DEVICE_COMMAND_EXHAUSTED',
          resourceType: 'DEVICE_COMMAND',
          resourceId: row.id,
          metadata: {
            deviceId,
            commandType: row.command_type,
            deliveryAttempts: row.delivery_attempts,
          },
        },
        tx,
      );
    }
  }

  private async applyCommandAckInTx(
    tx: SqlExecutor,
    params: {
      organizationId: string;
      deviceId: string;
      ack: ValidatedCommandAck;
    },
  ): Promise<
    | { ok: true; command: DeviceCommand; idempotentReplay: boolean }
    | { ok: false; statusCode: number; code: string; message: string }
  > {
    const { organizationId, deviceId, ack } = params;
    const rows = await tx<Record<string, any>>`
      SELECT * FROM "device_commands"
      WHERE "id" = ${ack.commandId}
        AND "organization_id" = ${organizationId}
        AND "device_id" = ${deviceId}
      FOR UPDATE
    `;

    const row = rows[0];
    if (!row) {
      return {
        ok: false,
        statusCode: 404,
        code: 'COMMAND_NOT_FOUND',
        message: 'Command not found for this device',
      };
    }

    if (row.status === DeviceCommandStatus.ACKNOWLEDGED) {
      if (ack.status === DeviceCommandStatus.ACKNOWLEDGED) {
        return { ok: true, command: mapDeviceCommandRow(row), idempotentReplay: true };
      }
      return {
        ok: false,
        statusCode: 409,
        code: 'COMMAND_TERMINAL_CONFLICT',
        message: 'Command is already terminally ACKNOWLEDGED and cannot transition to FAILED',
      };
    }

    if (row.status === DeviceCommandStatus.FAILED) {
      if (ack.status === DeviceCommandStatus.FAILED) {
        return { ok: true, command: mapDeviceCommandRow(row), idempotentReplay: true };
      }
      return {
        ok: false,
        statusCode: 409,
        code: 'COMMAND_TERMINAL_CONFLICT',
        message: 'Command is already terminally FAILED and cannot transition to ACKNOWLEDGED',
      };
    }

    if (row.status === DeviceCommandStatus.CANCELLED) {
      return {
        ok: false,
        statusCode: 409,
        code: 'COMMAND_CANCELLED',
        message: 'Cannot acknowledge a cancelled command',
      };
    }

    if (row.status === DeviceCommandStatus.EXPIRED || new Date(row.expires_at) <= new Date()) {
      if (row.status !== DeviceCommandStatus.EXPIRED) {
        await tx`
          UPDATE "device_commands"
          SET
            "status" = 'EXPIRED'::"DeviceCommandStatus",
            "failure_reason" = COALESCE("failure_reason", 'Command expired before acknowledgement'),
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "updated_at" = NOW()
          WHERE "id" = ${row.id}
        `;
        await dbStore.recordAudit(
          {
            organizationId,
            actorId: deviceId,
            actorType: 'SYSTEM',
            action: 'DEVICE_COMMAND_EXPIRED',
            resourceType: 'DEVICE_COMMAND',
            resourceId: row.id,
            metadata: { deviceId, commandType: row.command_type },
          },
          tx,
        );
      }
      return {
        ok: false,
        statusCode: 409,
        code: 'COMMAND_EXPIRED',
        message: 'Cannot acknowledge an expired command',
      };
    }

    if (row.status === DeviceCommandStatus.PENDING) {
      return {
        ok: false,
        statusCode: 409,
        code: 'COMMAND_NOT_DELIVERED',
        message: 'Cannot acknowledge a command before it has been delivered to the device',
      };
    }

    if (ack.leaseToken && row.lease_token && row.lease_token !== ack.leaseToken) {
      return {
        ok: false,
        statusCode: 409,
        code: 'STALE_COMMAND_LEASE',
        message: 'Provided leaseToken does not match the active delivery lease',
      };
    }

    const ackResultJson = ack.result ? JSON.stringify(ack.result) : null;
    if (ack.status === DeviceCommandStatus.ACKNOWLEDGED) {
      const updated = await tx<Record<string, any>>`
        UPDATE "device_commands"
        SET
          "status" = 'ACKNOWLEDGED'::"DeviceCommandStatus",
          "acknowledged_at" = NOW(),
          "ack_result" = ${ackResultJson}::text::jsonb,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "updated_at" = NOW()
        WHERE "id" = ${row.id}
        RETURNING *
      `;
      await dbStore.recordAudit(
        {
          organizationId,
          actorId: deviceId,
          actorType: 'DEVICE',
          action: 'DEVICE_COMMAND_ACKNOWLEDGED',
          resourceType: 'DEVICE_COMMAND',
          resourceId: row.id,
          metadata: {
            commandType: row.command_type,
            deliveryAttempts: row.delivery_attempts,
          },
        },
        tx,
      );
      return { ok: true, command: mapDeviceCommandRow(updated[0]!), idempotentReplay: false };
    }

    const updated = await tx<Record<string, any>>`
      UPDATE "device_commands"
      SET
        "status" = 'FAILED'::"DeviceCommandStatus",
        "failure_reason" = ${ack.failureReason},
        "ack_result" = ${ackResultJson}::text::jsonb,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = NOW()
      WHERE "id" = ${row.id}
      RETURNING *
    `;
    await dbStore.recordAudit(
      {
        organizationId,
        actorId: deviceId,
        actorType: 'DEVICE',
        action: 'DEVICE_COMMAND_FAILED',
        resourceType: 'DEVICE_COMMAND',
        resourceId: row.id,
        metadata: {
          commandType: row.command_type,
          deliveryAttempts: row.delivery_attempts,
          failureReason: ack.failureReason,
        },
      },
      tx,
    );
    return { ok: true, command: mapDeviceCommandRow(updated[0]!), idempotentReplay: false };
  }

  async queueCommand(
    deviceId: string,
    organizationId: string,
    actorUserId: string,
    commandType: DeviceCommandTypeLiteral,
    payload?: Record<string, unknown>,
    options: QueueCommandOptions = {},
  ): Promise<DeviceCommand> {
    if (!isValidUuid(deviceId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'deviceId must be a valid UUID');
    }

    const mem = await dbStore.getMembership(organizationId, actorUserId);
    if (!mem || ![UserRole.OWNER, UserRole.ADMIN].includes(mem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can issue device commands');
    }

    const { commandType: validatedType, normalizedPayload } = validateDeviceCommandInput(commandType, payload);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const ttlSeconds = resolveCommandTtlSeconds(options.ttlSeconds);
    const source = options.source?.trim() || 'ADMIN_API';
    const requestFingerprint = computeCommandRequestFingerprint({
      organizationId,
      deviceId,
      commandType: validatedType,
      payload: normalizedPayload,
    });
    const maxDeliveryAttempts =
      validatedType === 'WIPE_AND_REVOKE' ? WIPE_COMMAND_MAX_ATTEMPTS : DEFAULT_COMMAND_MAX_ATTEMPTS;

    const executeTx = async () =>
      withTransaction(async (tx) => {
        // Strict Lock Order: devices -> device_commands
        const devRows = await tx<Record<string, any>>`
          SELECT * FROM "devices"
          WHERE "id" = ${deviceId} AND "organization_id" = ${organizationId}
          FOR UPDATE
        `;
        const deviceRow = devRows[0];
        if (!deviceRow) {
          throw new HttpException(404, 'DEVICE_NOT_FOUND', `Device '${deviceId}' not found in organization`);
        }

        if (idempotencyKey) {
          const existingRows = await tx<Record<string, any>>`
            SELECT * FROM "device_commands"
            WHERE "organization_id" = ${organizationId} AND "idempotency_key" = ${idempotencyKey}
            LIMIT 1
            FOR UPDATE
          `;
          if (existingRows[0]) {
            if (existingRows[0].request_fingerprint !== requestFingerprint) {
              throw new HttpException(
                409,
                'IDEMPOTENCY_KEY_REUSE_CONFLICT',
                'Idempotency key has already been used for a different device, command type, or payload',
              );
            }
            return mapDeviceCommandRow(existingRows[0]);
          }
        }

        if (deviceRow.status === DeviceStatus.REVOKED) {
          throw new HttpException(
            409,
            'DEVICE_REVOKED',
            'Cannot queue remote commands for a revoked device',
          );
        }

        if (validatedType === 'WIPE_AND_REVOKE') {
          const revokeReason =
            typeof normalizedPayload.reason === 'string' && normalizedPayload.reason.length > 0
              ? normalizedPayload.reason
              : 'Emergency wipe and revoke command issued';
          await dbStore.revokeDevice(deviceId, organizationId, actorUserId, revokeReason, tx);
        }

        const commandId = randomUUID();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const insertedRows = await tx<Record<string, any>>`
          INSERT INTO "device_commands" (
            "id", "organization_id", "device_id", "created_by_id", "source",
            "command_type", "payload", "status", "idempotency_key", "request_fingerprint",
            "expires_at", "max_delivery_attempts"
          )
          VALUES (
            ${commandId},
            ${organizationId},
            ${deviceId},
            ${actorUserId},
            ${source},
            ${validatedType}::"DeviceCommandType",
            ${JSON.stringify(normalizedPayload)}::text::jsonb,
            'PENDING'::"DeviceCommandStatus",
            ${idempotencyKey ?? null},
            ${requestFingerprint},
            ${expiresAt},
            ${maxDeliveryAttempts}
          )
          RETURNING *
        `;

        await dbStore.recordAudit(
          {
            organizationId,
            actorId: actorUserId,
            actorType: 'USER',
            action: 'DEVICE_COMMAND_QUEUED',
            resourceType: 'DEVICE_COMMAND',
            resourceId: commandId,
            metadata: {
              deviceId,
              commandType: validatedType,
              expiresAt: expiresAt.toISOString(),
              maxDeliveryAttempts,
            },
          },
          tx,
        );

        return mapDeviceCommandRow(insertedRows[0]!);
      });

    try {
      return await executeTx();
    } catch (err: unknown) {
      if (err instanceof HttpException || err instanceof BriskError) {
        throw err;
      }
      const pgCode =
        typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
      const constraint =
        typeof err === 'object' && err !== null && 'constraint' in err
          ? String((err as { constraint?: unknown }).constraint)
          : '';
      if (pgCode === '23505' && constraint.includes('device_commands_org_idempotency_unique') && idempotencyKey) {
        const existingRows = await withTransaction(async (tx) =>
          tx<Record<string, any>>`
            SELECT * FROM "device_commands"
            WHERE "organization_id" = ${organizationId} AND "idempotency_key" = ${idempotencyKey}
            LIMIT 1
          `,
        );
        if (existingRows[0]) {
          if (existingRows[0].request_fingerprint !== requestFingerprint) {
            throw new HttpException(
              409,
              'IDEMPOTENCY_KEY_REUSE_CONFLICT',
              'Idempotency key has already been used for a different device, command type, or payload',
            );
          }
          return mapDeviceCommandRow(existingRows[0]);
        }
      }
      throw err;
    }
  }

  async listDeviceCommands(
    deviceId: string,
    organizationId: string,
    actorUserId: string,
    options: { limit?: number; status?: DeviceCommandStatus } = {},
  ): Promise<DeviceCommand[]> {
    if (!isValidUuid(deviceId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'deviceId must be a valid UUID');
    }

    const mem = await dbStore.getMembership(organizationId, actorUserId);
    if (!mem) {
      throw new HttpException(403, 'FORBIDDEN', 'No access to organization devices');
    }

    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));

    return withTransaction(async (tx) => {
      const devRows = await tx`
        SELECT "id" FROM "devices"
        WHERE "id" = ${deviceId} AND "organization_id" = ${organizationId}
        FOR UPDATE
      `;
      if (!devRows[0]) {
        throw new HttpException(404, 'DEVICE_NOT_FOUND', 'Device not found in this organization');
      }

      await this.reconcileExpiredAndExhaustedCommandsInTx(tx, organizationId, deviceId);

      const rows = options.status
        ? await tx<Record<string, any>>`
            SELECT * FROM "device_commands"
            WHERE "organization_id" = ${organizationId}
              AND "device_id" = ${deviceId}
              AND "status" = ${options.status}::"DeviceCommandStatus"
            ORDER BY "created_at" DESC
            LIMIT ${limit}
          `
        : await tx<Record<string, any>>`
            SELECT * FROM "device_commands"
            WHERE "organization_id" = ${organizationId}
              AND "device_id" = ${deviceId}
            ORDER BY "created_at" DESC
            LIMIT ${limit}
          `;

      return rows.map(mapDeviceCommandRow);
    });
  }

  async cancelDeviceCommand(
    deviceId: string,
    commandId: string,
    organizationId: string,
    actorUserId: string,
    reason?: string,
  ): Promise<DeviceCommand> {
    if (!isValidUuid(deviceId) || !isValidUuid(commandId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'deviceId and commandId must be valid UUIDs');
    }

    const mem = await dbStore.getMembership(organizationId, actorUserId);
    if (!mem || ![UserRole.OWNER, UserRole.ADMIN].includes(mem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can cancel device commands');
    }

    const normalizedReason =
      typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim().slice(0, 255)
        : 'Cancelled by administrator';

    const outcome = await withTransaction(
      async (
        tx,
      ): Promise<
        | { ok: true; command: DeviceCommand }
        | { ok: false; statusCode: number; code: string; message: string }
      > => {
        const devRows = await tx`
          SELECT "id" FROM "devices"
          WHERE "id" = ${deviceId} AND "organization_id" = ${organizationId}
          FOR UPDATE
        `;
        if (!devRows[0]) {
          return { ok: false, statusCode: 404, code: 'DEVICE_NOT_FOUND', message: 'Device not found in organization' };
        }

        await this.reconcileExpiredAndExhaustedCommandsInTx(tx, organizationId, deviceId);

        const rows = await tx<Record<string, any>>`
          SELECT * FROM "device_commands"
          WHERE "id" = ${commandId}
            AND "organization_id" = ${organizationId}
            AND "device_id" = ${deviceId}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) {
          return {
            ok: false,
            statusCode: 404,
            code: 'COMMAND_NOT_FOUND',
            message: 'Command not found for this device',
          };
        }

        if (row.status === DeviceCommandStatus.CANCELLED) {
          return { ok: true, command: mapDeviceCommandRow(row) };
        }

        if (
          row.status === DeviceCommandStatus.ACKNOWLEDGED ||
          row.status === DeviceCommandStatus.FAILED ||
          row.status === DeviceCommandStatus.EXPIRED
        ) {
          return {
            ok: false,
            statusCode: 409,
            code: 'INVALID_COMMAND_TRANSITION',
            message: `Cannot cancel command in terminal state '${row.status}'`,
          };
        }

        const updatedRows = await tx<Record<string, any>>`
          UPDATE "device_commands"
          SET
            "status" = 'CANCELLED'::"DeviceCommandStatus",
            "cancelled_at" = NOW(),
            "cancelled_by_id" = ${actorUserId},
            "cancellation_reason" = ${normalizedReason},
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "updated_at" = NOW()
          WHERE "id" = ${row.id}
          RETURNING *
        `;

        await dbStore.recordAudit(
          {
            organizationId,
            actorId: actorUserId,
            actorType: 'USER',
            action: 'DEVICE_COMMAND_CANCELLED',
            resourceType: 'DEVICE_COMMAND',
            resourceId: row.id,
            metadata: { deviceId, commandType: row.command_type, reason: normalizedReason },
          },
          tx,
        );

        return { ok: true, command: mapDeviceCommandRow(updatedRows[0]!) };
      },
    );

    if (!outcome.ok) {
      throw new HttpException(outcome.statusCode, outcome.code, outcome.message);
    }

    return outcome.command;
  }

  async acknowledgeCommand(
    deviceId: string,
    deviceToken: string,
    commandId: string,
    dto: Omit<DeviceCommandAckInput, 'commandId'>,
  ): Promise<DeviceCommandAckResult> {
    if (!isValidUuid(commandId)) {
      throw new HttpException(400, 'VALIDATION_ERROR', 'commandId must be a valid UUID');
    }
    const validatedAck = validateCommandAckInput({ ...(dto || {}), commandId });
    const device = await this.authenticateDeviceForCommandPlane(deviceId, deviceToken);

    const outcome = await withTransaction(
      async (
        tx,
      ): Promise<
        | { ok: true; command: DeviceCommand; idempotentReplay: boolean }
        | { ok: false; statusCode: number; code: string; message: string }
      > => {
        const lockCheck = await this.lockActiveDeviceAndOrgInTx(tx, device.id, device.organizationId);
        if (!lockCheck.ok) {
          return lockCheck;
        }
        return this.applyCommandAckInTx(tx, {
          organizationId: device.organizationId,
          deviceId: device.id,
          ack: validatedAck,
        });
      },
    );

    if (!outcome.ok) {
      throw new HttpException(outcome.statusCode, outcome.code, outcome.message);
    }

    return {
      command: outcome.command,
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  async recordTelemetry(
    deviceId: string,
    deviceToken: string,
    dto: TelemetryDto,
    options: RecordTelemetryOptions = {},
  ): Promise<DeviceTelemetryResult> {
    const parsedAcks = parseTelemetryCommandAcks(dto?.commandAcknowledgements);
    const validatedAcks = parsedAcks.map((ack) => validateCommandAckInput(ack));
    const leaseSeconds = resolveCommandLeaseSeconds(options.leaseSeconds);
    const device = await this.authenticateDeviceForCommandPlane(deviceId, deviceToken);

    const txOutcome = await withTransaction(
      async (
        tx,
      ): Promise<
        | { ok: true; result: DeviceTelemetryResult }
        | { ok: false; statusCode: number; code: string; message: string }
      > => {
        // Strict Lock Order: devices -> device_commands
        const lockCheck = await this.lockActiveDeviceAndOrgInTx(tx, device.id, device.organizationId);
        if (!lockCheck.ok) {
          return lockCheck;
        }

        const telemetry = await dbStore.recordTelemetry(
          {
            deviceId: device.id,
            batteryPct: Math.max(0, Math.min(100, dto.batteryPercentage ?? 100)),
            isCharging: Boolean(dto.isCharging),
            networkType: dto.networkType || 'WIFI',
            signalStrengthDbm: dto.signalStrengthDbm ?? null,
            pendingOfflineCount: dto.pendingOfflineCount || 0,
          },
          tx,
        );

        const ackResults: DeviceTelemetryAckOutcome[] = [];
        for (const ack of validatedAcks) {
          const ackRes = await this.applyCommandAckInTx(tx, {
            organizationId: device.organizationId,
            deviceId: device.id,
            ack,
          });
          if (ackRes.ok) {
            ackResults.push({
              commandId: ack.commandId,
              accepted: true,
              status: ackRes.command.status,
              idempotentReplay: ackRes.idempotentReplay,
            });
          } else {
            ackResults.push({
              commandId: ack.commandId,
              accepted: false,
              errorCode: ackRes.code,
            });
          }
        }

        await this.reconcileExpiredAndExhaustedCommandsInTx(tx, device.organizationId, device.id);

        const claimableRows = await tx<Record<string, any>>`
          SELECT * FROM "device_commands"
          WHERE "organization_id" = ${device.organizationId}
            AND "device_id" = ${device.id}
            AND "expires_at" > NOW()
            AND "delivery_attempts" < "max_delivery_attempts"
            AND (
              "status" = 'PENDING'::"DeviceCommandStatus"
              OR (
                "status" = 'DELIVERED'::"DeviceCommandStatus"
                AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= NOW())
              )
            )
          ORDER BY "created_at" ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        `;

        const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
        const commands: DeviceCommand[] = [];

        for (const row of claimableRows) {
          const leaseToken = randomUUID();
          const updatedRows = await tx<Record<string, any>>`
            UPDATE "device_commands"
            SET
              "status" = 'DELIVERED'::"DeviceCommandStatus",
              "delivery_attempts" = "delivery_attempts" + 1,
              "lease_token" = ${leaseToken},
              "claimed_by_instance" = ${this.instanceId},
              "delivered_at" = COALESCE("delivered_at", NOW()),
              "last_delivery_attempt_at" = NOW(),
              "lease_expires_at" = ${leaseExpiresAt},
              "updated_at" = NOW()
            WHERE "id" = ${row.id}
            RETURNING *
          `;
          const delivered = mapDeviceCommandRow(updatedRows[0]!);
          await dbStore.recordAudit(
            {
              organizationId: device.organizationId,
              actorId: device.id,
              actorType: 'DEVICE',
              action: 'DEVICE_COMMAND_DELIVERED',
              resourceType: 'DEVICE_COMMAND',
              resourceId: delivered.id,
              metadata: {
                commandType: delivered.type,
                deliveryAttempts: delivered.deliveryAttempts,
                leaseExpiresAt: delivered.leaseExpiresAt,
                claimedByInstance: this.instanceId,
              },
            },
            tx,
          );
          commands.push(delivered);
        }

        return {
          ok: true,
          result: {
            ...telemetry,
            commands,
            ...(ackResults.length > 0 ? { ackResults } : {}),
          },
        };
      },
    );

    if (!txOutcome.ok) {
      throw new HttpException(txOutcome.statusCode, txOutcome.code, txOutcome.message);
    }

    return txOutcome.result;
  }

  async revokeDevice(deviceId: string, organizationId: string, actorUserId: string): Promise<DeviceRecord> {
    const mem = await dbStore.getMembership(organizationId, actorUserId);
    if (!mem || ![UserRole.OWNER, UserRole.ADMIN].includes(mem.role)) {
      throw new HttpException(403, 'INSUFFICIENT_PERMISSIONS', 'Only Owners and Admins can revoke devices');
    }

    return dbStore.revokeDevice(deviceId, organizationId, actorUserId);
  }
}

export const deviceService = new DeviceService();
