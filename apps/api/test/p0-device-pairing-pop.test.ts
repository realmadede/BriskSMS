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
import { DeviceService, resolvePairingChallengeTtlSeconds } from '../src/modules/device/device.service.js';
import {
  buildPairingChallengeTranscript,
  parseAndValidateDevicePublicKey,
  verifyDevicePairingSignature,
} from '../src/modules/device/device-crypto.js';
import { sql } from '@brisksms/db';
import { BillingInterval, DeviceIngestionMode } from '@brisksms/shared';

interface TestEcKeyPair {
  publicKeyPem: string;
  publicKeyBase64Der: string;
  spkiDer: Buffer;
  fingerprint: string;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

function generateTestP256KeyPair(): TestEcKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    publicKeyBase64Der: spkiDer.toString('base64'),
    spkiDer,
    fingerprint: createHash('sha256').update(spkiDer).digest('hex'),
    privateKey,
  };
}

function signChallenge(
  keys: TestEcKeyPair,
  enrollmentToken: string,
  challenge: {
    challengeId: string;
    enrollmentId: string;
    organizationId: string;
    keyAlgorithm: 'EC_P256';
    signatureAlgorithm: 'SHA256_ECDSA';
    challenge: string;
    expiresAt: string;
  },
): string {
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

  return cryptoSign('sha256', transcript, {
    key: keys.privateKey,
    dsaEncoding: 'der',
  }).toString('base64');
}

