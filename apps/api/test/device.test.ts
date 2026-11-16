import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { DeviceService, deviceService } from '../src/modules/device/device.service.js';
import { buildPairingChallengeTranscript } from '../src/modules/device/device-crypto.js';
import { hashToken } from '../src/core/crypto.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { dbStore } from '../src/core/store.js';
import { DeviceStatus, DeviceIngestionMode } from '@brisksms/shared';

function generateEcP256KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    fingerprint: createHash('sha256').update(spkiDer).digest('hex'),
    privateKey,
  };
}

async function enrollWithPop(
  svc: DeviceService,
  enrollmentToken: string,
  meta: {
    label?: string;
    deviceModel: string;
    manufacturer: string;
    androidVersion: string;
    appVersion: string;
    ingestionMode?: DeviceIngestionMode;
  },
) {
  const keys = generateEcP256KeyPair();
  const challenge = await svc.createPairingChallenge({
    enrollmentToken,
    publicKeyPem: keys.publicKeyPem,
  });
  const transcript = buildPairingChallengeTranscript({
    challengeId: challenge.challengeId,
    enrollmentId: challenge.enrollmentId,
    organizationId: challenge.organizationId,
    pairingTokenHash: hashToken(enrollmentToken),
    publicKeyFingerprint: keys.fingerprint,
    keyAlgorithm: challenge.keyAlgorithm,
    signatureAlgorithm: challenge.signatureAlgorithm,
    challengeNonce: challenge.challenge,
    expiresAtIso: challenge.expiresAt,
  });
  const challengeSignature = cryptoSign('sha256', transcript, {
    key: keys.privateKey,
    dsaEncoding: 'der',
  }).toString('base64');

  return {
    keys,
    challenge,
    pairResult: await svc.pairDevice({
      enrollmentToken,
      challengeId: challenge.challengeId,
      challengeSignature,
      enrollmentId: challenge.enrollmentId,
      organizationId: challenge.organizationId,
      publicKeyPem: keys.publicKeyPem,
      ...meta,
    }),
  };
}

