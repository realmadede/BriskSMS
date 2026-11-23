import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { sql } from '@brisksms/db';
import { FeatureKey } from '@brisksms/shared';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { authService } from '../src/modules/auth/auth.service.js';

const ADMIN_KEY = 'super_secret_platform_key_32bytes!';

describe('Platform admin actions leave an append-only audit trail', () => {
  const router = createApp();
  const previousSecret = process.env.PLATFORM_ADMIN_SECRET;
  let token: string;
  let userId: string;
  let orgId: string;

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
    Authorization: `Bearer ${token}`,
    'X-Platform-Admin-Key': ADMIN_KEY,
    'Content-Type': 'application/json',
  });

  beforeEach(async () => {
    process.env.PLATFORM_ADMIN_SECRET = ADMIN_KEY;
    await dbStore.reset();
    const reg = await authService.register({
      email: 'ops@brisksms.app',
      password: 'Password123!',
      fullName: 'Ops Admin',
      organizationName: 'BriskSMS Billing',
    });
    token = reg.tokens.accessToken;
    userId = reg.user.id;
    orgId = reg.organizationId!;
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.PLATFORM_ADMIN_SECRET;
    else process.env.PLATFORM_ADMIN_SECRET = previousSecret;
  });

  it('refuses the audit list without the platform admin key', async () => {
    const res = await call('GET', '/v1/admin/audit', { Authorization: `Bearer ${token}` });
    assert.equal(res.statusCode, 403);
  });

  it('records who changed the billing workspace, with the reason and the before and after', async () => {
    const put = await call('PUT', '/v1/admin/billing-workspace', admin(), {
      organizationId: orgId,
      reason: 'Receiving numbers for subscriptions',
    });
    assert.equal(put.statusCode, 200);

    const list = await call('GET', '/v1/admin/audit', admin());
    assert.equal(list.statusCode, 200);
    const entry = list.json.data.entries.find((e: any) => e.action === 'BILLING_WORKSPACE_SET');
    assert.ok(entry);
    assert.equal(entry.adminUserId, userId);
    assert.equal(entry.targetOrganizationId, orgId);
    assert.equal(entry.reason, 'Receiving numbers for subscriptions');
    assert.deepEqual(entry.previousState, { organizationId: null });
    assert.deepEqual(entry.newState, { organizationId: orgId });
  });

  it('records feature default changes and filters by action', async () => {
    const put = await call('PUT', `/v1/admin/catalog/features/${FeatureKey.HISTORICAL_DATA_MONTHS}`, admin(), {
      defaultValue: '7',
    });
    assert.equal(put.statusCode, 200);
    await call('PUT', '/v1/admin/billing-workspace', admin(), { organizationId: orgId });

    const only = await call('GET', '/v1/admin/audit?action=FEATURE_DEFAULT_CHANGED', admin());
    assert.equal(only.json.data.entries.length, 1);
    assert.equal(only.json.data.entries[0].targetId, FeatureKey.HISTORICAL_DATA_MONTHS);
    assert.equal(only.json.data.entries[0].newState.defaultValue, '7');
  });

  it('cannot be edited or deleted, even by the application connection', async () => {
    await call('PUT', '/v1/admin/billing-workspace', admin(), { organizationId: orgId });
    await assert.rejects(sql`UPDATE "platform_audit_logs" SET "action" = 'X'`, /append-only|IMMUTABLE/i);
    await assert.rejects(sql`DELETE FROM "platform_audit_logs"`, /append-only|IMMUTABLE/i);
  });
});
