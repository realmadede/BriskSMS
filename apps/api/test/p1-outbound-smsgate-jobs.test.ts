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
import { messagingService } from '../src/modules/messaging/messaging.service.js';
import { OutboundSmsJobService } from '../src/modules/messaging/outbound-sms-job.service.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { sql, withTransaction } from '@brisksms/db';
import {
  ApiKeyScope,
  BillingInterval,
  CreditLedgerEntryType,
  DeviceIngestionMode,
  DeviceStatus,
  OutboundSmsJobStatus,
  SmsStatus,
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
  label = 'Galaxy A54 Companion',
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

describe('P1: Android Outbound SMSGate Job Acquisition & Delivery Integrity', () => {
  const router = createApp();
  const authService = new AuthService();
  const subscriptionService = new SubscriptionService();
  const apiKeyService = new ApiKeyService();

  let orgAId: string;
  let adminAId: string;
  let adminAJwt: string;

  let orgBId: string;
  let adminBId: string;
  let adminBJwt: string;

  beforeEach(async () => {
    await dbStore.reset();

    const regA = await authService.register({
      email: `smsgate-a-${randomUUID().slice(0, 6)}@brisksms.co.tz`,
      password: 'StrongPassword123!',
      fullName: 'Org A Admin',
      organizationName: 'Arusha Fiber Co',
    });
    orgAId = regA.organizationId!;
    adminAId = regA.user.id;
    adminAJwt = regA.tokens.accessToken;
    await subscriptionService.checkoutSubscription(orgAId, adminAId, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
    await messagingService.purchaseCredits(orgAId, 50, `TOPUP-A-${randomUUID().slice(0, 6)}`);

    const regB = await authService.register({
      email: `smsgate-b-${randomUUID().slice(0, 6)}@brisksms.co.tz`,
      password: 'StrongPassword123!',
      fullName: 'Org B Admin',
      organizationName: 'Mwanza Net Ltd',
    });
    orgBId = regB.organizationId!;
    adminBId = regB.user.id;
    adminBJwt = regB.tokens.accessToken;
    await subscriptionService.checkoutSubscription(orgBId, adminBId, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });
    await messagingService.purchaseCredits(orgBId, 50, `TOPUP-B-${randomUUID().slice(0, 6)}`);
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

  describe('1. Durable Lifecycle, Honest Radio vs Delivery Separation & Restart Survival', () => {
    it('enqueues durably in PostgreSQL, enforces /dispatching gate before SUBMITTED/DELIVERED, and survives replica restarts', async () => {
      const deviceSvc = new DeviceService('api-replica-1');
      const enrolled = await enrollTestDevice(deviceSvc, orgAId, adminAId);

      // Enqueue via HTTP /v1/messaging/device-jobs
      const enqueueRes = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs',
        { Authorization: `Bearer ${adminAJwt}`, 'Idempotency-Key': 'job-idem-001' },
        {
          to: '0754123456',
          content: 'Habari Baraka, malipo yako yamethibitishwa.',
          simSlot: 2,
          deviceId: enrolled.deviceId,
        },
      );
      assert.equal(enqueueRes.statusCode, 201);
      const jobId = enqueueRes.json.data.job.id as string;
      const messageId = enqueueRes.json.data.message.id as string;
      assert.equal(enqueueRes.json.data.job.status, OutboundSmsJobStatus.QUEUED);
      assert.equal(enqueueRes.json.data.job.recipientPhone, '+255754123456');
      assert.equal(await messagingService.getCreditBalance(orgAId), 49);

      // Idempotent replay with same key & payload returns existing job without charging again
      const replayRes = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs',
        { Authorization: `Bearer ${adminAJwt}`, 'Idempotency-Key': 'job-idem-001' },
        {
          to: '+255754123456',
          content: 'Habari Baraka, malipo yako yamethibitishwa.',
          simSlot: 2,
          deviceId: enrolled.deviceId,
        },
      );
      assert.equal(replayRes.statusCode, 200);
      assert.equal(replayRes.json.data.idempotentReplay, true);
      assert.equal(replayRes.json.data.job.id, jobId);
      assert.equal(await messagingService.getCreditBalance(orgAId), 49);

      // Mismatched payload with same idempotency key fails closed 409
      const mismatchRes = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs',
        { Authorization: `Bearer ${adminAJwt}`, 'Idempotency-Key': 'job-idem-001' },
        {
          to: '+255754999999',
          content: 'Tampered content',
          simSlot: 2,
          deviceId: enrolled.deviceId,
        },
      );
      assert.equal(mismatchRes.statusCode, 409);

      // Fresh service instance simulates API restart
      const freshService = new OutboundSmsJobService();
      const acquiredRes = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs/acquire',
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { limit: 5, leaseSeconds: 60, availableSimSlots: [1, 2] },
      );
      assert.equal(acquiredRes.statusCode, 200);
      assert.equal(acquiredRes.json.data.relayEnabled, true);
      assert.equal(acquiredRes.json.data.jobs.length, 1);

      const claimed = acquiredRes.json.data.jobs[0];
      assert.equal(claimed.id, jobId);
      assert.equal(claimed.status, OutboundSmsJobStatus.CLAIMED);
      assert.ok(claimed.leaseToken);

      // Attempting to report SUBMITTED without calling /dispatching first is rejected fail-closed
      const skipDispatchingRes = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${jobId}/result`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { leaseToken: claimed.leaseToken, outcome: 'SUBMITTED', simSlot: 2 },
      );
      assert.equal(skipDispatchingRes.statusCode, 409);
      assert.equal(skipDispatchingRes.json.error.code, 'SMS_JOB_DISPATCH_NOT_STARTED');

      // Step 2: Android records /dispatching BEFORE calling SmsManager
      const dispatchingRes = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${jobId}/dispatching`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { leaseToken: claimed.leaseToken, simSlot: 2 },
      );
      assert.equal(dispatchingRes.statusCode, 200);
      assert.equal(dispatchingRes.json.data.job.status, OutboundSmsJobStatus.DISPATCHING);

      // Verify sms_messages is still NOT marked SENT or DELIVERED prematurely
      const preRadioMsg = await sql<Record<string, any>>`SELECT "status" FROM "sms_messages" WHERE "id" = ${messageId}::uuid`;
      assert.equal(preRadioMsg[0]!.status, SmsStatus.QUEUED);

      // Step 3a: Android sentReceiver reports SUBMITTED -> sms_messages becomes SUBMITTED (NOT DELIVERED!)
      const submittedRes = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${jobId}/result`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { leaseToken: claimed.leaseToken, outcome: 'SUBMITTED', simSlot: 2, partsCount: 1 },
      );
      assert.equal(submittedRes.statusCode, 200);
      assert.equal(submittedRes.json.data.job.status, OutboundSmsJobStatus.SUBMITTED);

      const sentMsg = await sql<Record<string, any>>`SELECT "status", "delivered_at" FROM "sms_messages" WHERE "id" = ${messageId}::uuid`;
      assert.equal(sentMsg[0]!.status, SmsStatus.SUBMITTED);
      assert.equal(sentMsg[0]!.delivered_at, null);

      // Duplicate SUBMITTED replay is idempotent
      const replaySubmitted = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${jobId}/result`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        { leaseToken: claimed.leaseToken, outcome: 'SUBMITTED', simSlot: 2 },
      );
      assert.equal(replaySubmitted.statusCode, 200);
      assert.equal(replaySubmitted.json.data.idempotentReplay, true);

      // Step 3b: Android deliveryReceiver reports DELIVERED -> sms_messages becomes DELIVERED with timestamp
      const deliveredRes = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${jobId}/result`,
        { Authorization: `Bearer ${enrolled.deviceToken}` },
        {
          leaseToken: claimed.leaseToken,
          outcome: 'DELIVERED',
          simSlot: 2,
          carrierTimestamp: '2026-11-15T18:00:00.000Z',
        },
      );
      assert.equal(deliveredRes.statusCode, 200);
      assert.equal(deliveredRes.json.data.job.status, OutboundSmsJobStatus.DELIVERED);

      const inspected = await freshService.getJobById(orgAId, jobId);
      assert.equal(inspected.status, OutboundSmsJobStatus.DELIVERED);
      const deliveredMsg = await sql<Record<string, any>>`SELECT "status", "delivered_at" FROM "sms_messages" WHERE "id" = ${messageId}::uuid`;
      assert.equal(deliveredMsg[0]!.status, SmsStatus.DELIVERED);
      assert.ok(deliveredMsg[0]!.delivered_at);
    });

    it('supports API-key /v1/messaging/send delegation with deliveryChannel=ANDROID_COMPANION', async () => {
      const apiKey = await apiKeyService.createApiKey(orgAId, {
        organizationId: orgAId,
        name: 'Companion Dispatch Key',
        scopes: [ApiKeyScope.SMS_SEND],
      });
      const sendRes = await makeHttpRequest(
        'POST',
        '/v1/messaging/send',
        { 'X-API-Key': apiKey.plainTextSecret },
        {
          to: '0713555666',
          content: 'Receipt #505 confirmed.',
          deliveryChannel: 'ANDROID_COMPANION',
          simSlot: 1,
        },
      );
      assert.equal(sendRes.statusCode, 201);
      assert.equal(sendRes.json.data.gatewayProvider, 'ANDROID_COMPANION');
      assert.equal(sendRes.json.data.outboundJobStatus, OutboundSmsJobStatus.QUEUED);
      assert.ok(sendRes.json.data.outboundJobId);
    });
  });

  describe('2. Concurrent Multi-Device Acquisition & Lease Expiry Recovery', () => {
    it('prevents duplicate job acquisition across concurrent devices using SKIP LOCKED', async () => {
      const deviceSvc = new DeviceService('concurrent-test');
      const dev1 = await enrollTestDevice(deviceSvc, orgAId, adminAId, 'Relay Phone 1');
      const dev2 = await enrollTestDevice(deviceSvc, orgAId, adminAId, 'Relay Phone 2');
      const jobSvc = new OutboundSmsJobService();

      const enqueuedIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await jobSvc.enqueueJob(orgAId, {
          to: `+25575400010${i}`,
          content: `Batch msg ${i}`,
          simSlot: 1,
        });
        enqueuedIds.push(res.job.id);
      }

      const [res1, res2] = await Promise.all([
        makeHttpRequest(
          'POST',
          '/v1/messaging/device-jobs/acquire',
          { Authorization: `Bearer ${dev1.deviceToken}` },
          { limit: 6, availableSimSlots: [1] },
        ),
        makeHttpRequest(
          'POST',
          '/v1/messaging/device-jobs/acquire',
          { Authorization: `Bearer ${dev2.deviceToken}` },
          { limit: 6, availableSimSlots: [1] },
        ),
      ]);

      assert.equal(res1.statusCode, 200);
      assert.equal(res2.statusCode, 200);
      const ids1 = (res1.json.data.jobs as any[]).map((j) => j.id);
      const ids2 = (res2.json.data.jobs as any[]).map((j) => j.id);
      const overlap = ids1.filter((id) => ids2.includes(id));

      assert.equal(overlap.length, 0);
      assert.equal(new Set([...ids1, ...ids2]).size, 6);
    });

    it('moves expired DISPATCHING lease to UNCERTAIN (never retried/refunded) while lost-ACK device can still reconcile later', async () => {
      const deviceSvc = new DeviceService('lease-recovery');
      const dev = await enrollTestDevice(deviceSvc, orgAId, adminAId);
      const jobSvc = new OutboundSmsJobService();

      const { job } = await jobSvc.enqueueJob(orgAId, {
        to: '+255754888111',
        content: 'Uncertain lease recovery test',
        simSlot: 1,
      });

      const acquired = await jobSvc.acquireJobsForDevice(dev.deviceId, orgAId, { limit: 1 });
      const leaseToken = acquired.jobs[0]!.leaseToken!;
      await jobSvc.markDispatching(dev.deviceId, orgAId, job.id, { leaseToken, simSlot: 1 });

      // Simulate dispatch lease timeout
      await sql`
        UPDATE "outbound_sms_jobs"
        SET "lease_expires_at" = NOW() - INTERVAL '30 seconds'
        WHERE "id" = ${job.id}::uuid
      `;

      const sweepRes = await withTransaction((tx) => jobSvc.sweepStaleJobs(tx, orgAId));
      assert.equal(sweepRes.expiredToUncertain, 1);

      const afterSweep = await jobSvc.getJobById(orgAId, job.id);
      assert.equal(afterSweep.status, OutboundSmsJobStatus.UNCERTAIN);
      // Credit must NOT be refunded because SMS may have already reached handset
      assert.equal(await messagingService.getCreditBalance(orgAId), 49);

      // Re-acquiring must NOT hand out UNCERTAIN jobs
      const reacquire = await jobSvc.acquireJobsForDevice(dev.deviceId, orgAId, { limit: 5 });
      assert.equal(reacquire.jobs.length, 0);

      // Device wakes up with its persisted radio result -> resolves UNCERTAIN -> DELIVERED
      const lateResult = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${job.id}/result`,
        { Authorization: `Bearer ${dev.deviceToken}` },
        { leaseToken, outcome: 'DELIVERED', simSlot: 1 },
      );
      assert.equal(lateResult.statusCode, 200);
      assert.equal(lateResult.json.data.job.status, OutboundSmsJobStatus.DELIVERED);
    });

    it('re-queues expired pre-dispatch CLAIMED lease and refunds once when TTL expires before radio', async () => {
      const deviceSvc = new DeviceService('ttl-refund');
      const dev = await enrollTestDevice(deviceSvc, orgAId, adminAId);
      const jobSvc = new OutboundSmsJobService();

      const { job, message } = await jobSvc.enqueueJob(orgAId, {
        to: '+255784000222',
        content: 'TTL expiry refund test',
        simSlot: 1,
      });

      await jobSvc.acquireJobsForDevice(dev.deviceId, orgAId, { limit: 1 });

      // Expire lease before /dispatching -> should become QUEUED again on next acquire
      await sql`
        UPDATE "outbound_sms_jobs"
        SET "lease_expires_at" = NOW() - INTERVAL '10 seconds'
        WHERE "id" = ${job.id}::uuid
      `;
      const reacquired = await jobSvc.acquireJobsForDevice(dev.deviceId, orgAId, { limit: 1 });
      assert.equal(reacquired.jobs.length, 1);
      assert.equal(reacquired.jobs[0]!.attemptCount, 2);

      // Now expire total job TTL before radio dispatch -> sweeper must mark EXPIRED & issue ONE refund
      await sql`
        UPDATE "outbound_sms_jobs"
        SET "created_at" = NOW() - INTERVAL '20 seconds',
            "expires_at" = NOW() - INTERVAL '10 seconds'
        WHERE "id" = ${job.id}::uuid
      `;
      const sweep = await withTransaction((tx) => jobSvc.sweepStaleJobs(tx, orgAId));
      assert.equal(sweep.expiredBeforeDispatch, 1);
      assert.equal(await messagingService.getCreditBalance(orgAId), 50);

      const expiredJob = await jobSvc.getJobById(orgAId, job.id);
      assert.equal(expiredJob.status, OutboundSmsJobStatus.EXPIRED);
      const msgRows = await sql<Record<string, any>>`SELECT "status" FROM "sms_messages" WHERE "id" = ${message.id}::uuid`;
      assert.equal(msgRows[0]!.status, SmsStatus.FAILED);

      // Re-sweeping does not issue a duplicate refund
      await withTransaction((tx) => jobSvc.sweepStaleJobs(tx, orgAId));
      assert.equal(await messagingService.getCreditBalance(orgAId), 50);
    });

    it('refunds exactly once on preRadioFailure and rejects cancel after DISPATCHING', async () => {
      const deviceSvc = new DeviceService('preradio-cancel');
      const dev = await enrollTestDevice(deviceSvc, orgAId, adminAId);

      // Job 1: pre-radio failure before SmsManager -> single refund
      const job1Res = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs',
        { Authorization: `Bearer ${adminAJwt}` },
        { to: '+255754111222', content: 'Pre-radio check', deviceId: dev.deviceId },
      );
      const job1Id = job1Res.json.data.job.id;
      const acq1 = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs/acquire',
        { Authorization: `Bearer ${dev.deviceToken}` },
        { limit: 1 },
      );
      const lease1 = acq1.json.data.jobs[0].leaseToken;

      const preFail = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${job1Id}/result`,
        { Authorization: `Bearer ${dev.deviceToken}` },
        {
          leaseToken: lease1,
          outcome: 'FAILED',
          preRadioFailure: true,
          failureCode: 'NO_ACTIVE_SIM',
          errorMessage: 'No active SIM slot available',
        },
      );
      assert.equal(preFail.statusCode, 200);
      assert.equal(preFail.json.data.job.status, OutboundSmsJobStatus.FAILED);
      assert.equal(await messagingService.getCreditBalance(orgAId), 50);

      // Job 2: Enqueue & cancel before acquire -> single refund
      const job2Res = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs',
        { Authorization: `Bearer ${adminAJwt}` },
        { to: '+255754111333', content: 'Cancel me cleanly', deviceId: dev.deviceId },
      );
      const job2Id = job2Res.json.data.job.id;
      assert.equal(await messagingService.getCreditBalance(orgAId), 49);
      const cancelRes = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${job2Id}/cancel`,
        { Authorization: `Bearer ${adminAJwt}` },
        { reason: 'Operator aborted' },
      );
      assert.equal(cancelRes.statusCode, 200);
      assert.equal(cancelRes.json.data.job.status, OutboundSmsJobStatus.CANCELLED);
      assert.equal(await messagingService.getCreditBalance(orgAId), 50);

      const refundEntries = await sql<Record<string, any>>`
        SELECT "id" FROM "messaging_credit_ledger"
        WHERE "organization_id" = ${orgAId}::uuid AND "entry_type" = ${CreditLedgerEntryType.REFUND}::"CreditLedgerEntryType"
      `;
      assert.equal(refundEntries.length, 2);
    });
  });

  describe('3. Tenant Isolation, Device Revocation & Inactive Relay Fail-Closed', () => {
    it('blocks cross-organization access, revoked devices, and disabled relay accounts', async () => {
      const deviceSvc = new DeviceService('security-isolation');
      const devA = await enrollTestDevice(deviceSvc, orgAId, adminAId, 'Org A Relay');
      const devB = await enrollTestDevice(deviceSvc, orgBId, adminBId, 'Org B Relay');

      const createA = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs',
        { Authorization: `Bearer ${adminAJwt}` },
        { to: '+255754222333', content: 'Confidential Org A OTP', deviceId: devA.deviceId },
      );
      const jobAId = createA.json.data.job.id;

      // Org B admin cannot inspect or cancel Org A job
      const crossInspect = await makeHttpRequest(
        'GET',
        `/v1/messaging/device-jobs/${jobAId}`,
        { Authorization: `Bearer ${adminBJwt}` },
      );
      assert.equal(crossInspect.statusCode, 403);
      assert.equal(crossInspect.json.error.code, 'CROSS_ORGANIZATION_FORBIDDEN');

      // Org B device never receives Org A jobs
      const acqB = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs/acquire',
        { Authorization: `Bearer ${devB.deviceToken}` },
        { limit: 10 },
      );
      assert.equal(acqB.statusCode, 200);
      assert.equal(acqB.json.data.jobs.length, 0);

      // Org A acquires, then Org B tries to call /dispatching on Org A's job -> 403 CROSS_ORGANIZATION_FORBIDDEN
      const acqA = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs/acquire',
        { Authorization: `Bearer ${devA.deviceToken}` },
        { limit: 1 },
      );
      const leaseA = acqA.json.data.jobs[0].leaseToken;

      const crossDispatch = await makeHttpRequest(
        'POST',
        `/v1/messaging/device-jobs/${jobAId}/dispatching`,
        { Authorization: `Bearer ${devB.deviceToken}` },
        { leaseToken: leaseA },
      );
      assert.equal(crossDispatch.statusCode, 403);

      // Revoking Device A immediately blocks further job acquisition
      await sql`
        UPDATE "devices" SET "status" = ${DeviceStatus.REVOKED}::"DeviceStatus"
        WHERE "id" = ${devA.deviceId}::uuid
      `;
      const revokedAcq = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs/acquire',
        { Authorization: `Bearer ${devA.deviceToken}` },
        { limit: 1 },
      );
      assert.equal(revokedAcq.statusCode, 403);

      // Deactivating Org B messaging account causes relayEnabled=false and blocks new enqueues
      await sql`
        UPDATE "messaging_accounts" SET "is_active" = false WHERE "organization_id" = ${orgBId}::uuid
      `;
      const inactiveAcq = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs/acquire',
        { Authorization: `Bearer ${devB.deviceToken}` },
        { limit: 1 },
      );
      assert.equal(inactiveAcq.statusCode, 200);
      assert.equal(inactiveAcq.json.data.relayEnabled, false);
      assert.equal(inactiveAcq.json.data.jobs.length, 0);

      const blockedEnqueue = await makeHttpRequest(
        'POST',
        '/v1/messaging/device-jobs',
        { Authorization: `Bearer ${adminBJwt}` },
        { to: '+255754999000', content: 'Should fail' },
      );
      assert.equal(blockedEnqueue.statusCode, 403);
    });
  });
});
