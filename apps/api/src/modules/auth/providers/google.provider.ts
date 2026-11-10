import { createPublicKey, verify, timingSafeEqual } from 'node:crypto';

export interface GoogleTokenPayload {
  iss: string;
  sub: string;
  aud: string | string[];
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  exp: number;
  nonce?: string;
}

export interface GoogleTokenVerifier {
  verifyIdToken(idToken: string, expectedNonce?: string): Promise<GoogleTokenPayload>;
}

interface GoogleJwk {
  kty: string;
  alg: string;
  use: string;
  kid: string;
  n: string;
  e: string;
}

interface GoogleJwksResponse {
  keys: GoogleJwk[];
}

export class DefaultGoogleTokenVerifier implements GoogleTokenVerifier {
  private jwksCache: { keys: GoogleJwk[]; expiresAt: number } | null = null;
  private readonly jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';
  private readonly cacheTtlMs = 3600_000; // 1 hour

  constructor(private readonly clientId: string = process.env.GOOGLE_CLIENT_ID || '') {}

  async verifyIdToken(idToken: string, expectedNonce?: string): Promise<GoogleTokenPayload> {
    if (!idToken || typeof idToken !== 'string') {
      throw new Error('Google ID token is required');
    }

    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed Google ID token: expected 3 parts');
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    // Decode Header
    let header: { alg?: string; kid?: string; typ?: string };
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Malformed Google ID token header');
    }

    if (header.alg !== 'RS256' || !header.kid) {
      throw new Error(`Unsupported or missing signature algorithm/key in Google ID token: ${header.alg}`);
    }

