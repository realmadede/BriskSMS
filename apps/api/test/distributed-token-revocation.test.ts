import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import { Router } from '../src/core/http.js';
import { dbStore } from '../src/core/store.js';
import {
  sql,
  redisClient,
  setSimulatedRedisOutage,
  setSimulatedDatabaseOutage,
  recordWorkerHeartbeat,
  QUEUE_NAMES,
} from '@brisksms/db';
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from '../src/core/cookies.js';
import {
  tokenBlacklist,
  setRevocationSyncReady,
} from '../src/core/guards.js';

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  setCookies: string[];
  json: any;
}

async function makeRequest(
  router: Router,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Record<string, unknown>,
): Promise<HttpResponse> {
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

  const rawSetCookie = res.getHeader('set-cookie');
  const setCookies: string[] = Array.isArray(rawSetCookie)
    ? (rawSetCookie as string[])
    : rawSetCookie
      ? [String(rawSetCookie)]
      : [];

  let parsed: any = null;
  try {
    parsed = capturedBody ? JSON.parse(capturedBody) : null;
  } catch {
    parsed = capturedBody;
  }

  return {
    statusCode,
    headers: res.getHeaders() as Record<string, string | string[] | undefined>,
    setCookies,
    json: parsed,
  };
}

describe('Distributed Access-Token Revocation Consistency Suite', () => {
  beforeEach(async () => {
    setSimulatedRedisOutage(false);
    setSimulatedDatabaseOutage(false);
    await dbStore.reset();
    try {
      await redisClient.flushdb();
    } catch {
      // ignore
    }
    tokenBlacklist.clear();
    setRevocationSyncReady(false);
  });

  afterEach(() => {
    setSimulatedRedisOutage(false);
    setSimulatedDatabaseOutage(false);
  });

  it('1. Two independent API instances share authentication state and accept valid tokens', async () => {
    const instanceA = createApp({ tokenBlacklist: new Set<string>() });
    const instanceB = createApp({ tokenBlacklist: new Set<string>() });

    // Register user on Instance A
    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'user1@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'User One',
      organizationName: 'Brisk Enterprises',
    });
    assert.equal(regRes.statusCode, 201);
    const accessToken = regRes.json.data.tokens.accessToken;
    assert.ok(accessToken);

    // Instance A authenticates user
    const meA = await makeRequest(instanceA, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${accessToken}`,
    });
    assert.equal(meA.statusCode, 200);
    assert.equal(meA.json.data.user.email, 'user1@brisksms.co.tz');

    // Instance B (separate in-memory replica) authenticates same user with same token
    const meB = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${accessToken}`,
    });
    assert.equal(meB.statusCode, 200);
    assert.equal(meB.json.data.user.email, 'user1@brisksms.co.tz');
  });

  it('2. Instance A revokes family via logout -> Instance B immediately rejects access token via shared Redis lookup', async () => {
    const blacklistA = new Set<string>();
    const blacklistB = new Set<string>();
    const instanceA = createApp({ tokenBlacklist: blacklistA });
    const instanceB = createApp({ tokenBlacklist: blacklistB });

    // Register on Instance A
    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'logout_target@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Logout User',
      organizationName: 'Brisk Org',
    });
    const accessToken = regRes.json.data.tokens.accessToken;
    const refreshToken = regRes.json.data.tokens.refreshToken;
    const csrfToken = regRes.json.data.csrfToken;

    // Both instances accept token before logout
    const preA = await makeRequest(instanceA, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${accessToken}`,
    });
    assert.equal(preA.statusCode, 200);

    const preB = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${accessToken}`,
    });
    assert.equal(preB.statusCode, 200);

    // Clear Instance B's local in-memory cache so it must rely on shared Redis lookup
    blacklistB.clear();

    // Instance A processes explicit logout
    const logoutRes = await makeRequest(
      instanceA,
      'POST',
      '/v1/auth/logout',
      {
        Authorization: `Bearer ${accessToken}`,
        'x-csrf-token': csrfToken,
        Cookie: `${SESSION_COOKIE_NAME}=${accessToken}; ${REFRESH_COOKIE_NAME}=${refreshToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
      },
      { refreshToken },
    );
    assert.equal(logoutRes.statusCode, 200);

    // Instance A immediately rejects the access token
    const postA = await makeRequest(instanceA, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${accessToken}`,
    });
    assert.equal(postA.statusCode, 401);
    assert.equal(postA.json.error.code, 'TOKEN_REVOKED');

    // Instance B (with empty in-memory blacklist) MUST reject the access token via shared Redis lookup
    assert.equal(blacklistB.size, 0, 'Instance B memory blacklist must be empty before lookup');
    const postB = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${accessToken}`,
    });
    assert.equal(postB.statusCode, 401);
    assert.equal(postB.json.error.code, 'TOKEN_REVOKED');

    // Instance B should have cached the JTI in its local blacklist after discovery
    assert.ok(blacklistB.size > 0, 'Instance B must cache discovered revoked JTI');
  });

  it('3. Instance A revokes family via refresh replay -> Instance B immediately rejects active descendant access token A3', async () => {
    const blacklistA = new Set<string>();
    const blacklistB = new Set<string>();
    const instanceA = createApp({ tokenBlacklist: blacklistA });
    const instanceB = createApp({ tokenBlacklist: blacklistB });

    // Step 1: Register -> Generates (T1, A1)
    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'replay_victim@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Replay Victim',
      organizationName: 'Brisk Org',
    });
    const t1 = regRes.json.data.tokens.refreshToken;
    const a1 = regRes.json.data.tokens.accessToken;

    // Step 2: Rotate T1 -> Generates (T2, A2)
    const rot1 = await makeRequest(instanceA, 'POST', '/v1/auth/refresh', {}, { refreshToken: t1 });
    assert.equal(rot1.statusCode, 200);
    const t2 = rot1.json.data.refreshToken;

    // Step 3: Rotate T2 -> Generates (T3, A3)
    const rot2 = await makeRequest(instanceA, 'POST', '/v1/auth/refresh', {}, { refreshToken: t2 });
    assert.equal(rot2.statusCode, 200);
    const a3 = rot2.json.data.accessToken;

    // Before replay: A3 is valid on Instance B
    const preCheckB = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${a3}`,
    });
    assert.equal(preCheckB.statusCode, 200);

    // Clear Instance B's local in-memory cache to ensure test exercises shared distributed store
    blacklistB.clear();

    // Step 4: Attacker replays consumed T1 on Instance A
    const replayRes = await makeRequest(instanceA, 'POST', '/v1/auth/refresh', {}, { refreshToken: t1 });
    assert.equal(replayRes.statusCode, 401);
    assert.match(replayRes.json.error.message, /entire session family revoked/);

    // Step 5: Instance B MUST immediately reject active access token A3
    assert.equal(blacklistB.size, 0, 'Instance B local blacklist was reset');
    const postCheckB = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${a3}`,
    });
    assert.equal(postCheckB.statusCode, 401);
    assert.equal(postCheckB.json.error.code, 'TOKEN_REVOKED');

    // Instance B also rejects A1
    const postCheckA1 = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${a1}`,
    });
    assert.equal(postCheckA1.statusCode, 401);
    assert.equal(postCheckA1.json.error.code, 'TOKEN_REVOKED');
  });

  it('4. Unrelated token family remains completely unaffected across both instances', async () => {
    const blacklistA = new Set<string>();
    const blacklistB = new Set<string>();
    const instanceA = createApp({ tokenBlacklist: blacklistA });
    const instanceB = createApp({ tokenBlacklist: blacklistB });

    // Family 1 (User 1)
    const u1 = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'user_comp@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Compromised User',
      organizationName: 'Org 1',
    });
    const token1 = u1.json.data.tokens.accessToken;
    const refresh1 = u1.json.data.tokens.refreshToken;

    // Family 2 (User 2)
    const u2 = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'user_safe@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Safe User',
      organizationName: 'Org 2',
    });
    const token2 = u2.json.data.tokens.accessToken;

    // Revoke Family 1 on Instance A
    await makeRequest(
      instanceA,
      'POST',
      '/v1/auth/logout',
      {
        Authorization: `Bearer ${token1}`,
        'x-csrf-token': u1.json.data.csrfToken,
        Cookie: `${SESSION_COOKIE_NAME}=${token1}; ${REFRESH_COOKIE_NAME}=${refresh1}; ${CSRF_COOKIE_NAME}=${u1.json.data.csrfToken}`,
      },
      { refreshToken: refresh1 },
    );

    // Family 1 is revoked on both instances
    const resA1 = await makeRequest(instanceA, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${token1}`,
    });
    assert.equal(resA1.statusCode, 401);

    const resB1 = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${token1}`,
    });
    assert.equal(resB1.statusCode, 401);

    // Family 2 remains completely VALID on BOTH instances
    const resA2 = await makeRequest(instanceA, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${token2}`,
    });
    assert.equal(resA2.statusCode, 200);
    assert.equal(resA2.json.data.user.email, 'user_safe@brisksms.co.tz');

    const resB2 = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${token2}`,
    });
    assert.equal(resB2.statusCode, 200);
    assert.equal(resB2.json.data.user.email, 'user_safe@brisksms.co.tz');
  });

  it('5. Replica with cold memory cache relies on shared Redis lookup without pub/sub', async () => {
    const blacklistA = new Set<string>();
    const instanceA = createApp({ tokenBlacklist: blacklistA });

    // Register on Instance A
    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'cold_replica@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Cold User',
      organizationName: 'Brisk Org',
    });
    const accessToken = regRes.json.data.tokens.accessToken;
    const refreshToken = regRes.json.data.tokens.refreshToken;

    // Revoke via logout on Instance A
    await makeRequest(
      instanceA,
      'POST',
      '/v1/auth/logout',
      {
        Authorization: `Bearer ${accessToken}`,
        'x-csrf-token': regRes.json.data.csrfToken,
        Cookie: `${SESSION_COOKIE_NAME}=${accessToken}; ${REFRESH_COOKIE_NAME}=${refreshToken}; ${CSRF_COOKIE_NAME}=${regRes.json.data.csrfToken}`,
      },
      { refreshToken },
    );

    // Spin up a brand new third replica that never received any broadcast event
    const instanceC = createApp({ tokenBlacklist: new Set<string>() });
    const coldRes = await makeRequest(instanceC, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${accessToken}`,
    });
    assert.equal(coldRes.statusCode, 401);
    assert.equal(coldRes.json.error.code, 'TOKEN_REVOKED');
  });

  it('6. Redis becomes unavailable during protected-request authentication: falls back to PostgreSQL durable store', async () => {
    const blacklistA = new Set<string>();
    const blacklistB = new Set<string>();
    const instanceA = createApp({ tokenBlacklist: blacklistA });
    const instanceB = createApp({ tokenBlacklist: blacklistB });

    // Register user
    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'redis_outage_user@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Outage User',
      organizationName: 'Brisk Org',
    });
    const revokedToken = regRes.json.data.tokens.accessToken;
    const refreshToken = regRes.json.data.tokens.refreshToken;

    // Register second valid user
    const regRes2 = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'valid_survivor@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Valid Survivor',
      organizationName: 'Brisk Org 2',
    });
    const validToken = regRes2.json.data.tokens.accessToken;

    // Revoke user 1
    await makeRequest(
      instanceA,
      'POST',
      '/v1/auth/logout',
      {
        Authorization: `Bearer ${revokedToken}`,
        'x-csrf-token': regRes.json.data.csrfToken,
        Cookie: `${SESSION_COOKIE_NAME}=${revokedToken}; ${REFRESH_COOKIE_NAME}=${refreshToken}; ${CSRF_COOKIE_NAME}=${regRes.json.data.csrfToken}`,
      },
      { refreshToken },
    );

    // Clear Instance B's local cache
    blacklistB.clear();

    // Simulate complete Redis outage
    setSimulatedRedisOutage(true);
    try {
      // 1. Instance B falls back to PostgreSQL and successfully rejects revoked token
      const checkRevoked = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
        Authorization: `Bearer ${revokedToken}`,
      });
      assert.equal(checkRevoked.statusCode, 401);
      assert.equal(checkRevoked.json.error.code, 'TOKEN_REVOKED');

      // 2. Instance B falls back to PostgreSQL and successfully validates unrevoked token
      const checkValid = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
        Authorization: `Bearer ${validToken}`,
      });
      assert.equal(checkValid.statusCode, 200);
      assert.equal(checkValid.json.data.user.email, 'valid_survivor@brisksms.co.tz');
    } finally {
      setSimulatedRedisOutage(false);
    }
  });

  it('7. Fail-closed behavior: when both Redis and PostgreSQL fail during authentication fallback, request fails closed (503)', async () => {
    const blacklistB = new Set<string>();
    const instanceB = createApp({ tokenBlacklist: blacklistB });

    const regRes = await makeRequest(instanceB, 'POST', '/v1/auth/register', {}, {
      email: 'fail_closed@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Fail Closed',
      organizationName: 'Brisk Org',
    });
    const token = regRes.json.data.tokens.accessToken;

    blacklistB.clear();

    // Simultaneously simulate outage in BOTH Redis and PostgreSQL
    setSimulatedRedisOutage(true);
    setSimulatedDatabaseOutage(true);
    try {
      const response = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
        Authorization: `Bearer ${token}`,
      });
      // MUST NOT be 200 OK. Must fail closed with 503 Service Unavailable.
      assert.equal(response.statusCode, 503);
      assert.equal(response.json.success, false);
      assert.equal(response.json.error.code, 'DATABASE_UNAVAILABLE');
    } finally {
      setSimulatedRedisOutage(false);
      setSimulatedDatabaseOutage(false);
    }
  });

  it('8. PostgreSQL unavailable during revocation: revocation fails closed and does not falsely claim success', async () => {
    const instanceA = createApp({ tokenBlacklist: new Set<string>() });

    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'db_down_revoke@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'DB Down',
      organizationName: 'Brisk Org',
    });
    const token = regRes.json.data.tokens.accessToken;
    const refreshToken = regRes.json.data.tokens.refreshToken;

    // Simulate DB outage during logout
    setSimulatedDatabaseOutage(true);
    try {
      const logoutRes = await makeRequest(
        instanceA,
        'POST',
        '/v1/auth/logout',
        {
          Authorization: `Bearer ${token}`,
          'x-csrf-token': regRes.json.data.csrfToken,
          Cookie: `${SESSION_COOKIE_NAME}=${token}; ${REFRESH_COOKIE_NAME}=${refreshToken}; ${CSRF_COOKIE_NAME}=${regRes.json.data.csrfToken}`,
        },
        { refreshToken },
      );
      // DB failure during durable write must fail with 503, never claiming clean revocation success
      assert.equal(logoutRes.statusCode, 503);
    } finally {
      setSimulatedDatabaseOutage(false);
    }
  });

  it('9. Redis restarts and loses volatile revocation entries: self-healing recovery from PostgreSQL', async () => {
    const blacklistA = new Set<string>();
    const blacklistB = new Set<string>();
    const instanceA = createApp({ tokenBlacklist: blacklistA });
    const instanceB = createApp({ tokenBlacklist: blacklistB });

    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'redis_restart@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Restart User',
      organizationName: 'Brisk Org',
    });
    const token = regRes.json.data.tokens.accessToken;
    const refreshToken = regRes.json.data.tokens.refreshToken;

    // Revoke on Instance A
    await makeRequest(
      instanceA,
      'POST',
      '/v1/auth/logout',
      {
        Authorization: `Bearer ${token}`,
        'x-csrf-token': regRes.json.data.csrfToken,
        Cookie: `${SESSION_COOKIE_NAME}=${token}; ${REFRESH_COOKIE_NAME}=${refreshToken}; ${CSRF_COOKIE_NAME}=${regRes.json.data.csrfToken}`,
      },
      { refreshToken },
    );

    // Simulate Redis restart / volatile data wipe
    await redisClient.flushdb();
    blacklistB.clear();

    // Instance B receives request. Because Redis was flushed (sync marker missing),
    // Instance B detects cold Redis, recovers state from PostgreSQL, and rejects token.
    const checkB = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(checkB.statusCode, 401);
    assert.equal(checkB.json.error.code, 'TOKEN_REVOKED');

    // Confirm that Redis was healed and repopulated with the revocation key
    const rows = await sql<{ jti: string }>`SELECT "jti" FROM "revoked_sessions" LIMIT 1`;
    const jti = rows[0]?.jti;
    assert.ok(jti);
    const cachedVal = await redisClient.get(`auth:revoked_jti:${jti}`);
    assert.equal(cachedVal, '1', 'Redis must be healed with revoked JTI');
  });

  it('10. Newly started replica cannot serve authenticated requests before required synchronization', async () => {
    // Revoke a session in PostgreSQL
    const dummyJti = '00000000-0000-0000-0000-000000009999';
    await sql`
      INSERT INTO "revoked_sessions" ("jti", "user_id", "expires_at", "revoked_at")
      VALUES (${dummyJti}, NULL, NOW() + INTERVAL '1 day', NOW())
    `;

    // Start a new replica with DB down
    setSimulatedDatabaseOutage(true);
    try {
      const coldReplica = createApp({ tokenBlacklist: new Set<string>() });

      // Readiness probe reports 503 DOWN when DB is unavailable
      const readyRes = await makeRequest(coldReplica, 'GET', '/v1/health/ready');
      assert.equal(readyRes.statusCode, 503);
      assert.equal(readyRes.json.data.status, 'DOWN');
    } finally {
      setSimulatedDatabaseOutage(false);
    }

    // When DB is UP, new replica synchronizes and readiness is established
    const healthyReplica = createApp({ tokenBlacklist: new Set<string>() });
    const readyRes2 = await makeRequest(healthyReplica, 'GET', '/v1/health/ready');
    assert.equal(readyRes2.statusCode, 200);
    assert.equal(readyRes2.json.data.status, 'UP');
    assert.equal(readyRes2.json.data.revocationSync, 'UP');
  });

  it('11. Logout and refresh replay both propagate family-wide revocation across all descendants', async () => {
    const blacklistA = new Set<string>();
    const blacklistB = new Set<string>();
    const instanceA = createApp({ tokenBlacklist: blacklistA });
    const instanceB = createApp({ tokenBlacklist: blacklistB });

    // Create chain T1 -> T2 -> T3, A1, A2, A3
    const regRes = await makeRequest(instanceA, 'POST', '/v1/auth/register', {}, {
      email: 'chain_test@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Chain User',
      organizationName: 'Brisk Org',
    });
    const t1 = regRes.json.data.tokens.refreshToken;
    const a1 = regRes.json.data.tokens.accessToken;

    const rot1 = await makeRequest(instanceA, 'POST', '/v1/auth/refresh', {}, { refreshToken: t1 });
    const t2 = rot1.json.data.refreshToken;
    const a2 = rot1.json.data.accessToken;

    const rot2 = await makeRequest(instanceA, 'POST', '/v1/auth/refresh', {}, { refreshToken: t2 });
    const t3 = rot2.json.data.refreshToken;
    const a3 = rot2.json.data.accessToken;

    blacklistB.clear();

    // Replay T2 on Instance A
    const replayRes = await makeRequest(instanceA, 'POST', '/v1/auth/refresh', {}, { refreshToken: t2 });
    assert.equal(replayRes.statusCode, 401);

    // All access tokens in the family (A1, A2, A3) are rejected on Instance B
    for (const token of [a1, a2, a3]) {
      const res = await makeRequest(instanceB, 'GET', '/v1/auth/me', {
        Authorization: `Bearer ${token}`,
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error.code, 'TOKEN_REVOKED');
    }

    // Refresh token T3 is rejected on both instances
    const refA = await makeRequest(instanceA, 'POST', '/v1/auth/refresh', {}, { refreshToken: t3 });
    assert.equal(refA.statusCode, 401);

    const refB = await makeRequest(instanceB, 'POST', '/v1/auth/refresh', {}, { refreshToken: t3 });
    assert.equal(refB.statusCode, 401);
  });

  it('12. Existing single-instance behavior and backward compatibility remain fully intact', async () => {
    // Default createApp() without arguments uses default global tokenBlacklist
    const defaultApp = createApp();
    const regRes = await makeRequest(defaultApp, 'POST', '/v1/auth/register', {}, {
      email: 'default_compat@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Compat User',
      organizationName: 'Brisk Org',
    });
    assert.equal(regRes.statusCode, 201);
    const token = regRes.json.data.tokens.accessToken;

    const meRes = await makeRequest(defaultApp, 'GET', '/v1/auth/me', {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(meRes.statusCode, 200);

    await recordWorkerHeartbeat('worker_test_1', [QUEUE_NAMES.WEBHOOK_DELIVERY]);
    const healthRes = await makeRequest(defaultApp, 'GET', '/v1/health');
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.json.data.status, 'UP');
    assert.equal(healthRes.json.data.dependencies.revocationSync.status, 'UP');
  });
});
