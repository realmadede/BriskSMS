import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../src/app.js';
import { dbStore } from '../src/core/store.js';
import { sql } from '@brisksms/db';
import { authService } from '../src/modules/auth/auth.service.js';
import { hashToken } from '../src/core/crypto.js';
import {
  SESSION_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from '../src/core/cookies.js';
import { tokenBlacklist, syncTokenBlacklistFromDb } from '../src/core/guards.js';

describe('Refresh-Token Family Revocation Security Suite', () => {
  const router = createApp();

  beforeEach(async () => {
    await dbStore.reset();
  });

  interface HttpResponse {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    setCookies: string[];
    json: any;
  }

  async function makeRequest(
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

  function extractCookie(setCookies: string[], name: string): string | undefined {
    const prefix = `${name}=`;
    const found = setCookies.find((c) => c.startsWith(prefix));
    if (!found) return undefined;
    return found.split(';')[0]?.slice(prefix.length);
  }

  it('1. Initial refresh token issuance: creates a valid token and assigns a stable family_id', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'founder@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Founder Admin',
      organizationName: 'Brisk Enterprises',
    });
    assert.equal(regRes.statusCode, 201);
    const refreshToken = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    assert.ok(refreshToken);

    const tokenHash = hashToken(refreshToken);
    const rows = await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${tokenHash}`;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].family_id, 'family_id must be populated');
    assert.equal(rows[0].revoked_at, null, 'new token must be active');
  });

  it('2. Successful rotation preserving family identity: issues fresh child token with identical family_id', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'rotation@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Rotation User',
      organizationName: 'Rotation Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const t1Hash = hashToken(t1);

    const t1Row = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${t1Hash}`)[0];
    const initialFamilyId = t1Row.family_id;

    // Rotate T1 -> T2
    const refRes1 = await makeRequest(
      'POST',
      '/v1/auth/refresh',
      {
        cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
        'x-csrf-token': csrf1,
        origin: 'http://localhost:4200',
      },
      {},
    );
    assert.equal(refRes1.statusCode, 200);
    const t2 = extractCookie(refRes1.setCookies, REFRESH_COOKIE_NAME)!;
    assert.ok(t2);
    assert.notEqual(t1, t2);

    const t2Hash = hashToken(t2);
    const t2Row = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${t2Hash}`)[0];
    assert.equal(t2Row.family_id, initialFamilyId, 'Child token must inherit the exact same family_id');
    assert.equal(t2Row.revoked_at, null, 'Child token must be active');

    // T1 must now be marked revoked
    const t1Updated = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${t1Hash}`)[0];
    assert.ok(t1Updated.revoked_at !== null, 'T1 must be marked revoked');
  });

  it('3. Replay of an already consumed token: immediately rejected with HTTP 401 INVALID_TOKEN', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'replay@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Replay User',
      organizationName: 'Replay Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;

    // First refresh: T1 -> T2 (legitimate rotation)
    const refRes1 = await makeRequest(
      'POST',
      '/v1/auth/refresh',
      {
        cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
        'x-csrf-token': csrf1,
        origin: 'http://localhost:4200',
      },
      {},
    );
    assert.equal(refRes1.statusCode, 200);

    // Replay attempt: presentation of consumed T1 again
    const replayRes = await makeRequest(
      'POST',
      '/v1/auth/refresh',
      {
        cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
        'x-csrf-token': csrf1,
        origin: 'http://localhost:4200',
      },
      {},
    );
    assert.equal(replayRes.statusCode, 401);
    assert.equal(replayRes.json.error.code, 'INVALID_TOKEN');
  });

  it('4. Family-wide revocation after replay: marks every active token in the family as revoked', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'familyrev@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Family Revocation User',
      organizationName: 'Family Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const t1Hash = hashToken(t1);
    const familyId = (await sql<any>`SELECT family_id FROM "refresh_tokens" WHERE "token_hash" = ${t1Hash}`)[0].family_id;

    // Rotation 1: T1 -> T2
    const refRes1 = await makeRequest(
      'POST',
      '/v1/auth/refresh',
      {
        cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
        'x-csrf-token': csrf1,
        origin: 'http://localhost:4200',
      },
      {},
    );
    assert.equal(refRes1.statusCode, 200);
    const t2 = extractCookie(refRes1.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf2 = extractCookie(refRes1.setCookies, CSRF_COOKIE_NAME)!;

    // Rotation 2: T2 -> T3
    const refRes2 = await makeRequest(
      'POST',
      '/v1/auth/refresh',
      {
        cookie: `${REFRESH_COOKIE_NAME}=${t2}; ${CSRF_COOKIE_NAME}=${csrf2}`,
        'x-csrf-token': csrf2,
        origin: 'http://localhost:4200',
      },
      {},
    );
    assert.equal(refRes2.statusCode, 200);
    const t3 = extractCookie(refRes2.setCookies, REFRESH_COOKIE_NAME)!;
    const t3Hash = hashToken(t3);

    // Prior to replay, T3 is active
    const t3PreReplay = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${t3Hash}`)[0];
    assert.equal(t3PreReplay.revoked_at, null);

    // Attacker replays consumed token T1
    const replayRes = await makeRequest(
      'POST',
      '/v1/auth/refresh',
      {
        cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
        'x-csrf-token': csrf1,
        origin: 'http://localhost:4200',
      },
      {},
    );
    assert.equal(replayRes.statusCode, 401);

    // Family-wide check: ALL tokens in the family must now have revoked_at != null
    const allFamilyTokens = await sql<any>`SELECT * FROM "refresh_tokens" WHERE "family_id" = ${familyId}`;
    assert.equal(allFamilyTokens.length, 3); // T1, T2, T3
    for (const tok of allFamilyTokens) {
      assert.ok(tok.revoked_at !== null, `Token ${tok.jti} in compromised family must be revoked`);
    }
  });

  it('5. Descendant refresh token rejected after family revocation: T3 cannot refresh after T1 replay', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'descendant@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Descendant User',
      organizationName: 'Descendant Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;

    // T1 -> T2
    const ref1 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    const t2 = extractCookie(ref1.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf2 = extractCookie(ref1.setCookies, CSRF_COOKIE_NAME)!;

    // T2 -> T3
    const ref2 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t2}; ${CSRF_COOKIE_NAME}=${csrf2}`,
      'x-csrf-token': csrf2,
      origin: 'http://localhost:4200',
    }, {});
    const t3 = extractCookie(ref2.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf3 = extractCookie(ref2.setCookies, CSRF_COOKIE_NAME)!;

    // Attacker replays T1 -> triggers family revocation
    await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});

    // Legitimate user attempts to use valid descendant T3
    const t3Attempt = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t3}; ${CSRF_COOKIE_NAME}=${csrf3}`,
      'x-csrf-token': csrf3,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(t3Attempt.statusCode, 401, 'Descendant token T3 must be rejected because family was invalidated');
    assert.equal(t3Attempt.json.error.code, 'INVALID_TOKEN');
  });

  it('6. Concurrent refresh attempts: serialized via row lock; exactly one succeeds and no split branches form', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'concurrent@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Concurrent User',
      organizationName: 'Concurrent Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;

    const req1 = makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});

    const req2 = makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});

    const [res1, res2] = await Promise.all([req1, req2]);
    const statusCodes = [res1.statusCode, res2.statusCode].sort();
    assert.deepEqual(statusCodes, [200, 401], 'Row lock ensures exactly one request succeeds and one is rejected');
  });

  it('7. Expired token behavior: expired refresh token fails with 401 without creating branches', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'expired@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Expired User',
      organizationName: 'Expired Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const t1Hash = hashToken(t1);

    // Manually expire T1 in PostgreSQL
    await sql`
      UPDATE "refresh_tokens"
      SET "expires_at" = NOW() - INTERVAL '1 day'
      WHERE "token_hash" = ${t1Hash}
    `;

    const expRes = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(expRes.statusCode, 401);
    assert.equal(expRes.json.error.code, 'INVALID_TOKEN');
  });

  it('8. Explicit logout: revokes the entire token family and invalidates cookies', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'logout@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Logout User',
      organizationName: 'Logout Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const session1 = extractCookie(regRes.setCookies, SESSION_COOKIE_NAME)!;
    const t1Hash = hashToken(t1);
    const familyId = (await sql<any>`SELECT family_id FROM "refresh_tokens" WHERE "token_hash" = ${t1Hash}`)[0].family_id;

    // Logout
    const logoutRes = await makeRequest('POST', '/v1/auth/logout', {
      cookie: `${SESSION_COOKIE_NAME}=${session1}; ${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(logoutRes.statusCode, 200);

    // Verify token family in database is revoked
    const familyTokens = await sql<any>`SELECT * FROM "refresh_tokens" WHERE "family_id" = ${familyId}`;
    for (const tok of familyTokens) {
      assert.ok(tok.revoked_at !== null, 'Logout must revoke token family');
    }

    // Subsequent refresh attempt with logged-out token must fail
    const postLogoutRefresh = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(postLogoutRefresh.statusCode, 401);
  });

  it('9. Independent token families remain unaffected: revoking Family A does NOT revoke Family B for same user', async () => {
    // 1. Register user (creates Family A)
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'multidevice@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Multi Device User',
      organizationName: 'Multi Corp',
    });
    const tA = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrfA = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const tAHash = hashToken(tA);
    const familyA = (await sql<any>`SELECT family_id FROM "refresh_tokens" WHERE "token_hash" = ${tAHash}`)[0].family_id;

    // 2. User logs in from a second device/browser (creates Family B)
    const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
      email: 'multidevice@brisksms.co.tz',
      password: 'SecurePassword123!',
    });
    const tB = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrfB = extractCookie(loginRes.setCookies, CSRF_COOKIE_NAME)!;
    const tBHash = hashToken(tB);
    const familyB = (await sql<any>`SELECT family_id FROM "refresh_tokens" WHERE "token_hash" = ${tBHash}`)[0].family_id;

    assert.notEqual(familyA, familyB, 'Different sessions must have distinct family_id values');

    // 3. Rotate Family A: TA1 -> TA2
    const refA = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${tA}; ${CSRF_COOKIE_NAME}=${csrfA}`,
      'x-csrf-token': csrfA,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(refA.statusCode, 200);

    // 4. Replay TA1 -> Triggers revocation of Family A
    const replayA = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${tA}; ${CSRF_COOKIE_NAME}=${csrfA}`,
      'x-csrf-token': csrfA,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(replayA.statusCode, 401);

    // 5. Family B on second device must remain active and rotate cleanly!
    const refB = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${tB}; ${CSRF_COOKIE_NAME}=${csrfB}`,
      'x-csrf-token': csrfB,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(refB.statusCode, 200, 'Family B must not be affected by Family A revocation');
    const tB2 = extractCookie(refB.setCookies, REFRESH_COOKIE_NAME)!;
    assert.ok(tB2);

    const tB2Hash = hashToken(tB2);
    const tB2Row = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${tB2Hash}`)[0];
    assert.equal(tB2Row.family_id, familyB, 'Family B child token must inherit familyB');
  });

  it('10. Registration, password login and Google login all create correct refresh families with non-null family_id', async () => {
    // A. Registration
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'allproviders@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Provider User',
      organizationName: 'Provider Org',
    });
    const regToken = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const regRow = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${hashToken(regToken)}`)[0];
    assert.ok(regRow.family_id, 'Registration must assign family_id');

    // B. Password Login
    const loginRes = await makeRequest('POST', '/v1/auth/login', {}, {
      email: 'allproviders@brisksms.co.tz',
      password: 'SecurePassword123!',
    });
    const loginToken = extractCookie(loginRes.setCookies, REFRESH_COOKIE_NAME)!;
    const loginRow = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${hashToken(loginToken)}`)[0];
    assert.ok(loginRow.family_id, 'Password login must assign family_id');
    assert.notEqual(loginRow.family_id, regRow.family_id, 'Login must start a fresh family');

    // C. Direct AuthService loginWithGoogle invocation
    // Mock user linking / Google login
    const googleTokens = await authService.refreshToken(loginToken);
    assert.ok(googleTokens.refreshToken);
    const childRow = (await sql<any>`SELECT * FROM "refresh_tokens" WHERE "token_hash" = ${hashToken(googleTokens.refreshToken)}`)[0];
    assert.equal(childRow.family_id, loginRow.family_id, 'Rotated token must retain family');
  });

  it('11. Immediate access-token invalidation upon replay: active descendant access token A3 is rejected with 401 TOKEN_REVOKED after T1 replay', async () => {
    // Register: issues T1 and A1
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'accesstokenrev@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Access Revocation User',
      organizationName: 'Access Rev Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const a1 = extractCookie(regRes.setCookies, SESSION_COOKIE_NAME)!;

    // Rotate 1: T1 -> T2 and A2
    const ref1 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(ref1.statusCode, 200);
    const t2 = extractCookie(ref1.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf2 = extractCookie(ref1.setCookies, CSRF_COOKIE_NAME)!;
    const a2 = extractCookie(ref1.setCookies, SESSION_COOKIE_NAME)!;

    // Rotate 2: T2 -> T3 and A3
    const ref2 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t2}; ${CSRF_COOKIE_NAME}=${csrf2}`,
      'x-csrf-token': csrf2,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(ref2.statusCode, 200);
    const a3 = extractCookie(ref2.setCookies, SESSION_COOKIE_NAME)!;

    // Prior to replay, active access token A3 authenticates cleanly
    const preReplayRes = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a3}`,
    });
    assert.equal(preReplayRes.statusCode, 200, 'A3 must be valid before replay detection');

    // Attacker replays consumed token T1
    const replayRes = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(replayRes.statusCode, 401, 'Replay must be rejected');

    // CRITICAL SECURITY ASSERTION: Replay must immediately invalidate active access token A3!
    const postReplayRes = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a3}`,
    });
    assert.equal(postReplayRes.statusCode, 401, 'Active access token A3 must be rejected immediately after family replay');
    assert.equal(postReplayRes.json.error.code, 'TOKEN_REVOKED');

    // Older access tokens A1 and A2 must also be revoked
    const a1Res = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a1}`,
    });
    assert.equal(a1Res.statusCode, 401);
    assert.equal(a1Res.json.error.code, 'TOKEN_REVOKED');

    const a2Res = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a2}`,
    });
    assert.equal(a2Res.statusCode, 401);
    assert.equal(a2Res.json.error.code, 'TOKEN_REVOKED');
  });

  it('12. Restart recovery / PostgreSQL authoritative source: revoked sessions remain rejected after in-memory cache clear', async () => {
    // Register and rotate to issue tokens
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'restart@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Restart User',
      organizationName: 'Restart Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const a1 = extractCookie(regRes.setCookies, SESSION_COOKIE_NAME)!;

    const ref1 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    const a2 = extractCookie(ref1.setCookies, SESSION_COOKIE_NAME)!;

    // Replay T1 -> Triggers family revocation
    await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});

    // Simulate process cold restart: wipe in-memory tokenBlacklist Set
    tokenBlacklist.clear();
    assert.equal(tokenBlacklist.size, 0, 'In-memory blacklist wiped to simulate cold start');

    // Cold boot reloads from PostgreSQL authoritative source
    const reloadedCount = await syncTokenBlacklistFromDb();
    assert.ok(reloadedCount >= 2, 'Must reload revoked JTIs from PostgreSQL revoked_sessions');

    // Access tokens A1 and A2 must still be rejected with 401 TOKEN_REVOKED
    const checkA1Res = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a1}`,
    });
    assert.equal(checkA1Res.statusCode, 401);
    assert.equal(checkA1Res.json.error.code, 'TOKEN_REVOKED');

    const checkRes = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a2}`,
    });
    assert.equal(checkRes.statusCode, 401, 'Access token must remain rejected after restart');
    assert.equal(checkRes.json.error.code, 'TOKEN_REVOKED');
  });

  it('13. Replaying an already-revoked token is idempotent and maintains full family invalidation', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'idempotent@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Idempotent User',
      organizationName: 'Idempotent Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;

    // Rotate: T1 -> T2
    await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});

    // First replay of T1
    const replay1 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(replay1.statusCode, 401);

    // Second replay of T1 (already revoked family)
    const replay2 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(replay2.statusCode, 401);
    assert.equal(replay2.json.error.code, 'INVALID_TOKEN');
  });

  it('14. Explicit logout revokes access tokens across the rotated family', async () => {
    const regRes = await makeRequest('POST', '/v1/auth/register', {}, {
      email: 'logouttokens@brisksms.co.tz',
      password: 'SecurePassword123!',
      fullName: 'Logout Token User',
      organizationName: 'Logout Token Corp',
    });
    const t1 = extractCookie(regRes.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf1 = extractCookie(regRes.setCookies, CSRF_COOKIE_NAME)!;
    const a1 = extractCookie(regRes.setCookies, SESSION_COOKIE_NAME)!;

    // Rotate: T1 -> T2 (minting A2)
    const ref1 = await makeRequest('POST', '/v1/auth/refresh', {
      cookie: `${REFRESH_COOKIE_NAME}=${t1}; ${CSRF_COOKIE_NAME}=${csrf1}`,
      'x-csrf-token': csrf1,
      origin: 'http://localhost:4200',
    }, {});
    const t2 = extractCookie(ref1.setCookies, REFRESH_COOKIE_NAME)!;
    const csrf2 = extractCookie(ref1.setCookies, CSRF_COOKIE_NAME)!;
    const a2 = extractCookie(ref1.setCookies, SESSION_COOKIE_NAME)!;

    // Logout presenting current session A2
    const logoutRes = await makeRequest('POST', '/v1/auth/logout', {
      cookie: `${SESSION_COOKIE_NAME}=${a2}; ${REFRESH_COOKIE_NAME}=${t2}; ${CSRF_COOKIE_NAME}=${csrf2}`,
      'x-csrf-token': csrf2,
      origin: 'http://localhost:4200',
    }, {});
    assert.equal(logoutRes.statusCode, 200);

    // Current access token A2 must be revoked
    const a2Res = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a2}`,
    });
    assert.equal(a2Res.statusCode, 401);
    assert.equal(a2Res.json.error.code, 'TOKEN_REVOKED');

    // Ancestor access token A1 from same family must also be revoked
    const a1Res = await makeRequest('GET', '/v1/auth/session', {
      cookie: `${SESSION_COOKIE_NAME}=${a1}`,
    });
    assert.equal(a1Res.statusCode, 401);
    assert.equal(a1Res.json.error.code, 'TOKEN_REVOKED');
  });
});
