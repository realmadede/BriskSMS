import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { hashToken } from '../src/core/crypto.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { SubscriptionService } from '../src/modules/subscription/subscription.service.js';
import { DeviceService } from '../src/modules/device/device.service.js';
import { buildPairingChallengeTranscript } from '../src/modules/device/device-crypto.js';
import { sql, withTransaction } from '@brisksms/db';
import {
  BillingInterval,
  DeviceCommandStatus,
  DeviceIngestionMode,
  DeviceStatus,
  UserRole,
} from '@brisksms/shared';

function generateTestP256KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    fingerprint: createHash('sha256').update(spkiDer).digest('hex'),
    privateKey,
  };
}

async function enrollTestDevice(
  svc: DeviceService,
  orgId: string,
  adminUserId: string,
  label = 'Galaxy A54 Gateway',
) {
  const pairingTokenRes = await svc.createPairingToken(orgId, adminUserId);
  const keys = generateTestP256KeyPair();
  const challenge = await svc.createPairingChallenge({
    enrollmentToken: pairingTokenRes.pairingToken,
    publicKeyPem: keys.publicKeyPem,
  });

  const transcript = buildPairingChallengeTranscript({
    challengeId: challenge.challengeId,
    enrollmentId: challenge.enrollmentId,
    organizationId: challenge.organizationId,
    pairingTokenHash: hashToken(pairingTokenRes.pairingToken),
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

  return svc.pairDevice({
    enrollmentToken: pairingTokenRes.pairingToken,
    challengeId: challenge.challengeId,
    challengeSignature,
    enrollmentId: challenge.enrollmentId,
    organizationId: challenge.organizationId,
    publicKeyPem: keys.publicKeyPem,
    deviceModel: 'SM-A546E',
    manufacturer: 'Samsung',
    androidVersion: '14',
    appVersion: '1.2.0',
    label,
    ingestionMode: DeviceIngestionMode.HYBRID,
  });
}

describe('P1: Durable PostgreSQL-Backed Fleet Command Queue', () => {
  const router = createApp();
  const authService = new AuthService();
  const subscriptionService = new SubscriptionService();

  let orgAId: string;
  let adminAId: string;
  let adminAJwt: string;

  let orgBId: string;
  let adminBId: string;
  let adminBJwt: string;

  beforeEach(async () => {
    await dbStore.reset();
    delete process.env.DEVICE_COMMAND_TTL_SECONDS;
    delete process.env.DEVICE_COMMAND_LEASE_SECONDS;

    const regA = await authService.register({
      email: `p1-owner-a-${randomUUID().slice(0, 6)}@brisksms.co.tz`,
      password: 'StrongPassword123!',
      fullName: 'Org A Admin',
      organizationName: 'Kilimanjaro Fiber Ltd',
    });
    orgAId = regA.organizationId!;
    adminAId = regA.user.id;
    adminAJwt = regA.tokens.accessToken;
    await subscriptionService.checkoutSubscription(orgAId, adminAId, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });

    const regB = await authService.register({
      email: `p1-owner-b-${randomUUID().slice(0, 6)}@brisksms.co.tz`,
      password: 'StrongPassword123!',
      fullName: 'Org B Admin',
      organizationName: 'Serengeti ISP Ltd',
    });
    orgBId = regB.organizationId!;
    adminBId = regB.user.id;
    adminBJwt = regB.tokens.accessToken;
    await subscriptionService.checkoutSubscription(orgBId, adminBId, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
  });

  async function makeHttpRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: any }> {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = path;
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    const res = new ServerResponse(req);
    let capturedBody = '';
    let statusCode = 200;

    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.end = (chunk: any) => {
      if (chunk) capturedBody += chunk.toString();
      return res;
    };

    if (body) {
      req.push(JSON.stringify(body));
    }
    req.push(null);

    await router.handle(req, res);

    let parsed: any = null;
    try {
      parsed = capturedBody ? JSON.parse(capturedBody) : null;
    } catch {
      parsed = { raw: capturedBody };
    }
    return { statusCode, json: parsed };
  }

  describe('1. Persistence, Restart Recovery & Expiration', () => {
    it('persists commands in PostgreSQL across API service reconstructions and completes full lifecycle', async () => {
      const replica1 = new DeviceService('api-replica-1');
      const enrolled = await enrollTestDevice(replica1, orgAId, adminAId);

      const cmdRes = await makeHttpRequest(
        'POST',
        `/v1/devices/${enrolled.deviceId}/command`,
        { Authorization: `Bearer ${adminAJwt}` },
        {
          type: 'SWITCH_SIM',
          payload: { simSlot: 2 },
        },
      );
      assert.equal(cmdRes.statusCode, 200);
      const commandId = cmdRes.json?.data?.id;
      assert.ok(commandId);
      assert.equal(cmdRes.json?.data?.status, DeviceCommandStatus.PENDING);
      assert.equal(cmdRes.json?.data?.deliveryAttempts, 0);

      // Reconstruct a brand-new DeviceService instance and router simulating API restart
      const replica2 = new DeviceService('api-replica-2');
      const freshRouter = createApp();
      assert.ok(freshRouter);

      const poll = await replica2.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 82,
        isCharging: true,
        networkType: 'WIFI',
      });

      assert.equal(poll.commands.length, 1);
      assert.equal(poll.commands[0]!.id, commandId);
      assert.equal(poll.commands[0]!.type, 'SWITCH_SIM');
      assert.deepEqual(poll.commands[0]!.payload, { simSlot: 2 });
      assert.equal(poll.commands[0]!.status, DeviceCommandStatus.DELIVERED);
      assert.equal(poll.commands[0]!.deliveryAttempts, 1);
      assert.ok(poll.commands[0]!.leaseToken);
      assert.ok(poll.commands[0]!.leaseExpiresAt);

      // Polling was delivered, NOT acknowledged yet in PostgreSQL
      const dbBeforeAck = await sql`
        SELECT "status", "delivery_attempts", "acknowledged_at"
        FROM "device_commands"
        WHERE "id" = ${commandId}
      `;
      assert.equal(dbBeforeAck[0]!.status, 'DELIVERED');
      assert.equal(dbBeforeAck[0]!.delivery_attempts, 1);
      assert.equal(dbBeforeAck[0]!.acknowledged_at, null);

      // Explicit acknowledgement through reconstructed replica/app transitions to ACKNOWLEDGED
      const ackHttp = await makeHttpRequest(
        'POST',
        `/v1/devices/${enrolled.deviceId}/commands/${commandId}/ack`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        {
          status: 'ACKNOWLEDGED',
          leaseToken: poll.commands[0]!.leaseToken,
          result: { activeSimSlot: 2 },
        },
      );
      assert.equal(ackHttp.statusCode, 200);
      assert.equal(ackHttp.json?.data?.idempotentReplay, false);
      assert.equal(ackHttp.json?.data?.command?.status, 'ACKNOWLEDGED');
      assert.ok(ackHttp.json?.data?.command?.acknowledgedAt);
    });

    it('expires overdue commands and never delivers them on subsequent polls', async () => {
      const svc = new DeviceService('api-expiry');
      const enrolled = await enrollTestDevice(svc, orgAId, adminAId);

      const cmd = await svc.queueCommand(enrolled.deviceId, orgAId, adminAId, 'PAUSE_RELAY');
      await sql`
        UPDATE "device_commands"
        SET "created_at" = NOW() - INTERVAL '2 hours',
            "expires_at" = NOW() - INTERVAL '5 seconds'
        WHERE "id" = ${cmd.id}
      `;

      const poll = await svc.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 90,
        isCharging: false,
        networkType: 'CELLULAR',
      });
      assert.equal(poll.commands.length, 0);

      const history = await svc.listDeviceCommands(enrolled.deviceId, orgAId, adminAId);
      assert.equal(history.length, 1);
      assert.equal(history[0]!.id, cmd.id);
      assert.equal(history[0]!.status, DeviceCommandStatus.EXPIRED);
    });
  });

  describe('2. Authorization, Tenant Isolation & Revoked Device Enforcement', () => {
    it('prevents cross-device, cross-tenant, and non-admin access across poll, ack, cancel, and list', async () => {
      const svc = new DeviceService('api-authz');
      const devA1 = await enrollTestDevice(svc, orgAId, adminAId, 'Device A1');
      const devA2 = await enrollTestDevice(svc, orgAId, adminAId, 'Device A2');
      const devB1 = await enrollTestDevice(svc, orgBId, adminBId, 'Device B1');

      const cmd = await svc.queueCommand(devA1.deviceId, orgAId, adminAId, 'PAUSE_RELAY');

      // Same-org Device A2 cannot poll Device A1's commands or use its own token on A1 URL
      await assert.rejects(
        svc.recordTelemetry(devA1.deviceId, devA2.deviceToken, {
          batteryPercentage: 80,
          isCharging: false,
          networkType: 'WIFI',
        }),
        /Device authentication failed/,
      );
      const pollA2 = await svc.recordTelemetry(devA2.deviceId, devA2.deviceToken, {
        batteryPercentage: 80,
        isCharging: false,
        networkType: 'WIFI',
      });
      assert.equal(pollA2.commands.length, 0);

      // Cross-org Device B1 cannot acknowledge Device A1's command (even with command UUID)
      const crossAckHttp = await makeHttpRequest(
        'POST',
        `/v1/devices/${devB1.deviceId}/commands/${cmd.id}/ack`,
        { Authorization: `Bearer ${devB1.deviceToken}` },
        { status: 'ACKNOWLEDGED' },
      );
      assert.equal(crossAckHttp.statusCode, 404);

      const spoofAckHttp = await makeHttpRequest(
        'POST',
        `/v1/devices/${devA1.deviceId}/commands/${cmd.id}/ack`,
        { Authorization: `Bearer ${devB1.deviceToken}` },
        { status: 'ACKNOWLEDGED' },
      );
      assert.equal(spoofAckHttp.statusCode, 401);

      // Same-org Device A2 also cannot acknowledge Device A1's command
      const sameOrgSpoofAck = await makeHttpRequest(
        'POST',
        `/v1/devices/${devA2.deviceId}/commands/${cmd.id}/ack`,
        { Authorization: `Bearer ${devA2.deviceToken}` },
        { status: 'ACKNOWLEDGED' },
      );
      assert.equal(sameOrgSpoofAck.statusCode, 404);

      // Org B admin cannot queue, list, or cancel Org A's device commands
      const crossQueue = await makeHttpRequest(
        'POST',
        `/v1/devices/${devA1.deviceId}/command`,
        { Authorization: `Bearer ${adminBJwt}` },
        { type: 'RESUME_RELAY' },
      );
      assert.equal(crossQueue.statusCode, 404);

      const mismatchedOrgHeaderBody = await makeHttpRequest(
        'POST',
        `/v1/devices/${devA1.deviceId}/command`,
        { Authorization: `Bearer ${adminAJwt}` },
        { organizationId: orgBId, type: 'RESUME_RELAY' },
      );
      assert.equal(mismatchedOrgHeaderBody.statusCode, 403);
      assert.equal(mismatchedOrgHeaderBody.json?.error?.code, 'CROSS_ORGANIZATION_FORBIDDEN');

      const crossList = await makeHttpRequest(
        'GET',
        `/v1/devices/${devA1.deviceId}/commands`,
        { Authorization: `Bearer ${adminBJwt}` },
      );
      assert.equal(crossList.statusCode, 404);

      const crossCancel = await makeHttpRequest(
        'POST',
        `/v1/devices/${devA1.deviceId}/commands/${cmd.id}/cancel`,
        { Authorization: `Bearer ${adminBJwt}` },
      );
      assert.equal(crossCancel.statusCode, 404);

      // Non-admin FINANCE user in Org A cannot queue or cancel commands
      const financeReg = await authService.register({
        email: `finance-${randomUUID().slice(0, 6)}@brisksms.co.tz`,
        password: 'StrongPassword123!',
        fullName: 'Finance Member',
      });
      await sql`
        INSERT INTO "users_organizations" ("organization_id", "user_id", "role")
        VALUES (${orgAId}, ${financeReg.user.id}, ${UserRole.FINANCE}::"UserRole")
      `;
      await assert.rejects(
        svc.queueCommand(devA1.deviceId, orgAId, financeReg.user.id, 'PAUSE_RELAY'),
        /Only Owners and Admins can issue device commands/,
      );
      await assert.rejects(
        svc.cancelDeviceCommand(devA1.deviceId, cmd.id, orgAId, financeReg.user.id),
        /Only Owners and Admins can cancel device commands/,
      );
    });

    it('blocks revoked devices from polling or acknowledging and cancels open commands on revocation', async () => {
      const svc = new DeviceService('api-revoked');
      const enrolled = await enrollTestDevice(svc, orgAId, adminAId);

      const pendingCmd = await svc.queueCommand(enrolled.deviceId, orgAId, adminAId, 'PAUSE_RELAY');
      const deliveredPoll = await svc.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 75,
        isCharging: false,
        networkType: 'WIFI',
      });
      assert.equal(deliveredPoll.commands.length, 1);

      const secondCmd = await svc.queueCommand(enrolled.deviceId, orgAId, adminAId, 'RESUME_RELAY');

      // Revoke device
      const revoked = await svc.revokeDevice(enrolled.deviceId, orgAId, adminAId);
      assert.equal(revoked.status, DeviceStatus.REVOKED);

      // Open commands must be cancelled automatically
      const history = await svc.listDeviceCommands(enrolled.deviceId, orgAId, adminAId);
      assert.equal(history.length, 2);
      for (const item of history) {
        assert.equal(item.status, DeviceCommandStatus.CANCELLED);
      }

      // Revoked device cannot poll or acknowledge
      const telemetryRes = await makeHttpRequest(
        'POST',
        `/v1/devices/${enrolled.deviceId}/telemetry`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { batteryPercentage: 70, isCharging: false, networkType: 'WIFI' },
      );
      assert.equal(telemetryRes.statusCode, 403);
      assert.equal(telemetryRes.json?.error?.code, 'DEVICE_REVOKED');

      const ackRes = await makeHttpRequest(
        'POST',
        `/v1/devices/${enrolled.deviceId}/commands/${pendingCmd.id}/ack`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { status: 'ACKNOWLEDGED', leaseToken: deliveredPoll.commands[0]!.leaseToken },
      );
      assert.equal(ackRes.statusCode, 403);
      assert.equal(ackRes.json?.error?.code, 'DEVICE_REVOKED');

      // New commands cannot be queued onto a revoked device
      await assert.rejects(
        svc.queueCommand(enrolled.deviceId, orgAId, adminAId, 'RESUME_RELAY'),
        /revoked device/,
      );
      assert.ok(secondCmd.id);
    });
  });

  describe('3. Concurrency, Multi-Replica Locking & Lease Recovery', () => {
    it('prevents concurrent polls across multiple API instances from claiming the same command twice', async () => {
      const replicaA = new DeviceService('replica-A');
      const replicaB = new DeviceService('replica-B');
      const replicaC = new DeviceService('replica-C');

      const enrolled = await enrollTestDevice(replicaA, orgAId, adminAId);
      const cmd = await replicaA.queueCommand(enrolled.deviceId, orgAId, adminAId, 'PAUSE_RELAY');

      const polls = await Promise.all([
        replicaA.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
          batteryPercentage: 85,
          isCharging: true,
          networkType: 'WIFI',
        }),
        replicaB.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
          batteryPercentage: 85,
          isCharging: true,
          networkType: 'WIFI',
        }),
        replicaC.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
          batteryPercentage: 85,
          isCharging: true,
          networkType: 'WIFI',
        }),
      ]);

      const deliveredBatches = polls.filter((p) => p.commands.length > 0);
      assert.equal(deliveredBatches.length, 1);
      assert.equal(deliveredBatches[0]!.commands[0]!.id, cmd.id);

      const rows = await sql`SELECT "delivery_attempts", "status" FROM "device_commands" WHERE "id" = ${cmd.id}`;
      assert.equal(rows[0]!.delivery_attempts, 1);
      assert.equal(rows[0]!.status, 'DELIVERED');
    });

    it('uses FOR UPDATE SKIP LOCKED safely so a locked command row does not block claiming another command', async () => {
      const replicaA = new DeviceService('replica-skip-lock');
      const enrolled = await enrollTestDevice(replicaA, orgAId, adminAId);

      const cmd1 = await replicaA.queueCommand(enrolled.deviceId, orgAId, adminAId, 'PAUSE_RELAY');
      const cmd2 = await replicaA.queueCommand(enrolled.deviceId, orgAId, adminAId, 'SWITCH_SIM', { simSlot: 2 });

      // Lock cmd1 specifically in an external transaction without locking the device row
      let lockAcquired!: () => void;
      let releaseLock!: () => void;
      const lockReady = new Promise<void>((r) => {
        lockAcquired = r;
      });
      const holdLock = new Promise<void>((r) => {
        releaseLock = r;
      });

      const lockerPromise = withTransaction(async (tx) => {
        await tx`SELECT * FROM "device_commands" WHERE "id" = ${cmd1.id} FOR UPDATE`;
        lockAcquired();
        await holdLock;
      });

      try {
        await lockReady;
        const poll = await replicaA.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
          batteryPercentage: 95,
          isCharging: true,
          networkType: 'WIFI',
        });

        // cmd1 was skipped (not deadlocked), cmd2 was delivered immediately
        assert.equal(poll.commands.length, 1);
        assert.equal(poll.commands[0]!.id, cmd2.id);
      } finally {
        releaseLock();
        await lockerPromise;
      }

      // Now cmd1 is unlocked and claimed cleanly on the next telemetry poll
      const nextPoll = await replicaA.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 95,
        isCharging: true,
        networkType: 'WIFI',
      });
      assert.equal(nextPoll.commands.length, 1);
      assert.equal(nextPoll.commands[0]!.id, cmd1.id);
    });

    it('recovers from lost delivery response after lease expiry and fails once maxDeliveryAttempts exhausted', async () => {
      const replica1 = new DeviceService('replica-crash');
      const replica2 = new DeviceService('replica-recover');
      const enrolled = await enrollTestDevice(replica1, orgAId, adminAId);

      const cmd = await replica1.queueCommand(enrolled.deviceId, orgAId, adminAId, 'RESUME_RELAY');

      // Simulate lease-2 recovery (set max_delivery_attempts = 2 for concise test)
      await sql`
        UPDATE "device_commands"
        SET "max_delivery_attempts" = 2
        WHERE "id" = ${cmd.id}
      `;

      // Attempt 1 delivered, response lost before Android receives/acks
      const attempt1 = await replica1.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 60,
        isCharging: false,
        networkType: 'CELLULAR',
      });
      assert.equal(attempt1.commands.length, 1);
      assert.equal(attempt1.commands[0]!.deliveryAttempts, 1);
      const firstLeaseToken = attempt1.commands[0]!.leaseToken!;

      // Immediate poll while lease is active must NOT redeliver
      const activeLeasePoll = await replica2.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 60,
        isCharging: false,
        networkType: 'CELLULAR',
      });
      assert.equal(activeLeasePoll.commands.length, 0);

      // Simulate lease expiry without acknowledgement
      await sql`
        UPDATE "device_commands"
        SET "lease_expires_at" = NOW() - INTERVAL '1 second'
        WHERE "id" = ${cmd.id}
      `;

      // Attempt 2 safely redelivers with a fresh lease token
      const attempt2 = await replica2.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 59,
        isCharging: false,
        networkType: 'CELLULAR',
      });
      assert.equal(attempt2.commands.length, 1);
      assert.equal(attempt2.commands[0]!.id, cmd.id);
      assert.equal(attempt2.commands[0]!.deliveryAttempts, 2);
      assert.notEqual(attempt2.commands[0]!.leaseToken, firstLeaseToken);

      // Stale lease token from attempt 1 must be rejected
      await assert.rejects(
        replica2.acknowledgeCommand(enrolled.deviceId, enrolled.deviceToken, cmd.id, {
          status: 'ACKNOWLEDGED',
          leaseToken: firstLeaseToken,
        }),
        /does not match the active delivery lease/,
      );

      // Simulate second lease expiring without ACK -> exhausted (FAILED)
      await sql`
        UPDATE "device_commands"
        SET "lease_expires_at" = NOW() - INTERVAL '1 second'
        WHERE "id" = ${cmd.id}
      `;

      const attempt3 = await replica2.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 58,
        isCharging: false,
        networkType: 'CELLULAR',
      });
      assert.equal(attempt3.commands.length, 0);

      const history = await replica2.listDeviceCommands(enrolled.deviceId, orgAId, adminAId);
      assert.equal(history[0]!.status, DeviceCommandStatus.FAILED);
      assert.match(history[0]!.failureReason || '', /Maximum delivery attempts exhausted/);
    });
  });

  describe('4. Acknowledgements, Cancellation, Idempotency & Validation', () => {
    it('enforces idempotent ACKs, inline telemetry ACKs, and prevents contradictory or late reversal of terminal commands', async () => {
      const svc = new DeviceService('api-ack-policy');
      const enrolled = await enrollTestDevice(svc, orgAId, adminAId);

      // Queue two commands
      const cmdOk = await svc.queueCommand(enrolled.deviceId, orgAId, adminAId, 'PAUSE_RELAY');
      const cmdLateExp = await svc.queueCommand(enrolled.deviceId, orgAId, adminAId, 'RESUME_RELAY');
      const cmdUndelivered = await svc.queueCommand(enrolled.deviceId, orgAId, adminAId, 'SWITCH_SIM', { simSlot: 1 });

      // Cannot acknowledge an undelivered PENDING command
      await assert.rejects(
        svc.acknowledgeCommand(enrolled.deviceId, enrolled.deviceToken, cmdUndelivered.id, {
          status: 'ACKNOWLEDGED',
        }),
        /before it has been delivered/,
      );

      // Cancel cmdUndelivered before delivery
      const cancelled = await svc.cancelDeviceCommand(
        enrolled.deviceId,
        cmdUndelivered.id,
        orgAId,
        adminAId,
        'Superseded',
      );
      assert.equal(cancelled.status, DeviceCommandStatus.CANCELLED);

      // Deliver cmdOk and cmdLateExp
      const poll = await svc.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 88,
        isCharging: true,
        networkType: 'WIFI',
      });
      assert.equal(poll.commands.length, 2);

      // Expire cmdLateExp after delivery
      await sql`
        UPDATE "device_commands"
        SET "created_at" = NOW() - INTERVAL '2 hours',
            "expires_at" = NOW() - INTERVAL '2 seconds'
        WHERE "id" = ${cmdLateExp.id}
      `;

      // Send both inline ACKs on next telemetry heartbeat
      const ackTelemetry = await svc.recordTelemetry(enrolled.deviceId, enrolled.deviceToken, {
        batteryPercentage: 89,
        isCharging: true,
        networkType: 'WIFI',
        commandAcknowledgements: [
          { commandId: cmdOk.id, status: 'ACKNOWLEDGED' },
          { commandId: cmdLateExp.id, status: 'ACKNOWLEDGED' },
          { commandId: cmdUndelivered.id, status: 'ACKNOWLEDGED' },
        ],
      });

      assert.equal(ackTelemetry.ackResults?.length, 3);
      assert.deepEqual(ackTelemetry.ackResults![0], {
        commandId: cmdOk.id,
        accepted: true,
        status: DeviceCommandStatus.ACKNOWLEDGED,
        idempotentReplay: false,
      });
      assert.deepEqual(ackTelemetry.ackResults![1], {
        commandId: cmdLateExp.id,
        accepted: false,
        errorCode: 'COMMAND_EXPIRED',
      });
      assert.deepEqual(ackTelemetry.ackResults![2], {
        commandId: cmdUndelivered.id,
        accepted: false,
        errorCode: 'COMMAND_CANCELLED',
      });

      // Duplicate matching ACK is idempotent
      const dupAck = await svc.acknowledgeCommand(enrolled.deviceId, enrolled.deviceToken, cmdOk.id, {
        status: 'ACKNOWLEDGED',
      });
      assert.equal(dupAck.idempotentReplay, true);
      assert.equal(dupAck.command.status, DeviceCommandStatus.ACKNOWLEDGED);

      // Contradictory ACK (FAILED on ACKNOWLEDGED) must reject cleanly with 409
      const conflictAck = await makeHttpRequest(
        'POST',
        `/v1/devices/${enrolled.deviceId}/commands/${cmdOk.id}/ack`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { status: 'FAILED', failureReason: 'Late error' },
      );
      assert.equal(conflictAck.statusCode, 409);
      assert.equal(conflictAck.json?.error?.code, 'COMMAND_TERMINAL_CONFLICT');

      // Direct late ACK on EXPIRED or CANCELLED must reject with 409 and NOT reverse terminal state
      const lateExpDirect = await makeHttpRequest(
        'POST',
        `/v1/devices/${enrolled.deviceId}/commands/${cmdLateExp.id}/ack`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { status: 'ACKNOWLEDGED' },
      );
      assert.equal(lateExpDirect.statusCode, 409);
      assert.equal(lateExpDirect.json?.error?.code, 'COMMAND_EXPIRED');

      // Cannot cancel already ACKNOWLEDGED command
      const cancelAcked = await makeHttpRequest(
        'POST',
        `/v1/devices/${enrolled.deviceId}/commands/${cmdOk.id}/cancel`,
        { Authorization: `Bearer ${adminAJwt}` },
      );
      assert.equal(cancelAcked.statusCode, 409);
      assert.equal(cancelAcked.json?.error?.code, 'INVALID_COMMAND_TRANSITION');
    });

    it('enforces queue Idempotency-Key deduplication, conflict rejection, payload validation, and WIPE_AND_REVOKE invariants', async () => {
      const svc = new DeviceService('api-validation');
      const dev1 = await enrollTestDevice(svc, orgAId, adminAId, 'Validation Dev 1');
      const dev2 = await enrollTestDevice(svc, orgAId, adminAId, 'Validation Dev 2');

      const idemKey = `cmd-idem-${randomUUID()}`;
      const firstReq = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev1.deviceId}/command`,
        {
          Authorization: `Bearer ${adminAJwt}`,
          'Idempotency-Key': idemKey,
        },
        {
          type: 'SWITCH_SIM',
          payload: { simSlot: 2 },
        },
      );
      assert.equal(firstReq.statusCode, 200);
      const createdId = firstReq.json?.data?.id;

      // Exact replay with same Idempotency-Key returns same command ID
      const replayReq = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev1.deviceId}/command`,
        {
          Authorization: `Bearer ${adminAJwt}`,
          'Idempotency-Key': idemKey,
        },
        {
          type: 'SWITCH_SIM',
          payload: { simSlot: 2 },
        },
      );
      assert.equal(replayReq.statusCode, 200);
      assert.equal(replayReq.json?.data?.id, createdId);

      // Reusing Idempotency-Key with different payload -> 409 IDEMPOTENCY_KEY_REUSE_CONFLICT
      const conflictPayloadReq = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev1.deviceId}/command`,
        {
          Authorization: `Bearer ${adminAJwt}`,
          'Idempotency-Key': idemKey,
        },
        {
          type: 'SWITCH_SIM',
          payload: { simSlot: 1 },
        },
      );
      assert.equal(conflictPayloadReq.statusCode, 409);
      assert.equal(conflictPayloadReq.json?.error?.code, 'IDEMPOTENCY_KEY_REUSE_CONFLICT');

      // Reusing Idempotency-Key against a different device in same org -> 409 IDEMPOTENCY_KEY_REUSE_CONFLICT
      const conflictDeviceReq = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev2.deviceId}/command`,
        {
          Authorization: `Bearer ${adminAJwt}`,
          'Idempotency-Key': idemKey,
        },
        {
          type: 'SWITCH_SIM',
          payload: { simSlot: 2 },
        },
      );
      assert.equal(conflictDeviceReq.statusCode, 409);
      assert.equal(conflictDeviceReq.json?.error?.code, 'IDEMPOTENCY_KEY_REUSE_CONFLICT');

      // Reject undocumented/unsupported command types
      for (const bogusType of ['PING', 'SYNC', 'RESTART_SERVICE', 'SHELL_EXEC']) {
        const badType = await makeHttpRequest(
          'POST',
          `/v1/devices/${dev1.deviceId}/command`,
          { Authorization: `Bearer ${adminAJwt}` },
          { type: bogusType },
        );
        assert.equal(badType.statusCode, 400);
        assert.equal(badType.json?.error?.code, 'INVALID_COMMAND');
      }

      // Reject invalid payloads
      const missingSim = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev1.deviceId}/command`,
        { Authorization: `Bearer ${adminAJwt}` },
        { type: 'SWITCH_SIM' },
      );
      assert.equal(missingSim.statusCode, 400);
      assert.equal(missingSim.json?.error?.code, 'INVALID_COMMAND_PAYLOAD');

      const outOfRangeSim = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev1.deviceId}/command`,
        { Authorization: `Bearer ${adminAJwt}` },
        { type: 'SWITCH_SIM', payload: { simSlot: 3 } },
      );
      assert.equal(outOfRangeSim.statusCode, 400);

      const extraFieldPause = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev1.deviceId}/command`,
        { Authorization: `Bearer ${adminAJwt}` },
        { type: 'PAUSE_RELAY', payload: { unexpected: true } },
      );
      assert.equal(extraFieldPause.statusCode, 400);

      // Deliver first SWITCH_SIM command and verify sensitive keys are rejected in ack result
      const delivered = await svc.recordTelemetry(dev1.deviceId, dev1.deviceToken, {
        batteryPercentage: 80,
        isCharging: false,
        networkType: 'WIFI',
      });
      assert.equal(delivered.commands.length, 1);

      const secretAck = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev1.deviceId}/commands/${createdId}/ack`,
        { Authorization: `Bearer ${dev1.deviceToken}` },
        { status: 'ACKNOWLEDGED', result: { deviceToken: 'bsk_dev_leak' } },
      );
      assert.equal(secretAck.statusCode, 400);

      // Acknowledge cleanly without secrets
      await svc.acknowledgeCommand(dev1.deviceId, dev1.deviceToken, createdId, { status: 'ACKNOWLEDGED' });

      // Issue WIPE_AND_REVOKE on dev2 after queueing a pending PAUSE_RELAY
      const dev2Pending = await svc.queueCommand(dev2.deviceId, orgAId, adminAId, 'PAUSE_RELAY');
      const wipeIdem = `wipe-${randomUUID()}`;
      const wipeCmd = await svc.queueCommand(
        dev2.deviceId,
        orgAId,
        adminAId,
        'WIPE_AND_REVOKE',
        { reason: 'Handset reported stolen' },
        { idempotencyKey: wipeIdem },
      );
      assert.equal(wipeCmd.type, 'WIPE_AND_REVOKE');
      assert.equal(wipeCmd.maxDeliveryAttempts, 1);

      // Idempotent replay of WIPE_AND_REVOKE returns the stored command without failing
      const wipeReplay = await svc.queueCommand(
        dev2.deviceId,
        orgAId,
        adminAId,
        'WIPE_AND_REVOKE',
        { reason: 'Handset reported stolen' },
        { idempotencyKey: wipeIdem },
      );
      assert.equal(wipeReplay.id, wipeCmd.id);

      // Device dev2 must immediately be REVOKED server-side, open prior command cancelled, and telemetry blocked
      const dev2Record = await dbStore.getDeviceById(dev2.deviceId, orgAId);
      assert.equal(dev2Record?.status, DeviceStatus.REVOKED);

      const dev2History = await svc.listDeviceCommands(dev2.deviceId, orgAId, adminAId);
      const priorPause = dev2History.find((c) => c.id === dev2Pending.id);
      assert.equal(priorPause?.status, DeviceCommandStatus.CANCELLED);

      const postWipeTelemetry = await makeHttpRequest(
        'POST',
        `/v1/devices/${dev2.deviceId}/telemetry`,
        { Authorization: `Bearer ${dev2.deviceToken}` },
        { batteryPercentage: 50, isCharging: false, networkType: 'CELLULAR' },
      );
      assert.equal(postWipeTelemetry.statusCode, 403);
      assert.equal(postWipeTelemetry.json?.error?.code, 'DEVICE_REVOKED');
    });
  });
});
