import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ApiKeyScope, DeviceIngestionMode, DeviceStatus } from '@brisksms/shared';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { ApiKeyService } from '../src/modules/developer/api-key.service.js';
import { grantDeveloperPlan } from './helpers/developer-plan.js';

const ADMIN_KEY = 'super_secret_platform_key_32bytes!';

describe('Platform tenant directory and kill switches', () => {
  const router = createApp();
  const apiKeyService = new ApiKeyService();
  const previousSecret = process.env.PLATFORM_ADMIN_SECRET;
  let adminToken: string;
  let customerToken: string;
  let customerOrgId: string;
  let otherOrgId: string;
  let deviceId: string;
  let secret: string;
  let keyId: string;

  async function call(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<{ statusCode: number; json: any }> {
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = path;
    for (const [k, v] of Object.entries(headers)) req.headers[k.toLowerCase()] = v;
    const res = new ServerResponse(req);
    let captured = '';
    let statusCode = 200;
    res.setHeader = () => res;
    res.writeHead = (code: number) => {
      statusCode = code;
      return res;
    };
    res.end = (chunk?: any) => {
      if (chunk) captured += chunk.toString();
      return res;
    };
    if (body !== undefined) req.push(JSON.stringify(body));
    req.push(null);
    await router.handle(req, res);
    return { statusCode, json: captured ? JSON.parse(captured) : null };
  }

  const admin = () => ({
    Authorization: `Bearer ${adminToken}`,
    'X-Platform-Admin-Key': ADMIN_KEY,
    'Content-Type': 'application/json',
  });
  const customer = () => ({ Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/json' });
  const org = (suffix = '') => `/v1/admin/organizations/${customerOrgId}${suffix}`;

  beforeEach(async () => {
    process.env.PLATFORM_ADMIN_SECRET = ADMIN_KEY;
    await dbStore.reset();
    const staff = await authService.register({
      email: 'staff@brisksms.app', password: 'Password123!', fullName: 'Staff', organizationName: 'BriskSMS Staff',
    });
    adminToken = staff.tokens.accessToken;
    const cust = await authService.register({
      email: 'owner@kariakoo-mart.co.tz', password: 'Password123!', fullName: 'Kariakoo Owner', organizationName: 'Kariakoo Mart',
    });
    customerToken = cust.tokens.accessToken;
    customerOrgId = cust.organizationId!;
    const other = await authService.register({
      email: 'owner@other-shop.co.tz', password: 'Password123!', fullName: 'Other Owner', organizationName: 'Other Shop',
    });
    otherOrgId = other.organizationId!;

    await grantDeveloperPlan(customerOrgId);
    const created = await apiKeyService.createApiKey(customerOrgId, {
      organizationId: customerOrgId, name: 'Zapier key', scopes: [ApiKeyScope.SMS_SEND],
    });
    secret = created.plainTextSecret;
    const device = await dbStore.registerDevice({
      organizationId: customerOrgId, label: 'Shop phone', deviceModel: 'Pixel 7', manufacturer: 'Google',
      androidVersion: '14', appVersion: '1.0.0', publicKeyPem: 'pem', ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
      tokenHash: 'hash-' + randomUUID(), status: DeviceStatus.ACTIVE,
    });
    deviceId = device.id;
    const detail = await call('GET', org(), admin());
    keyId = detail.json.data.apiKeys[0].id;
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.PLATFORM_ADMIN_SECRET;
    else process.env.PLATFORM_ADMIN_SECRET = previousSecret;
  });

  it('refuses every directory and kill switch route without the platform admin key', async () => {
    const plain = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    for (const [method, path] of [
      ['GET', '/v1/admin/organizations'],
      ['GET', org()],
      ['POST', org('/suspend')],
      ['POST', org('/reactivate')],
      ['POST', org(`/api-keys/${keyId}/revoke`)],
      ['POST', org(`/devices/${deviceId}/quarantine`)],
      ['POST', org(`/devices/${deviceId}/release`)],
      ['POST', org(`/devices/${deviceId}/revoke`)],
    ] as const) {
      const res = await call(method, path, plain, method === 'POST' ? { reason: 'testing access' } : undefined);
      assert.equal(res.statusCode, 403, `${method} ${path}`);
    }
  });

  it('searches by workspace name and by member email, and filters by status', async () => {
    const byName = await call('GET', '/v1/admin/organizations?q=kariakoo', admin());
    assert.deepEqual(byName.json.data.merchants.map((m: any) => m.name), ['Kariakoo Mart']);
    const byEmail = await call('GET', '/v1/admin/organizations?q=other-shop', admin());
    assert.deepEqual(byEmail.json.data.merchants.map((m: any) => m.id), [otherOrgId]);
    const suspended = await call('GET', '/v1/admin/organizations?status=suspended', admin());
    assert.equal(suspended.json.data.total, 0);
  });

  it('shows members, devices, plan, API keys without secrets, and recent activity', async () => {
    const res = await call('GET', org(), admin());
    const d = res.json.data;
    assert.equal(d.merchant.ownerEmail, 'owner@kariakoo-mart.co.tz');
    assert.equal(d.devices.length, 1);
    assert.equal(d.apiKeys.length, 1);
    assert.equal(d.apiKeys[0].label, 'Zapier key');
    assert.ok(!JSON.stringify(d).includes(secret), 'the key secret is never returned');
    assert.ok(!('keyHash' in d.apiKeys[0]) && !('key_hash' in d.apiKeys[0]));
    assert.ok(Array.isArray(d.recentActivity));
  });

  it('needs a reason, then suspends and restores the workspace', async () => {
    const noReason = await call('POST', org('/suspend'), admin(), {});
    assert.equal(noReason.statusCode, 400);

    assert.equal((await call('GET', '/v1/devices', customer())).statusCode, 200);
    const suspend = await call('POST', org('/suspend'), admin(), { reason: 'Carrier complaint 4412' });
    assert.equal(suspend.statusCode, 200);
    assert.equal(suspend.json.data.merchant.isActive, false);

    const blocked = await call('GET', '/v1/devices', customer());
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json.error.code, 'ORGANIZATION_SUSPENDED');
    assert.equal((await call('POST', org('/suspend'), admin(), { reason: 'again please' })).statusCode, 409);

    assert.equal((await call('POST', org('/reactivate'), admin(), { reason: 'Resolved with carrier' })).statusCode, 200);
    assert.equal((await call('GET', '/v1/devices', customer())).statusCode, 200);
  });

  it('revokes an API key at once, once only, and only inside its own workspace', async () => {
    assert.ok(await apiKeyService.validateApiKey(secret));
    const wrongOrg = await call('POST', `/v1/admin/organizations/${otherOrgId}/api-keys/${keyId}/revoke`, admin(), { reason: 'wrong workspace' });
    assert.equal(wrongOrg.statusCode, 404);
    assert.ok(await apiKeyService.validateApiKey(secret), 'still valid after the wrong-workspace attempt');

    const ok = await call('POST', org(`/api-keys/${keyId}/revoke`), admin(), { reason: 'Key leaked on GitHub' });
    assert.equal(ok.statusCode, 200);
    assert.equal(await apiKeyService.validateApiKey(secret), null);
    assert.equal((await call('POST', org(`/api-keys/${keyId}/revoke`), admin(), { reason: 'Key leaked on GitHub' })).statusCode, 409);
  });

  it('quarantines and releases a device, and refuses wrong states', async () => {
    assert.equal((await call('POST', org(`/devices/${deviceId}/release`), admin(), { reason: 'not held yet' })).statusCode, 409);

    const q = await call('POST', org(`/devices/${deviceId}/quarantine`), admin(), { reason: 'Sending spam to invalid numbers' });
    assert.equal(q.statusCode, 200);
    assert.equal((await dbStore.getDeviceById(deviceId, customerOrgId))!.status, DeviceStatus.QUARANTINED);
    assert.equal((await call('POST', org(`/devices/${deviceId}/quarantine`), admin(), { reason: 'twice in a row' })).statusCode, 409);

    const r = await call('POST', org(`/devices/${deviceId}/release`), admin(), { reason: 'Cleared after review' });
    assert.equal(r.statusCode, 200);
    assert.equal((await dbStore.getDeviceById(deviceId, customerOrgId))!.status, DeviceStatus.ACTIVE);
  });

  it('records every kill switch in the platform audit log with the reason and target workspace', async () => {
    await call('POST', org('/suspend'), admin(), { reason: 'Carrier complaint 4412' });
    await call('POST', org(`/api-keys/${keyId}/revoke`), admin(), { reason: 'Key leaked on GitHub' });
    await call('POST', org(`/devices/${deviceId}/quarantine`), admin(), { reason: 'Spam to invalid numbers' });

    const { json } = await call('GET', '/v1/admin/audit?limit=20', admin());
    const byAction = Object.fromEntries(json.data.entries.map((e: any) => [e.action, e]));
    for (const action of ['ORGANIZATION_SUSPENDED', 'API_KEY_REVOKED', 'DEVICE_QUARANTINED']) {
      assert.ok(byAction[action], action);
      assert.equal(byAction[action].targetOrganizationId, customerOrgId);
    }
    assert.equal(byAction.API_KEY_REVOKED.reason, 'Key leaked on GitHub');
  });

  it('rejects ids that are not ids', async () => {
    assert.equal((await call('GET', '/v1/admin/organizations/not-an-id', admin())).statusCode, 400);
  });
});
