import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDeduplicationHash,
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../src/utils/crypto.utils.js';

describe('Crypto Utils', () => {
  it('should generate consistent deterministic deduplication hash', () => {
    const orgId = '018f2d50-1234-7890-b2c3-d4e5f6a7b8c9';
    const provider = 'MPESA';
    const reference = 'QA12BC34DE';
    const amountCents = 5000000n;
    const timestamp = '2026-11-05T14:30:00.000Z';

    const hash1 = computeDeduplicationHash(orgId, provider, reference, amountCents, timestamp);
    const hash2 = computeDeduplicationHash(orgId, provider, reference, amountCents, timestamp);

    assert.equal(hash1, hash2);
    assert.equal(typeof hash1, 'string');
    assert.equal(hash1.length, 64); // SHA-256 hex length
  });

  it('should change hash if any attribute changes', () => {
    const orgId = '018f2d50-1234-7890-b2c3-d4e5f6a7b8c9';
    const provider = 'MPESA';
    const reference = 'QA12BC34DE';
    const amountCents = 5000000n;
    const timestamp = '2026-11-05T14:30:00.000Z';

    const baseHash = computeDeduplicationHash(orgId, provider, reference, amountCents, timestamp);
    const diffAmountHash = computeDeduplicationHash(orgId, provider, reference, 5000001n, timestamp);
    const diffRefHash = computeDeduplicationHash(orgId, provider, 'QA12BC34DF', amountCents, timestamp);

    assert.notEqual(baseHash, diffAmountHash);
    assert.notEqual(baseHash, diffRefHash);
  });

  it('should sign and verify webhook payload accurately', () => {
    const secret = 'test_mock_hmac_secret_key';
    const timestamp = 1730822400;
    const body = JSON.stringify({ event: 'payment.verified', amount: 50000 });

    const signature = computeWebhookSignature(secret, timestamp, body);
    assert.equal(typeof signature, 'string');

    const isValid = verifyWebhookSignature(secret, timestamp, body, signature);
    assert.equal(isValid, true);

    const isTampered = verifyWebhookSignature(secret, timestamp, body + ' ', signature);
    assert.equal(isTampered, false);
  });
});