describe('Phase 1: DeviceModule & Cryptographic Pairing Flow', () => {
  let orgId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    await dbStore.reset();
    const userRes = await authService.register({
      email: 'isp-owner@mwanza.co.tz',
      password: 'StrongPassword123!',
      fullName: 'Mwanza Net Admin',
      organizationName: 'Mwanza Wireless',
    });
    orgId = userRes.organizationId!;
    ownerUserId = userRes.user.id;
  });

  it('should generate a 5-minute single-use QR pairing token for authorized admins', async () => {
    const tokenRes = await deviceService.createPairingToken(orgId, ownerUserId);

    assert.ok(tokenRes.pairingToken.startsWith('bsk_pair_'));
    assert.equal(tokenRes.organizationId, orgId);
    assert.ok(tokenRes.qrPayload.includes(tokenRes.pairingToken));

    // Verify expiry is set in the future (~300 seconds)
    const expDate = new Date(tokenRes.expiresAt).getTime();
    assert.ok(expDate > Date.now());
  });

  it('should complete Android device pairing via challenge-response PoP and return device token and active status', async () => {
    const pairingData = await deviceService.createPairingToken(orgId, ownerUserId);

    const { pairResult, keys } = await enrollWithPop(deviceService, pairingData.pairingToken, {
      label: 'Main Office Till Samsung S23',
      deviceModel: 'SM-S911B',
      manufacturer: 'Samsung',
      androidVersion: '14.0',
      appVersion: '1.2.0',
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
    });

    assert.ok(pairResult.deviceId);
    assert.equal(pairResult.organizationId, orgId);
    assert.ok(pairResult.deviceToken.startsWith('bsk_dev_'));
    assert.equal(pairResult.publicKeyFingerprint, keys.fingerprint);

    // Verify device in store
    const device = await dbStore.getDeviceById(pairResult.deviceId);
    assert.ok(device);
    assert.equal(device?.status, DeviceStatus.ACTIVE);
    assert.equal(device?.deviceModel, 'SM-S911B');
    assert.equal(device?.publicKeyFingerprint, keys.fingerprint);

    // Pairing token is single-use: subsequent challenge or pairing with same token must fail
    const attackerKeys = generateEcP256KeyPair();
    await assert.rejects(
      deviceService.createPairingChallenge({
        enrollmentToken: pairingData.pairingToken,
        publicKeyPem: attackerKeys.publicKeyPem,
      }),
      /Pairing token is invalid, already used, or expired/,
    );
  });

  it('should accept telemetry heartbeats from authenticated active devices', async () => {
    const pairingData = await deviceService.createPairingToken(orgId, ownerUserId);
    const { pairResult } = await enrollWithPop(deviceService, pairingData.pairingToken, {
      deviceModel: 'Redmi Note 12',
      manufacturer: 'Xiaomi',
      androidVersion: '13',
      appVersion: '1.0.0',
    });

    const telemetry = await deviceService.recordTelemetry(pairResult.deviceId, pairResult.deviceToken, {
      batteryPercentage: 88,
      isCharging: true,
      networkType: 'WIFI',
      signalStrengthDbm: -65,
      pendingOfflineCount: 0,
    });

    assert.equal(telemetry.batteryPct, 88);
    assert.equal(telemetry.isCharging, true);
    assert.equal(telemetry.signalStrengthDbm, -65);

    // Verify device lastSyncAt was updated
    const device = await dbStore.getDeviceById(pairResult.deviceId);
    assert.ok(device?.lastSyncAt);
  });

  it('should immediately revoke device and reject subsequent telemetry and sync calls', async () => {
    const pairingData = await deviceService.createPairingToken(orgId, ownerUserId);
    const { pairResult } = await enrollWithPop(deviceService, pairingData.pairingToken, {
      deviceModel: 'Tecno Spark 10',
      manufacturer: 'Transsion',
      androidVersion: '13',
      appVersion: '1.0.0',
    });

    // Revoke device
    const revoked = await deviceService.revokeDevice(pairResult.deviceId, orgId, ownerUserId);
    assert.equal(revoked.status, DeviceStatus.REVOKED);
    assert.ok(revoked.revokedAt);

    // Subsequent telemetry must be rejected
    await assert.rejects(
      deviceService.recordTelemetry(pairResult.deviceId, pairResult.deviceToken, {
        batteryPercentage: 50,
        isCharging: false,
        networkType: 'CELLULAR',
      }),
      /This device has been revoked|Device authentication failed/,
    );
  });

  it('should queue remote fleet commands and deliver them in subsequent telemetry response', async () => {
    const pairingData = await deviceService.createPairingToken(orgId, ownerUserId);
    const { pairResult } = await enrollWithPop(deviceService, pairingData.pairingToken, {
      deviceModel: 'Infinix Note 30',
      manufacturer: 'Transsion',
      androidVersion: '13',
      appVersion: '1.0.0',
    });

    // Queue commands
    const cmd1 = await deviceService.queueCommand(pairResult.deviceId, orgId, ownerUserId, 'PAUSE_RELAY');
    assert.equal(cmd1.type, 'PAUSE_RELAY');
    assert.equal(cmd1.deviceId, pairResult.deviceId);

    const cmd2 = await deviceService.queueCommand(pairResult.deviceId, orgId, ownerUserId, 'SWITCH_SIM', { simSlot: 2 });
    assert.equal(cmd2.type, 'SWITCH_SIM');

    // Telemetry heartbeat from device should receive both queued commands
    const telemetryRes = await deviceService.recordTelemetry(pairResult.deviceId, pairResult.deviceToken, {
      batteryPercentage: 92,
      isCharging: false,
      networkType: 'WIFI',
    });

    assert.equal(telemetryRes.commands.length, 2);
    assert.equal(telemetryRes.commands[0]!.type, 'PAUSE_RELAY');
    assert.equal(telemetryRes.commands[1]!.type, 'SWITCH_SIM');

    // Next telemetry heartbeat should be drained (0 commands)
    const nextTelemetry = await deviceService.recordTelemetry(pairResult.deviceId, pairResult.deviceToken, {
      batteryPercentage: 91,
      isCharging: false,
      networkType: 'WIFI',
    });
    assert.equal(nextTelemetry.commands.length, 0);
  });
});
