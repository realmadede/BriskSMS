import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deviceService } from '../src/modules/device/device.service.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { dbStore } from '../src/core/store.js';
import { DeviceStatus, DeviceIngestionMode } from '@brisksms/shared';

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

  it('should complete Android device pairing and return device token and active status', async () => {
    const pairingData = await deviceService.createPairingToken(orgId, ownerUserId);

    const pairResult = await deviceService.pairDevice({
      enrollmentToken: pairingData.pairingToken,
      label: 'Main Office Till Samsung S23',
      deviceModel: 'SM-S911B',
      manufacturer: 'Samsung',
      androidVersion: '14.0',
      appVersion: '1.2.0',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----',
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
    });

    assert.ok(pairResult.deviceId);
    assert.equal(pairResult.organizationId, orgId);
    assert.ok(pairResult.deviceToken.startsWith('bsk_dev_'));

    // Verify device in store
    const device = await dbStore.getDeviceById(pairResult.deviceId);
    assert.ok(device);
    assert.equal(device?.status, DeviceStatus.ACTIVE);
    assert.equal(device?.deviceModel, 'SM-S911B');

    // Pairing token is single-use: subsequent pairing with same token must fail
    await assert.rejects(
      deviceService.pairDevice({
        enrollmentToken: pairingData.pairingToken,
        deviceModel: 'Hacker Phone',
        manufacturer: 'Unknown',
        androidVersion: '13',
        appVersion: '1.0',
        publicKeyPem: 'fake_key',
      }),
      /Pairing token is invalid, already used, or expired/,
    );
  });

  it('should accept telemetry heartbeats from authenticated active devices', async () => {
    const pairingData = await deviceService.createPairingToken(orgId, ownerUserId);
    const pairResult = await deviceService.pairDevice({
      enrollmentToken: pairingData.pairingToken,
      deviceModel: 'Redmi Note 12',
      manufacturer: 'Xiaomi',
      androidVersion: '13',
      appVersion: '1.0.0',
      publicKeyPem: 'sample_public_key',
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
    const pairResult = await deviceService.pairDevice({
      enrollmentToken: pairingData.pairingToken,
      deviceModel: 'Tecno Spark 10',
      manufacturer: 'Transsion',
      androidVersion: '13',
      appVersion: '1.0.0',
      publicKeyPem: 'tecno_key',
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
      /Device authentication failed/,
    );
  });
});
