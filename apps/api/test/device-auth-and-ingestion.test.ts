import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { DeviceIngestionMode, UserRole } from '@brisksms/shared';
import { deviceService } from '../src/modules/device/device.service.js';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.js';
import { sql } from '@brisksms/db';

describe('Milestone 2: Backend Device Authentication & Evidence Ingestion Endpoint', () => {
  const router = createApp();

  let orgAId: string;
  let orgBId: string;
  let userAId: string;
  let deviceAId: string;
  let deviceAToken: string;

  beforeEach(async () => {
    await dbStore.reset();

    // 1. Setup Organization A
    const orgA = await dbStore.seedOrganizationDirect({
      id: randomUUID(),
      name: 'Vodacom Merchant A',
      slug: `voda-a-${randomUUID().slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
    });
    orgAId = orgA.id;

    // 2. Setup Organization B (for cross-tenant tests)
    const orgB = await dbStore.seedOrganizationDirect({
      id: randomUUID(),
      name: 'Airtel Merchant B',
      slug: `airtel-b-${randomUUID().slice(0, 8)}`,
      countryCode: 'TZA',
      timezone: 'Africa/Dar_es_Salaam',
      planTier: 'ENTERPRISE',
      isActive: true,
    });
    orgBId = orgB.id;

    // 3. Setup User A
    const userA = await dbStore.createUser({
      email: 'merchant-a@brisksms.co.tz',
      passwordHash: 'scrypt:salt:hash',
      fullName: 'Merchant Admin A',
    });
    userAId = userA.id;

    await dbStore.addMember({
      organizationId: orgAId,
      userId: userAId,
      role: UserRole.OWNER,
      actorId: userAId,
    });

    // 4. Pair Device A under Organization A
    const pairingRes = await deviceService.createPairingToken(orgAId, userAId);
    const pairResult = await deviceService.pairDevice({
      enrollmentToken: pairingRes.pairingToken,
      label: 'Samsung Galaxy A15 Relay',
      deviceModel: 'SM-A155F',
      manufacturer: 'Samsung',
      androidVersion: '14',
      appVersion: '1.0.0',
      publicKeyPem: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0',
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
    });

    deviceAId = pairResult.deviceId;
    deviceAToken = pairResult.deviceToken;
  });

  async function makeRequest(
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
      parsed = capturedBody;
    }
    return { statusCode, json: parsed };
  }

  describe('1. Device Authentication Guard', () => {
    it('authenticates valid device token and grants access', async () => {
      const res = await makeRequest(
        'POST',
        `/v1/devices/${deviceAId}/telemetry`,
        { Authorization: `Bearer ${deviceAToken}` },
        { batteryPercentage: 88, isCharging: true, networkType: 'WIFI' },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.success, true);
    });

    it('rejects missing Authorization header with 401', async () => {
      const res = await makeRequest(
        'POST',
        `/v1/devices/${deviceAId}/telemetry`,
        {},
        { batteryPercentage: 88, isCharging: true, networkType: 'WIFI' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects malformed Authorization header with 401', async () => {
      const res = await makeRequest(
        'POST',
        `/v1/devices/${deviceAId}/telemetry`,
        { Authorization: 'Basic user:password' },
        { batteryPercentage: 88, isCharging: true, networkType: 'WIFI' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.error?.code, 'UNAUTHORIZED');
    });

    it('rejects invalid or unknown device token with 401', async () => {
      const res = await makeRequest(
        'POST',
        `/v1/devices/${deviceAId}/telemetry`,
        { Authorization: 'Bearer bsk_dev_00000000000000000000000000000000' },
        { batteryPercentage: 88, isCharging: true, networkType: 'WIFI' },
      );

      assert.equal(res.statusCode, 401);
      assert.equal(res.json?.error?.code, 'INVALID_DEVICE_TOKEN');
    });

    it('rejects revoked device with 403 DEVICE_REVOKED', async () => {
      await deviceService.revokeDevice(deviceAId, orgAId, userAId);

      const res = await makeRequest(
        'POST',
        `/v1/devices/${deviceAId}/telemetry`,
        { Authorization: `Bearer ${deviceAToken}` },
        { batteryPercentage: 50, isCharging: false, networkType: 'LTE' },
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'DEVICE_REVOKED');
    });
  });

  describe('2. Evidence Ingestion HTTP Endpoint (POST /v1/ingestion/evidence)', () => {
    it('ingests authorized M-Pesa payment notification and acknowledges with OBSERVED status', async () => {
      const payload = {
        senderAddress: 'M-PESA',
        rawPayload: 'QA99XYZ123 Imethibitishwa. Umepokea Tsh 45,000 kutoka kwa Juma Ali 255754123456 tarehe 05/11/2026 saa 14:30.',
        simSlot: 1,
        deviceTimestamp: new Date('2026-11-05T14:30:00Z').toISOString(),
        signature: 'ecdsa_sig_base64_sample',
      };

      const res = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        { Authorization: `Bearer ${deviceAToken}` },
        payload,
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.data?.acknowledged, true);
      assert.equal(res.json?.data?.status, 'OBSERVED');
      assert.ok(res.json?.data?.evidenceId);
      assert.ok(res.json?.data?.deduplicationHash);
    });

    it('handles duplicate evidence submissions idempotently', async () => {
      const payload = {
        senderAddress: 'M-PESA',
        rawPayload: 'DUP9912000 Imethibitishwa. Umepokea Tsh 20,000 kutoka kwa Mary 255754000111 tarehe 05/11/2026.',
        simSlot: 1,
        deviceTimestamp: new Date('2026-11-05T10:00:00Z').toISOString(),
      };

      // First submission
      const firstRes = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        { Authorization: `Bearer ${deviceAToken}` },
        payload,
      );
      assert.equal(firstRes.statusCode, 200);
      assert.equal(firstRes.json?.data?.status, 'OBSERVED');

      // Duplicate submission
      const dupRes = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        { Authorization: `Bearer ${deviceAToken}` },
        payload,
      );
      assert.equal(dupRes.statusCode, 200);
      assert.equal(dupRes.json?.data?.acknowledged, true);
      assert.equal(dupRes.json?.data?.status, 'DUPLICATE');
      assert.equal(dupRes.json?.data?.deduplicationHash, firstRes.json?.data?.deduplicationHash);
    });

    it('forbids cross-organization evidence forwarding claim', async () => {
      const payload = {
        organizationId: orgBId, // Claiming Org B while authenticated as Device of Org A
        senderAddress: 'M-PESA',
        rawPayload: 'FORGE99123 Imethibitishwa. Umepokea Tsh 10,000.',
        simSlot: 1,
        deviceTimestamp: new Date().toISOString(),
      };

      const res = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        { Authorization: `Bearer ${deviceAToken}` },
        payload,
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'CROSS_ORGANIZATION_FORBIDDEN');
    });

    it('forbids cross-device spoofing claim', async () => {
      const payload = {
        deviceId: randomUUID(), // Spoofing different device ID
        senderAddress: 'M-PESA',
        rawPayload: 'FORGE99124 Imethibitishwa. Umepokea Tsh 10,000.',
        simSlot: 1,
        deviceTimestamp: new Date().toISOString(),
      };

      const res = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        { Authorization: `Bearer ${deviceAToken}` },
        payload,
      );

      assert.equal(res.statusCode, 403);
      assert.equal(res.json?.error?.code, 'CROSS_DEVICE_FORBIDDEN');
    });

    it('rejects oversized rawPayload exceeding 4096 characters', async () => {
      const hugePayload = 'A'.repeat(5000);
      const res = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        { Authorization: `Bearer ${deviceAToken}` },
        {
          senderAddress: 'M-PESA',
          rawPayload: hugePayload,
          deviceTimestamp: new Date().toISOString(),
        },
      );

      assert.equal(res.statusCode, 400);
      assert.equal(res.json?.error?.code, 'PAYLOAD_TOO_LARGE');
    });

    it('CRITICAL FINANCIAL INVARIANT: Notification ingestion NEVER marks an invoice as PAID or payment as VERIFIED', async () => {
      const recon = new ReconciliationService();
      const invoice = await recon.createInvoice(orgAId, {
        referenceNumber: 'QA99FIN99',
        totalAmountCents: 5000000n, // 50,000 TZS
      });

      // Android ingests matching payment evidence
      const res = await makeRequest(
        'POST',
        '/v1/ingestion/evidence',
        { Authorization: `Bearer ${deviceAToken}` },
        {
          senderAddress: 'M-PESA',
          rawPayload: 'QA99FIN99 Imethibitishwa. Umepokea Tsh 50,000 kutoka kwa John 255754111222 tarehe 05/11/2026.',
          simSlot: 1,
          deviceTimestamp: new Date().toISOString(),
        },
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json?.data?.status, 'OBSERVED');

      // Verify invoice state in PostgreSQL is still UNPAID and paid_amount_cents is 0
      const invRows = await sql<Record<string, any>>`
        SELECT * FROM "invoices" WHERE "id" = ${invoice.id} AND "organization_id" = ${orgAId} LIMIT 1
      `;
      assert.equal(invRows[0]?.status, 'UNPAID', 'Invoice must NOT be automatically marked PAID');
      assert.equal(Number(invRows[0]?.paid_amount_cents), 0, 'Invoice balance must NOT be automatically settled without independent verification');
    });
  });
});