    // Decode Payload
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Malformed Google ID token payload');
    }

    // 1. Verify Issuer
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
      throw new Error(`Invalid Google token issuer: "${payload.iss}"`);
    }

    // 2. Verify Audience & Authorized Party (azp)
    const expectedAudience = this.clientId || process.env.GOOGLE_CLIENT_ID;
    if (!expectedAudience) {
      throw new Error('GOOGLE_CLIENT_ID is not configured on the server');
    }

    if (typeof payload.aud === 'string') {
      if (payload.aud !== expectedAudience) {
        throw new Error(`Google token audience mismatch: expected "${expectedAudience}", received "${payload.aud}"`);
      }
      if (payload.azp && payload.azp !== expectedAudience) {
        throw new Error(`Google token authorized party (azp) mismatch: expected "${expectedAudience}", received "${payload.azp}"`);
      }
    } else if (Array.isArray(payload.aud)) {
      if (!payload.aud.includes(expectedAudience)) {
        throw new Error(`Google token audience mismatch: expected "${expectedAudience}", received [${payload.aud.join(', ')}]`);
      }
      if (!payload.azp) {
        throw new Error(`Google token with multiple audiences requires an authorized party (azp) claim`);
      }
      if (payload.azp !== expectedAudience) {
        throw new Error(`Google token authorized party (azp) mismatch: expected "${expectedAudience}", received "${payload.azp}"`);
      }
    } else {
      throw new Error(`Google token does not contain a valid audience (aud) claim`);
    }

    // 3. Verify Expiry, iat, and nbf (with 300s clock skew tolerance)
    const nowSec = Math.floor(Date.now() / 1000);
    const clockSkewSec = 300;

    if (typeof payload.exp !== 'number' || payload.exp <= nowSec - clockSkewSec) {
      throw new Error(`Google token is expired (exp: ${payload.exp}, now: ${nowSec})`);
    }

    if (typeof payload.iat === 'number' && payload.iat > nowSec + clockSkewSec) {
      throw new Error(`Google token issued in future (iat: ${payload.iat}, now: ${nowSec})`);
    }

    if (typeof payload.nbf === 'number' && payload.nbf > nowSec + clockSkewSec) {
      throw new Error(`Google token not yet valid (nbf: ${payload.nbf}, now: ${nowSec})`);
    }

    // 4. Verify Email & Email Verified Claim
    if (!payload.email || typeof payload.email !== 'string') {
      throw new Error('Google token does not contain a valid email address');
    }
    const isEmailVerified = payload.email_verified === true || payload.email_verified === 'true';
    if (!isEmailVerified) {
      throw new Error('Google account email is not verified by Google');
    }

    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new Error('Google token does not contain a valid subject (sub) claim');
    }

    // 5. Verify Cryptographic Signature against Google Public JWKS
    const key = await this.getGooglePublicKey(header.kid);
    if (!key) {
      throw new Error(`Google public key not found for kid: "${header.kid}"`);
    }

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = Buffer.from(signatureB64, 'base64url');

    const isValid = verify('RSA-SHA256', signingInput, key, signature);
    if (!isValid) {
      throw new Error('Google ID token cryptographic signature verification failed');
    }

    // 6. Verify Nonce Claim (if expectedNonce is supplied)
    if (expectedNonce !== undefined) {
      if (!payload.nonce || typeof payload.nonce !== 'string') {
        throw new Error('Google ID token is missing required nonce claim');
      }
      const tokenNonceBuf = Buffer.from(payload.nonce, 'utf-8');
      const expectedNonceBuf = Buffer.from(expectedNonce, 'utf-8');
      if (tokenNonceBuf.length !== expectedNonceBuf.length || !timingSafeEqual(tokenNonceBuf, expectedNonceBuf)) {
        throw new Error('Google ID token nonce does not match expected nonce');
      }
    }

    return {
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      email: payload.email.trim().toLowerCase(),
      email_verified: isEmailVerified,
      name: payload.name,
      picture: payload.picture,
      exp: payload.exp,
      nonce: payload.nonce,
    };
  }

  private async getGooglePublicKey(kid: string): Promise<any | null> {
    let keys = await this.fetchJwks();
    let jwk = keys.find((k) => k.kid === kid);

    // If key ID not found in current cache, Google might have rotated keys. Force a fresh fetch once!
    if (!jwk && this.jwksCache) {
      this.jwksCache = null;
      keys = await this.fetchJwks();
      jwk = keys.find((k) => k.kid === kid);
    }

    if (!jwk) return null;

    try {
      return createPublicKey({
        key: jwk as any,
        format: 'jwk',
      });
    } catch (err) {
      throw new Error(`Failed to import Google JWK key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async fetchJwks(): Promise<GoogleJwk[]> {
    if (this.jwksCache && this.jwksCache.expiresAt > Date.now()) {
      return this.jwksCache.keys;
    }

    try {
      const res = await fetch(this.jwksUrl, {
        headers: { 'User-Agent': 'BriskSMS-Auth/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching Google certs`);
      }
      const data = (await res.json()) as GoogleJwksResponse;
      this.jwksCache = {
        keys: data.keys || [],
        expiresAt: Date.now() + this.cacheTtlMs,
      };
      return this.jwksCache.keys;
    } catch (err) {
      // If cached keys exist even if expired, use as fallback
      if (this.jwksCache && this.jwksCache.keys.length > 0) {
        return this.jwksCache.keys;
      }
      throw new Error(`Failed to fetch Google public signing keys: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Mock Google Token Verifier for unit & integration testing
 */
export class MockGoogleTokenVerifier implements GoogleTokenVerifier {
  public mockUsers = new Map<string, GoogleTokenPayload>();
  public failureMode: string | null = null;

  registerToken(idToken: string, payload: GoogleTokenPayload): void {
    this.mockUsers.set(idToken, payload);
  }

  async verifyIdToken(idToken: string, expectedNonce?: string): Promise<GoogleTokenPayload> {
    if (this.failureMode) {
      throw new Error(`Simulated Google verification failure: ${this.failureMode}`);
    }

    const payload = this.mockUsers.get(idToken);
    if (!payload) {
      // If token format is invalid, throw format error
      const parts = idToken.split('.');
      if (parts.length !== 3) {
        throw new Error('Malformed Google ID token: expected 3 parts');
      }
      throw new Error('Google ID token cryptographic signature verification failed: unrecognized token in test double');
    }

    // Check expiry
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowSec) {
      throw new Error(`Google token is expired (exp: ${payload.exp}, now: ${nowSec})`);
    }

    // Check audience
    const expectedAudience = process.env.GOOGLE_CLIENT_ID || 'test_google_client_id';
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audList.includes(expectedAudience)) {
      throw new Error(`Google token audience mismatch: expected "${expectedAudience}", received "${payload.aud}"`);
    }

    // Check issuer
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
      throw new Error(`Invalid Google token issuer: "${payload.iss}"`);
    }

    // Check email_verified
    if (!payload.email_verified) {
      throw new Error('Google account email is not verified by Google');
    }

    // Check nonce if expectedNonce is supplied
    if (expectedNonce !== undefined) {
      if (!payload.nonce || typeof payload.nonce !== 'string') {
        throw new Error('Google ID token is missing required nonce claim');
      }
      const tokenNonceBuf = Buffer.from(payload.nonce, 'utf-8');
      const expectedNonceBuf = Buffer.from(expectedNonce, 'utf-8');
      if (tokenNonceBuf.length !== expectedNonceBuf.length || !timingSafeEqual(tokenNonceBuf, expectedNonceBuf)) {
        throw new Error('Google ID token nonce does not match expected nonce');
      }
    }

    return { ...payload };
  }

  clear(): void {
    this.mockUsers.clear();
    this.failureMode = null;
  }
}

export const googleTokenVerifier: GoogleTokenVerifier = new DefaultGoogleTokenVerifier();
