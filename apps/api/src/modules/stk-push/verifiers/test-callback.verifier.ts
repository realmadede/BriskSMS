import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentProvider } from '@brisksms/shared';
import {
  CallbackVerificationRequest,
  CallbackVerificationResult,
  ProviderCallbackVerifier,
} from './callback-verifier.interface.js';

export interface TestVerifierOptions {
  secretKey: string;
  signatureHeader?: string;
  timestampHeader?: string;
  toleranceSeconds?: number;
  clockSkewToleranceSeconds?: number;
}

/**
 * TEST-ONLY Callback Verifier
 *
 * Strictly for automated testing of the callback trust boundary.
 * Never enable or use in production or staging environments.
 *
 * Implements HMAC-SHA256 signature verification with constant-time equality check,
 * timestamp tolerance, and in-memory replay attack prevention.
 */
export class TestCallbackVerifier implements ProviderCallbackVerifier {
  private readonly replayCache = new Map<string, number>();
  private readonly signatureHeader: string;
  private readonly timestampHeader: string;
  private readonly toleranceSeconds: number;
  private readonly clockSkewToleranceSeconds: number;

  constructor(
    public readonly provider: PaymentProvider,
    private readonly options: TestVerifierOptions,
  ) {
    this.signatureHeader = (options.signatureHeader || 'x-signature').toLowerCase();
    this.timestampHeader = (options.timestampHeader || 'x-timestamp').toLowerCase();
    this.toleranceSeconds = options.toleranceSeconds ?? 300; // 5 minutes
    this.clockSkewToleranceSeconds = options.clockSkewToleranceSeconds ?? 60; // 1 minute
  }

  public clearReplayCache(): void {
    this.replayCache.clear();
  }

  verify(req: CallbackVerificationRequest): CallbackVerificationResult {
    // 1. Extract signature header
    const rawSig = req.headers[this.signatureHeader];
    if (!rawSig || typeof rawSig !== 'string') {
      return {
        isValid: false,
        code: 'MISSING_SIGNATURE',
        reason: `Missing required signature header '${this.signatureHeader}'`,
      };
    }
    const cleanSig = rawSig.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleanSig)) {
      return {
        isValid: false,
        code: 'MALFORMED_SIGNATURE',
        reason: 'Signature header must be a 64-character lowercase hex string',
      };
    }

    // 2. Extract timestamp header
    const rawTimestamp = req.headers[this.timestampHeader];
    if (!rawTimestamp || typeof rawTimestamp !== 'string') {
      return {
        isValid: false,
        code: 'MISSING_TIMESTAMP',
        reason: `Missing required timestamp header '${this.timestampHeader}'`,
      };
    }
    const cleanTimestamp = rawTimestamp.trim();
    const timestampSec = parseInt(cleanTimestamp, 10);
    if (!Number.isSafeInteger(timestampSec) || timestampSec <= 0) {
      return {
        isValid: false,
        code: 'MALFORMED_TIMESTAMP',
        reason: 'Timestamp header must be a positive integer Unix timestamp in seconds',
      };
    }

    // 3. Timestamp Freshness and Skew Validation
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - timestampSec > this.toleranceSeconds) {
      return {
        isValid: false,
        code: 'EXPIRED_TIMESTAMP',
        reason: `Callback timestamp expired (${nowSec - timestampSec}s > ${this.toleranceSeconds}s tolerance)`,
      };
    }
    if (timestampSec - nowSec > this.clockSkewToleranceSeconds) {
      return {
        isValid: false,
        code: 'FUTURE_TIMESTAMP',
        reason: `Callback timestamp in future exceeds allowable clock skew (${timestampSec - nowSec}s > ${this.clockSkewToleranceSeconds}s)`,
      };
    }

    // 4. Replay Attack Detection
    const replayKey = `${cleanSig}:${cleanTimestamp}`;
    const nowMs = Date.now();
    const cachedExpiry = this.replayCache.get(replayKey);
    if (cachedExpiry && cachedExpiry > nowMs) {
      return {
        isValid: false,
        code: 'REPLAY_ATTACK',
        reason: 'Duplicate callback signature detected within replay protection window',
      };
    }

    // 5. Signature computation & constant-time check
    const rawBodyStr = typeof req.rawBody === 'string'
      ? req.rawBody
      : Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString('utf8')
        : JSON.stringify(req.body);

    const signingInput = `${cleanTimestamp}.${rawBodyStr}`;
    const expectedSigHex = createHmac('sha256', this.options.secretKey)
      .update(signingInput, 'utf8')
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSigHex, 'hex');
    const actualBuf = Buffer.from(cleanSig, 'hex');

    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return {
        isValid: false,
        code: 'INVALID_SIGNATURE',
        reason: 'HMAC signature verification failed against provider test key',
      };
    }

    // Store in replay cache with TTL
    this.replayCache.set(replayKey, nowMs + this.toleranceSeconds * 1000);

    return {
      isValid: true,
      code: 'VALID',
    };
  }
}