describe('P0: Android Device Pairing Proof-of-Possession & Adversarial Hardening', () => {
  const router = createApp();
  const authService = new AuthService();
  const subscriptionService = new SubscriptionService();
  const deviceService = new DeviceService();

  let orgAId: string;
  let adminAId: string;
  let orgBId: string;
  let adminBId: string;

  beforeEach(async () => {
    await dbStore.reset();
    delete process.env.PAIRING_CHALLENGE_TTL_SECONDS;

    const regA = await authService.register({
      email: `owner-a-${randomUUID().slice(0, 6)}@brisksms.co.tz`,
      password: 'StrongPassword123!',
      fullName: 'Owner A',
      organizationName: 'Org Alpha Co',
    });
    orgAId = regA.organizationId!;
    adminAId = regA.user.id;
    await subscriptionService.checkoutSubscription(orgAId, adminAId, {
      planCode: 'PLAN_ENTERPRISE',
      currency: 'TZS',
      billingInterval: BillingInterval.MONTHLY,
    });

    const regB = await authService.register({
      email: `owner-b-${randomUUID().slice(0, 6)}@brisksms.co.tz`,
      password: 'StrongPassword123!',
      fullName: 'Owner B',
      organizationName: 'Org Beta Co',
    });
    orgBId = regB.organizationId!;
    adminBId = regB.user.id;
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
    const parsed = capturedBody ? JSON.parse(capturedBody) : null;
    return { statusCode, json: parsed };
  }

  it('1. completes HTTP challenge-response PoP with Base64 SPKI DER or PEM without private key exposure', async () => {
    const tokenRes = await deviceService.createPairingToken(orgAId, adminAId);
    const keys = generateTestP256KeyPair();

    // Android Keystore exports Base64 SPKI DER (and/or canonical PEM)
    const chRes = await makeHttpRequest('POST', '/v1/devices/pairing-challenge', {}, {
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: keys.publicKeyBase64Der,
      organizationId: orgAId,
      keyAlgorithm: 'EC_P256',
      signatureAlgorithm: 'SHA256_ECDSA',
    });
    assert.equal(chRes.statusCode, 200);
    assert.equal(chRes.json?.success, true);
    const ch = chRes.json.data;
    assert.equal(ch.publicKeyFingerprint, keys.fingerprint);
    assert.equal(ch.organizationId, orgAId);
    assert.equal(ch.protocolVersion, 'BRISKSMS-DEVICE-PAIRING-POP-V1');

    const signature = signChallenge(keys, tokenRes.pairingToken, ch);

    const pairRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenRes.pairingToken,
      challengeId: ch.challengeId,
      enrollmentId: ch.enrollmentId,
      organizationId: ch.organizationId,
      challengeSignature: signature,
      publicKeyPem: keys.publicKeyBase64Der,
      deviceModel: 'Pixel 8',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
    });

    assert.equal(pairRes.statusCode, 200);
    assert.equal(pairRes.json?.success, true);
    const enrolled = pairRes.json.data;
    assert.ok(enrolled.deviceId);
    assert.ok(enrolled.deviceToken.startsWith('bsk_dev_'));
    assert.equal(enrolled.publicKeyFingerprint, keys.fingerprint);
    assert.equal(enrolled.keyAlgorithm, 'EC_P256');

    const storedDevice = await dbStore.getDeviceById(enrolled.deviceId, orgAId);
    assert.ok(storedDevice);
    assert.equal(storedDevice!.publicKeyPem, keys.publicKeyPem);
    assert.equal(storedDevice!.publicKeyFingerprint, keys.fingerprint);
    assert.equal(storedDevice!.keyAlgorithm, 'EC_P256');

    // Challenge & pairing token are atomically consumed
    const chRows = await sql`SELECT "status", "resulting_device_id", "consumed_at" FROM "device_pairing_challenges" WHERE "id" = ${ch.challengeId}`;
    assert.equal(chRows[0]?.status, 'CONSUMED');
    assert.equal(chRows[0]?.resulting_device_id, enrolled.deviceId);
    assert.ok(chRows[0]?.consumed_at);

    const tokenRows = await sql`SELECT "used_at", "used_by_device_id" FROM "pairing_tokens" WHERE "token" = ${tokenRes.pairingToken}`;
    assert.ok(tokenRows[0]?.used_at);
    assert.equal(tokenRows[0]?.used_by_device_id, enrolled.deviceId);

    // Auditable events exist
    const audits = await sql`SELECT "action" FROM "audit_logs" WHERE "organization_id" = ${orgAId}`;
    const actions = audits.map((r: any) => r.action);
    assert.ok(actions.includes('PAIRING_CHALLENGE_ISSUED'));
    assert.ok(actions.includes('DEVICE_PAIRING_POP_VERIFIED'));
  });

  it('2. blocks legacy/unauthenticated pairing-token theft without challenge and signature', async () => {
    const tokenRes = await deviceService.createPairingToken(orgAId, adminAId);
    const attackerKeys = generateTestP256KeyPair();

    // Attacker tries direct /v1/devices/pair with stolen token and no PoP challenge/sig
    const res = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: attackerKeys.publicKeyPem,
      deviceModel: 'Rogue Device',
      manufacturer: 'Unknown',
      androidVersion: '14',
      appVersion: '1.0.0',
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json?.error?.code, 'PROOF_OF_POSSESSION_REQUIRED');
    const devices = await sql`SELECT * FROM "devices" WHERE "organization_id" = ${orgAId}`;
    assert.equal(devices.length, 0);
  });

  it('3. rejects invalid signatures and signatures from a different private key while keeping zero partial devices', async () => {
    const tokenRes = await deviceService.createPairingToken(orgAId, adminAId);
    const victimKeys = generateTestP256KeyPair();
    const attackerKeys = generateTestP256KeyPair();

    // Wrong private key
    const ch1 = await deviceService.createPairingChallenge({
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: victimKeys.publicKeyPem,
    });
    const forgedSig = cryptoSign(
      'sha256',
      buildPairingChallengeTranscript({
        challengeId: ch1.challengeId,
        enrollmentId: ch1.enrollmentId,
        organizationId: ch1.organizationId,
        pairingTokenHash: hashToken(tokenRes.pairingToken),
        publicKeyFingerprint: victimKeys.fingerprint,
        keyAlgorithm: ch1.keyAlgorithm,
        signatureAlgorithm: ch1.signatureAlgorithm,
        challengeNonce: ch1.challenge,
        expiresAtIso: ch1.expiresAt,
      }),
      { key: attackerKeys.privateKey, dsaEncoding: 'der' },
    ).toString('base64');

    const badSigRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenRes.pairingToken,
      challengeId: ch1.challengeId,
      challengeSignature: forgedSig,
      publicKeyPem: victimKeys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(badSigRes.statusCode, 401);
    assert.equal(badSigRes.json?.error?.code, 'INVALID_CHALLENGE_SIGNATURE');

    // Challenge is marked REJECTED (cannot be reused even with valid key later)
    const ch1Rows = await sql`SELECT "status", "rejected_at" FROM "device_pairing_challenges" WHERE "id" = ${ch1.challengeId}`;
    assert.equal(ch1Rows[0]?.status, 'REJECTED');
    assert.ok(ch1Rows[0]?.rejected_at);

    const validSigForCh1 = signChallenge(victimKeys, tokenRes.pairingToken, ch1);
    const reuseRejectedRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenRes.pairingToken,
      challengeId: ch1.challengeId,
      challengeSignature: validSigForCh1,
      publicKeyPem: victimKeys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(reuseRejectedRes.statusCode, 401);
    assert.equal(reuseRejectedRes.json?.error?.code, 'INVALID_PAIRING_CHALLENGE');

    // Raw 64-byte P1363 non-DER or corrupted signature rejected cleanly
    const ch2 = await deviceService.createPairingChallenge({
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: victimKeys.publicKeyPem,
    });
    const p1363Sig = cryptoSign(
      'sha256',
      buildPairingChallengeTranscript({
        challengeId: ch2.challengeId,
        enrollmentId: ch2.enrollmentId,
        organizationId: ch2.organizationId,
        pairingTokenHash: hashToken(tokenRes.pairingToken),
        publicKeyFingerprint: victimKeys.fingerprint,
        keyAlgorithm: ch2.keyAlgorithm,
        signatureAlgorithm: ch2.signatureAlgorithm,
        challengeNonce: ch2.challenge,
        expiresAtIso: ch2.expiresAt,
      }),
      { key: victimKeys.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64');

    const badDerRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenRes.pairingToken,
      challengeId: ch2.challengeId,
      challengeSignature: p1363Sig,
      publicKeyPem: victimKeys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(badDerRes.statusCode, 401);
    assert.equal(badDerRes.json?.error?.code, 'INVALID_CHALLENGE_SIGNATURE');

    const devices = await sql`SELECT * FROM "devices" WHERE "organization_id" = ${orgAId}`;
    assert.equal(devices.length, 0);
  });

  it('4. blocks public-key substitution and cross-org / cross-token / cross-enrollment challenge substitution', async () => {
    const tokenA = await deviceService.createPairingToken(orgAId, adminAId);
    const tokenB = await deviceService.createPairingToken(orgBId, adminBId);
    const victimKeys = generateTestP256KeyPair();
    const attackerKeys = generateTestP256KeyPair();

    const chA = await deviceService.createPairingChallenge({
      enrollmentToken: tokenA.pairingToken,
      publicKeyPem: victimKeys.publicKeyPem,
    });
    const sigA = signChallenge(victimKeys, tokenA.pairingToken, chA);

    // A. Attacker substitutes their own public key when presenting chA
    const subKeyRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenA.pairingToken,
      challengeId: chA.challengeId,
      challengeSignature: sigA,
      publicKeyPem: attackerKeys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(subKeyRes.statusCode, 403);
    assert.equal(subKeyRes.json?.error?.code, 'PUBLIC_KEY_MISMATCH');

    // B. Fresh challenge for A: Org B steals challengeId A and submits with tokenB
    const chA2 = await deviceService.createPairingChallenge({
      enrollmentToken: tokenA.pairingToken,
      publicKeyPem: victimKeys.publicKeyPem,
    });
    const sigA2 = signChallenge(victimKeys, tokenA.pairingToken, chA2);

    const crossOrgRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenB.pairingToken,
      challengeId: chA2.challengeId,
      challengeSignature: sigA2,
      publicKeyPem: victimKeys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(crossOrgRes.statusCode, 403);
    assert.equal(crossOrgRes.json?.error?.code, 'CHALLENGE_BINDING_MISMATCH');

    // C. Mismatched enrollmentId
    const wrongEnrollRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenA.pairingToken,
      challengeId: chA2.challengeId,
      enrollmentId: randomUUID(),
      challengeSignature: sigA2,
      publicKeyPem: victimKeys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(wrongEnrollRes.statusCode, 403);
    assert.equal(wrongEnrollRes.json?.error?.code, 'CHALLENGE_BINDING_MISMATCH');

    // Legitimate enrollment of chA2 still succeeds cleanly because cross-org probing didn't corrupt chA2!
    const validRes = await deviceService.pairDevice({
      enrollmentToken: tokenA.pairingToken,
      challengeId: chA2.challengeId,
      challengeSignature: sigA2,
      publicKeyPem: victimKeys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(validRes.organizationId, orgAId);
  });

  it('5. rejects expired challenges, replays, and respects configurable TTL bounds', async () => {
    process.env.PAIRING_CHALLENGE_TTL_SECONDS = '45';
    assert.equal(resolvePairingChallengeTtlSeconds(), 45);

    const tokenRes = await deviceService.createPairingToken(orgAId, adminAId);
    const keys = generateTestP256KeyPair();
    const ch = await deviceService.createPairingChallenge({
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: keys.publicKeyPem,
    });
    const ttlDeltaSec = (new Date(ch.expiresAt).getTime() - new Date(ch.issuedAt).getTime()) / 1000;
    assert.ok(ttlDeltaSec >= 44 && ttlDeltaSec <= 45);

    // Expire challenge in database
    const pastExpiresAt = new Date(Date.now() - 10_000);
    await sql`
      UPDATE "device_pairing_challenges"
      SET "expires_at" = ${pastExpiresAt}
      WHERE "id" = ${ch.challengeId}
    `;
    const sigForExpired = signChallenge(keys, tokenRes.pairingToken, {
      ...ch,
      expiresAt: pastExpiresAt.toISOString(),
    });

    const expRes = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: tokenRes.pairingToken,
      challengeId: ch.challengeId,
      challengeSignature: sigForExpired,
      publicKeyPem: keys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(expRes.statusCode, 401);
    assert.equal(expRes.json?.error?.code, 'CHALLENGE_EXPIRED');

    const chStatusRows = await sql`SELECT "status" FROM "device_pairing_challenges" WHERE "id" = ${ch.challengeId}`;
    assert.equal(chStatusRows[0]?.status, 'EXPIRED');

    // Retry / Interrupted enrollment recovery: obtain fresh challenge with same still-valid token + keypair
    const freshCh = await deviceService.createPairingChallenge({
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: keys.publicKeyPem,
    });
    const freshSig = signChallenge(keys, tokenRes.pairingToken, freshCh);
    const okRes = await deviceService.pairDevice({
      enrollmentToken: tokenRes.pairingToken,
      challengeId: freshCh.challengeId,
      challengeSignature: freshSig,
      publicKeyPem: keys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.ok(okRes.deviceId);

    // Replaying exact consumed challenge + signature with even a second fresh pairing token must fail
    const token2 = await deviceService.createPairingToken(orgAId, adminAId);
    const replayWithToken2 = await makeHttpRequest('POST', '/v1/devices/pair', {}, {
      enrollmentToken: token2.pairingToken,
      challengeId: freshCh.challengeId,
      challengeSignature: freshSig,
      publicKeyPem: keys.publicKeyPem,
      deviceModel: 'Pixel',
      manufacturer: 'Google',
      androidVersion: '14',
      appVersion: '1.0.0',
    });
    assert.equal(replayWithToken2.statusCode, 403);
    assert.equal(replayWithToken2.json?.error?.code, 'CHALLENGE_BINDING_MISMATCH');
  });

  it('6. enforces PostgreSQL concurrency safety across racing enrollments and identical keys', async () => {
    // A. Same challenge & signature raced concurrently -> exactly 1 succeeds
    const token1 = await deviceService.createPairingToken(orgAId, adminAId);
    const keys1 = generateTestP256KeyPair();
    const ch1 = await deviceService.createPairingChallenge({
      enrollmentToken: token1.pairingToken,
      publicKeyPem: keys1.publicKeyPem,
    });
    const sig1 = signChallenge(keys1, token1.pairingToken, ch1);

    const sameChallengeRace = await Promise.allSettled([
      deviceService.pairDevice({
        enrollmentToken: token1.pairingToken,
        challengeId: ch1.challengeId,
        challengeSignature: sig1,
        publicKeyPem: keys1.publicKeyPem,
        deviceModel: 'Pixel',
        manufacturer: 'Google',
        androidVersion: '14',
        appVersion: '1.0.0',
      }),
      deviceService.pairDevice({
        enrollmentToken: token1.pairingToken,
        challengeId: ch1.challengeId,
        challengeSignature: sig1,
        publicKeyPem: keys1.publicKeyPem,
        deviceModel: 'Pixel',
        manufacturer: 'Google',
        androidVersion: '14',
        appVersion: '1.0.0',
      }),
    ]);

    assert.equal(sameChallengeRace.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(sameChallengeRace.filter((r) => r.status === 'rejected').length, 1);

    // B. Two valid challenges (different devices) racing for the SAME pairing token -> exactly 1 succeeds
    const token2 = await deviceService.createPairingToken(orgAId, adminAId);
    const keys2 = generateTestP256KeyPair();
    const keys3 = generateTestP256KeyPair();
    const ch2 = await deviceService.createPairingChallenge({
      enrollmentToken: token2.pairingToken,
      publicKeyPem: keys2.publicKeyPem,
    });
    const ch3 = await deviceService.createPairingChallenge({
      enrollmentToken: token2.pairingToken,
      publicKeyPem: keys3.publicKeyPem,
    });
    const sig2 = signChallenge(keys2, token2.pairingToken, ch2);
    const sig3 = signChallenge(keys3, token2.pairingToken, ch3);

    const tokenRace = await Promise.allSettled([
      deviceService.pairDevice({
        enrollmentToken: token2.pairingToken,
        challengeId: ch2.challengeId,
        challengeSignature: sig2,
        publicKeyPem: keys2.publicKeyPem,
        deviceModel: 'Device 2',
        manufacturer: 'Samsung',
        androidVersion: '14',
        appVersion: '1.0.0',
      }),
      deviceService.pairDevice({
        enrollmentToken: token2.pairingToken,
        challengeId: ch3.challengeId,
        challengeSignature: sig3,
        publicKeyPem: keys3.publicKeyPem,
        deviceModel: 'Device 3',
        manufacturer: 'Tecno',
        androidVersion: '14',
        appVersion: '1.0.0',
      }),
    ]);
    assert.equal(tokenRace.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(tokenRace.filter((r) => r.status === 'rejected').length, 1);

    // C. Two distinct tokens racing with the SAME public key -> exactly 1 succeeds
    const token3 = await deviceService.createPairingToken(orgAId, adminAId);
    const token4 = await deviceService.createPairingToken(orgAId, adminAId);
    const sharedKeys = generateTestP256KeyPair();
    const chShared1 = await deviceService.createPairingChallenge({
      enrollmentToken: token3.pairingToken,
      publicKeyPem: sharedKeys.publicKeyPem,
    });
    const chShared2 = await deviceService.createPairingChallenge({
      enrollmentToken: token4.pairingToken,
      publicKeyPem: sharedKeys.publicKeyPem,
    });
    const sigShared1 = signChallenge(sharedKeys, token3.pairingToken, chShared1);
    const sigShared2 = signChallenge(sharedKeys, token4.pairingToken, chShared2);

    const keyRace = await Promise.allSettled([
      deviceService.pairDevice({
        enrollmentToken: token3.pairingToken,
        challengeId: chShared1.challengeId,
        challengeSignature: sigShared1,
        publicKeyPem: sharedKeys.publicKeyPem,
        deviceModel: 'Race A',
        manufacturer: 'Samsung',
        androidVersion: '14',
        appVersion: '1.0.0',
      }),
      deviceService.pairDevice({
        enrollmentToken: token4.pairingToken,
        challengeId: chShared2.challengeId,
        challengeSignature: sigShared2,
        publicKeyPem: sharedKeys.publicKeyPem,
        deviceModel: 'Race B',
        manufacturer: 'Samsung',
        androidVersion: '14',
        appVersion: '1.0.0',
      }),
    ]);
    assert.equal(keyRace.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(keyRace.filter((r) => r.status === 'rejected').length, 1);
  });

  it('7. rejects malformed public keys, private key submission, wrong curves/RSA/Ed25519, and unsupported algorithms', async () => {
    const tokenRes = await deviceService.createPairingToken(orgAId, adminAId);

    // Wrong curve: P-384
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const p384Pem = p384.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await assert.rejects(
      deviceService.createPairingChallenge({ enrollmentToken: tokenRes.pairingToken, publicKeyPem: p384Pem }),
      /Unsupported|prime256v1/,
    );

    // Wrong key type: RSA 2048
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await assert.rejects(
      deviceService.createPairingChallenge({ enrollmentToken: tokenRes.pairingToken, publicKeyPem: rsaPem }),
      /Unsupported/,
    );

    // Wrong key type: Ed25519
    const ed25519 = generateKeyPairSync('ed25519');
    const edPem = ed25519.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await assert.rejects(
      deviceService.createPairingChallenge({ enrollmentToken: tokenRes.pairingToken, publicKeyPem: edPem }),
      /Unsupported/,
    );

    // Private key accidentally/maliciously submitted
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privPem = p256.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const privRes = await makeHttpRequest('POST', '/v1/devices/pairing-challenge', {}, {
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: privPem,
    });
    assert.equal(privRes.statusCode, 400);
    assert.equal(privRes.json?.error?.code, 'PRIVATE_KEY_SUBMISSION_FORBIDDEN');

    // Malformed garbage string
    const garbageRes = await makeHttpRequest('POST', '/v1/devices/pairing-challenge', {}, {
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: 'not-a-valid-key',
    });
    assert.equal(garbageRes.statusCode, 400);
    assert.equal(garbageRes.json?.error?.code, 'INVALID_PUBLIC_KEY');

    // Unsupported algorithm flags
    const validKeys = generateTestP256KeyPair();
    const badAlgRes = await makeHttpRequest('POST', '/v1/devices/pairing-challenge', {}, {
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: validKeys.publicKeyPem,
      keyAlgorithm: 'RSA_2048',
    });
    assert.equal(badAlgRes.statusCode, 400);
    assert.equal(badAlgRes.json?.error?.code, 'UNSUPPORTED_CRYPTO_ALGORITHM');

    const badSigAlgRes = await makeHttpRequest('POST', '/v1/devices/pairing-challenge', {}, {
      enrollmentToken: tokenRes.pairingToken,
      publicKeyPem: validKeys.publicKeyPem,
      signatureAlgorithm: 'MD5_RSA',
    });
    assert.equal(badSigAlgRes.statusCode, 400);
    assert.equal(badSigAlgRes.json?.error?.code, 'UNSUPPORTED_CRYPTO_ALGORITHM');
  });

  it('8. blocks silent replacement or re-registration of an already registered device key', async () => {
    const token1 = await deviceService.createPairingToken(orgAId, adminAId);
    const keys1 = generateTestP256KeyPair();
    const ch1 = await deviceService.createPairingChallenge({
      enrollmentToken: token1.pairingToken,
      publicKeyPem: keys1.publicKeyPem,
    });
    const enrolled = await deviceService.pairDevice({
      enrollmentToken: token1.pairingToken,
      challengeId: ch1.challengeId,
      challengeSignature: signChallenge(keys1, token1.pairingToken, ch1),
      publicKeyPem: keys1.publicKeyPem,
      deviceModel: 'Original Phone',
      manufacturer: 'Samsung',
      androidVersion: '14',
      appVersion: '1.0.0',
    });

    // Fresh token cannot re-register existing public key
    const token2 = await deviceService.createPairingToken(orgAId, adminAId);
    const reuseKeyRes = await makeHttpRequest('POST', '/v1/devices/pairing-challenge', {}, {
      enrollmentToken: token2.pairingToken,
      publicKeyPem: keys1.publicKeyPem,
    });
    assert.equal(reuseKeyRes.statusCode, 409);
    assert.equal(reuseKeyRes.json?.error?.code, 'PUBLIC_KEY_ALREADY_REGISTERED');

    // Supplying existing deviceId attempting to overwrite existing key with new keypair is forbidden
    const newKeys = generateTestP256KeyPair();
    const replaceRes = await makeHttpRequest('POST', '/v1/devices/pairing-challenge', {}, {
      enrollmentToken: token2.pairingToken,
      publicKeyPem: newKeys.publicKeyPem,
      deviceId: enrolled.deviceId,
    });
    assert.equal(replaceRes.statusCode, 409);
    assert.equal(replaceRes.json?.error?.code, 'DEVICE_KEY_REPLACEMENT_FORBIDDEN');

    // Sending device Bearer token to /v1/devices/pair attempting silent re-pair is forbidden
    const bearerPairRes = await makeHttpRequest(
      'POST',
      '/v1/devices/pair',
      { Authorization: `Bearer ${enrolled.deviceToken}` },
      {
        enrollmentToken: token2.pairingToken,
        challengeId: randomUUID(),
        challengeSignature: 'AAAA',
        publicKeyPem: newKeys.publicKeyPem,
        deviceModel: 'Replacement',
        manufacturer: 'Samsung',
        androidVersion: '14',
        appVersion: '1.0.0',
      },
    );
    assert.equal(bearerPairRes.statusCode, 409);
    assert.equal(bearerPairRes.json?.error?.code, 'DEVICE_KEY_REPLACEMENT_FORBIDDEN');

    // Existing device key remains unchanged
    const storedAfter = await dbStore.getDeviceById(enrolled.deviceId, orgAId);
    assert.equal(storedAfter?.publicKeyFingerprint, keys1.fingerprint);
    assert.equal(storedAfter?.publicKeyPem, keys1.publicKeyPem);
  });

  it('9. verifies canonical binary transcript resists delimiter injection and normalizes PEM/Base64 DER identically', () => {
    const keys = generateTestP256KeyPair();
    const parsedFromPem = parseAndValidateDevicePublicKey(keys.publicKeyPem);
    const parsedFromDerB64 = parseAndValidateDevicePublicKey(keys.publicKeyBase64Der);

    assert.equal(parsedFromPem.fingerprint, parsedFromDerB64.fingerprint);
    assert.equal(parsedFromPem.canonicalPem, parsedFromDerB64.canonicalPem);

    const t1 = buildPairingChallengeTranscript({
      challengeId: 'a|b',
      enrollmentId: 'c',
      organizationId: 'org',
      pairingTokenHash: 'tok',
      publicKeyFingerprint: keys.fingerprint,
      keyAlgorithm: 'EC_P256',
      signatureAlgorithm: 'SHA256_ECDSA',
      challengeNonce: 'nonce',
      expiresAtIso: '2026-11-14T12:00:00.000Z',
    });
    const t2 = buildPairingChallengeTranscript({
      challengeId: 'a',
      enrollmentId: 'b|c',
      organizationId: 'org',
      pairingTokenHash: 'tok',
      publicKeyFingerprint: keys.fingerprint,
      keyAlgorithm: 'EC_P256',
      signatureAlgorithm: 'SHA256_ECDSA',
      challengeNonce: 'nonce',
      expiresAtIso: '2026-11-14T12:00:00.000Z',
    });
    assert.notDeepEqual(t1, t2);

    const sig = cryptoSign('sha256', t1, { key: keys.privateKey, dsaEncoding: 'der' }).toString('base64');
    assert.equal(verifyDevicePairingSignature({ publicKeyPem: parsedFromPem.canonicalPem, transcriptBytes: t1, signatureBase64: sig }).valid, true);
    assert.equal(verifyDevicePairingSignature({ publicKeyPem: parsedFromPem.canonicalPem, transcriptBytes: t2, signatureBase64: sig }).valid, false);
  });

  it('10. matches the pinned cross-language Android/Kotlin canonical transcript bytes, ECDSA DER signature, and permanently blocks revoked key reuse', async () => {
    const vectorSpkiBase64 =
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfaAtwTSAkNeIPdbRfZcPR0s2YC7ccIGemkjILeyHQZLz7kjfZKksl+NiRBnpyS/f44pemm87Pe2MyrXsPcyGLQ==';
    const expectedPem =
      '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfaAtwTSAkNeIPdbRfZcPR0s2YC7c\ncIGemkjILeyHQZLz7kjfZKksl+NiRBnpyS/f44pemm87Pe2MyrXsPcyGLQ==\n-----END PUBLIC KEY-----';
    const expectedFingerprint = '5caa2a11c88c7a0e71859fcdebccaa1d01abe40261e6eed39c9ad96349e4f25e';
    const expectedToken = 'bsk_pair_crosslang_vector_001';
    const expectedTokenHash = 'f38e1b49dae424cd13d3c3d551f39ab4f9907e9304f5cc94e9b653d66304a6f3';
    const expectedTranscriptHex =
      '0000001e425249534b534d532d4445564943452d50414952494e472d504f502d5631' +
      '0000002431313131313131312d313131312d343131312d383131312d313131313131313131313131' +
      '0000002432323232323232322d323232322d343232322d383232322d323232323232323232323232' +
      '0000002433333333333333332d333333332d343333332d383333332d333333333333333333333333' +
      '0000004066333865316234396461653432346364313364336333643535316633396162346639393037653933303466356363393465396236353364363633303461366633' +
      '0000004035636161326131316338386337613065373138353966636465626363616131643031616265343032363165366565643339633961643936333439653466323565' +
      '0000000745435f50323536' +
      '0000000c5348413235365f4543445341' +
      '0000002b59574a6a5a47566d5a326870616d7473625735766348467963335231646e643465586f774d54497a4e4455' +
      '00000018323032362d31312d31345431323a30303a30302e3132335a';
    const vectorSigBase64 =
      'MEQCIGxGKxwg45gNgviFTwPvwochwdv03715/GHAvG75nGLjAiAPldNfxsjytvwe0YXTBlw+C8CPm+Sw9knzQQ3QqVwJlA==';

    const parsed = parseAndValidateDevicePublicKey(vectorSpkiBase64);
    assert.equal(parsed.canonicalPem, expectedPem);
    assert.equal(parsed.fingerprint, expectedFingerprint);
    assert.equal(hashToken(expectedToken), expectedTokenHash);

    const transcript = buildPairingChallengeTranscript({
      challengeId: '11111111-1111-4111-8111-111111111111',
      enrollmentId: '22222222-2222-4222-8222-222222222222',
      organizationId: '33333333-3333-4333-8333-333333333333',
      pairingTokenHash: hashToken(expectedToken),
      publicKeyFingerprint: parsed.fingerprint,
      keyAlgorithm: 'EC_P256',
      signatureAlgorithm: 'SHA256_ECDSA',
      challengeNonce: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU',
      expiresAtIso: '2026-11-14T12:00:00.123Z',
    });
    assert.equal(transcript.length, 392);
    assert.equal(transcript.toString('hex'), expectedTranscriptHex);
    assert.equal(
      createHash('sha256').update(transcript).digest('hex'),
      'a6d6f93a7079c6baa093e5b8a041d7c2a8f955bf2d528cefd9f94cb006bc44fc',
    );
    assert.equal(
      verifyDevicePairingSignature({
        publicKeyPem: parsed.canonicalPem,
        transcriptBytes: transcript,
        signatureBase64: vectorSigBase64,
      }).valid,
      true,
    );

    // Revoking an enrolled device must also block reuse of its registered public key fingerprint
    const token1 = await deviceService.createPairingToken(orgAId, adminAId);
    const keys1 = generateTestP256KeyPair();
    const ch1 = await deviceService.createPairingChallenge({
      enrollmentToken: token1.pairingToken,
      publicKeyPem: keys1.publicKeyPem,
    });
    const enrolled = await deviceService.pairDevice({
      enrollmentToken: token1.pairingToken,
      challengeId: ch1.challengeId,
      challengeSignature: signChallenge(keys1, token1.pairingToken, ch1),
      publicKeyPem: keys1.publicKeyPem,
      deviceModel: 'RevokablePhone',
      manufacturer: 'Tecno',
      androidVersion: '14',
      appVersion: '1.0.0',
      ingestionMode: DeviceIngestionMode.NOTIFICATION_LISTENER,
    });
    await deviceService.revokeDevice(enrolled.deviceId, orgAId, adminAId);

    const token2 = await deviceService.createPairingToken(orgAId, adminAId);
    await assert.rejects(
      () =>
        deviceService.createPairingChallenge({
          enrollmentToken: token2.pairingToken,
          publicKeyPem: keys1.publicKeyPem,
        }),
      (err: any) => err.code === 'PUBLIC_KEY_ALREADY_REGISTERED' && err.statusCode === 409,
    );
  });
});
