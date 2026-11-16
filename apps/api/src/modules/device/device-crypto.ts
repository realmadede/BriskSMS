import { createHash, createPublicKey, KeyObject, verify as cryptoVerify } from 'node:crypto';
import {
  DEVICE_PAIRING_POP_PROTOCOL_VERSION,
  DeviceKeyAlgorithm,
  DeviceSignatureAlgorithm,
  SUPPORTED_DEVICE_KEY_ALGORITHM,
  SUPPORTED_DEVICE_SIGNATURE_ALGORITHM,
} from '@brisksms/shared';
import { HttpException } from '../../core/http.js';

export interface ValidatedDevicePublicKey {
  keyObject: KeyObject;
  canonicalPem: string;
  spkiDer: Buffer;
  fingerprint: string;
  keyAlgorithm: DeviceKeyAlgorithm;
}

export interface PairingTranscriptInput {
  challengeId: string;
  enrollmentId: string;
  organizationId: string;
  pairingTokenHash: string;
  publicKeyFingerprint: string;
  keyAlgorithm: DeviceKeyAlgorithm;
  signatureAlgorithm: DeviceSignatureAlgorithm;
  challengeNonce: string;
  expiresAtIso: string;
}

const PEM_HEADER = '-----BEGIN PUBLIC KEY-----';
const PEM_FOOTER = '-----END PUBLIC KEY-----';
const UNCOMPRESSED_P256_SPKI_DER_LENGTH = 91;

/**
 * Validates requested pairing cryptographic algorithms against the strict EC P-256 + SHA256-ECDSA allowlist.
 */
export function validatePairingAlgorithms(
  keyAlgorithm?: unknown,
  signatureAlgorithm?: unknown,
): { keyAlgorithm: DeviceKeyAlgorithm; signatureAlgorithm: DeviceSignatureAlgorithm } {
  if (keyAlgorithm !== undefined && keyAlgorithm !== null) {
    if (keyAlgorithm !== SUPPORTED_DEVICE_KEY_ALGORITHM) {
      throw new HttpException(
        400,
        'UNSUPPORTED_CRYPTO_ALGORITHM',
        `Unsupported device key algorithm '${String(keyAlgorithm)}'. Expected '${SUPPORTED_DEVICE_KEY_ALGORITHM}'.`,
      );
    }
  }

  if (signatureAlgorithm !== undefined && signatureAlgorithm !== null) {
    if (signatureAlgorithm !== SUPPORTED_DEVICE_SIGNATURE_ALGORITHM) {
      throw new HttpException(
        400,
        'UNSUPPORTED_CRYPTO_ALGORITHM',
        `Unsupported challenge signature algorithm '${String(signatureAlgorithm)}'. Expected '${SUPPORTED_DEVICE_SIGNATURE_ALGORITHM}'.`,
      );
    }
  }

  return {
    keyAlgorithm: SUPPORTED_DEVICE_KEY_ALGORITHM,
    signatureAlgorithm: SUPPORTED_DEVICE_SIGNATURE_ALGORITHM,
  };
}

/**
 * Parses and strictly validates an EC P-256 (secp256r1 / prime256v1) X.509 SPKI public key.
 * Accepts canonical SPKI PEM or raw Base64 SPKI DER (from Android Keystore `publicKey.encoded`),
 * normalizes to canonical PEM, and returns its SHA-256 SPKI DER fingerprint.
 */
export function parseAndValidateDevicePublicKey(rawPublicKey: unknown): ValidatedDevicePublicKey {
  if (typeof rawPublicKey !== 'string') {
    throw new HttpException(400, 'INVALID_PUBLIC_KEY', 'publicKeyPem must be a non-empty string');
  }

  const trimmed = rawPublicKey.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) {
    throw new HttpException(400, 'INVALID_PUBLIC_KEY', 'publicKeyPem length is invalid');
  }

  if (/PRIVATE KEY/i.test(trimmed)) {
    throw new HttpException(
      400,
      'PRIVATE_KEY_SUBMISSION_FORBIDDEN',
      'Private keys must never leave Android Keystore or be submitted to the backend',
    );
  }

  let spkiDer: Buffer;
  if (trimmed.includes('-----BEGIN')) {
    if (!trimmed.startsWith(PEM_HEADER) || !trimmed.endsWith(PEM_FOOTER)) {
      throw new HttpException(
        400,
        'INVALID_PUBLIC_KEY',
        'Public key PEM must use X.509 SubjectPublicKeyInfo (BEGIN PUBLIC KEY) format',
      );
    }
    const base64Body = trimmed
      .slice(PEM_HEADER.length, trimmed.length - PEM_FOOTER.length)
      .replace(/[\r\n\s]+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Body) || base64Body.length % 4 !== 0) {
      throw new HttpException(400, 'INVALID_PUBLIC_KEY', 'Public key PEM body contains invalid Base64');
    }
    spkiDer = Buffer.from(base64Body, 'base64');
  } else {
    const cleanBase64 = trimmed.replace(/[\r\n\s]+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleanBase64) || cleanBase64.length % 4 !== 0) {
      throw new HttpException(
        400,
        'INVALID_PUBLIC_KEY',
        'Public key must be valid X.509 SPKI PEM or Base64 DER',
      );
    }
    spkiDer = Buffer.from(cleanBase64, 'base64');
  }

  if (spkiDer.length !== UNCOMPRESSED_P256_SPKI_DER_LENGTH) {
    // Reject truncated, oversized, or non-standard SPKI before or alongside ASN.1 parsing
    let parsedKey: KeyObject | null = null;
    try {
      parsedKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    } catch {
      throw new HttpException(400, 'INVALID_PUBLIC_KEY', 'Malformed X.509 SPKI public key encoding');
    }

    if (parsedKey.asymmetricKeyType !== 'ec' || parsedKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new HttpException(
        400,
        'UNSUPPORTED_PUBLIC_KEY',
        `Unsupported public key type '${parsedKey.asymmetricKeyType ?? 'unknown'}' (${parsedKey.asymmetricKeyDetails?.namedCurve ?? 'n/a'}). Expected EC P-256 (prime256v1).`,
      );
    }

    throw new HttpException(
      400,
      'INVALID_PUBLIC_KEY',
      'EC P-256 public key must use standard uncompressed X.509 SPKI encoding',
    );
  }

  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  } catch {
    throw new HttpException(400, 'INVALID_PUBLIC_KEY', 'Malformed X.509 SPKI public key encoding');
  }

  if (keyObject.type !== 'public' || keyObject.asymmetricKeyType !== 'ec') {
    throw new HttpException(
      400,
      'UNSUPPORTED_PUBLIC_KEY',
      'Unsupported public key type. Expected ECDSA P-256.',
    );
  }

  if (keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new HttpException(
      400,
      'UNSUPPORTED_PUBLIC_KEY',
      `Unsupported elliptic curve '${keyObject.asymmetricKeyDetails?.namedCurve ?? 'unknown'}'. Expected P-256 (prime256v1).`,
    );
  }

  const jwk = keyObject.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    !jwk.x ||
    !jwk.y ||
    Buffer.from(jwk.x, 'base64url').length !== 32 ||
    Buffer.from(jwk.y, 'base64url').length !== 32
  ) {
    throw new HttpException(400, 'UNSUPPORTED_PUBLIC_KEY', 'Invalid EC P-256 coordinate key size');
  }

  const canonicalDer = keyObject.export({ type: 'spki', format: 'der' });
  if (canonicalDer.length !== UNCOMPRESSED_P256_SPKI_DER_LENGTH) {
    throw new HttpException(400, 'INVALID_PUBLIC_KEY', 'Invalid canonical SPKI key length');
  }

  const canonicalPem = keyObject.export({ type: 'spki', format: 'pem' }).toString().trim();
  const fingerprint = createHash('sha256').update(canonicalDer).digest('hex');

  return {
    keyObject,
    canonicalPem,
    spkiDer: canonicalDer,
    fingerprint,
    keyAlgorithm: SUPPORTED_DEVICE_KEY_ALGORITHM,
  };
}

/**
 * Constructs an unambiguous, domain-separated, length-prefixed binary transcript
 * (`uint32be(byteLength) || utf8(field)` per field) for Android device pairing proof-of-possession.
 * Eliminates JSON serialization-order differences and string-delimiter injection.
 */
export function buildPairingChallengeTranscript(input: PairingTranscriptInput): Buffer {
  const fields = [
    DEVICE_PAIRING_POP_PROTOCOL_VERSION,
    input.challengeId,
    input.enrollmentId,
    input.organizationId,
    input.pairingTokenHash,
    input.publicKeyFingerprint,
    input.keyAlgorithm,
    input.signatureAlgorithm,
    input.challengeNonce,
    input.expiresAtIso,
  ];

  const chunks: Buffer[] = [];
  for (const value of fields) {
    const utf8 = Buffer.from(value, 'utf8');
    const lenPrefix = Buffer.allocUnsafe(4);
    lenPrefix.writeUInt32BE(utf8.length, 0);
    chunks.push(lenPrefix, utf8);
  }

  return Buffer.concat(chunks);
}

/**
 * Validates strict ASN.1 DER structure for an ECDSA `(r, s)` sequence without trailing bytes.
 */
function isStrictDerEcdsaSignature(sigBuf: Buffer): boolean {
  if (sigBuf.length < 8 || sigBuf.length > 80 || sigBuf[0] !== 0x30) {
    return false;
  }
  const seqLen = sigBuf[1]!;
  if (seqLen + 2 !== sigBuf.length || sigBuf[2] !== 0x02) {
    return false;
  }
  const rLen = sigBuf[3]!;
  if (rLen === 0 || 4 + rLen >= sigBuf.length) {
    return false;
  }
  const sTagIdx = 4 + rLen;
  if (sigBuf[sTagIdx] !== 0x02) {
    return false;
  }
  const sLen = sigBuf[sTagIdx + 1]!;
  if (sLen === 0 || sTagIdx + 2 + sLen !== sigBuf.length) {
    return false;
  }
  return true;
}

/**
 * Verifies a Base64-encoded ASN.1 DER SHA256withECDSA signature against the canonical pairing transcript.
 */
export function verifyDevicePairingSignature(params: {
  publicKeyPem: string;
  transcriptBytes: Buffer;
  signatureBase64: unknown;
}): { valid: boolean; reason?: string } {
  if (typeof params.signatureBase64 !== 'string') {
    return { valid: false, reason: 'Missing challenge signature' };
  }

  const trimmed = params.signatureBase64.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    return { valid: false, reason: 'Invalid challenge signature length' };
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    return { valid: false, reason: 'Malformed Base64 encoding for challenge signature' };
  }

  const sigBuf = Buffer.from(trimmed, 'base64');
  if (!isStrictDerEcdsaSignature(sigBuf)) {
    return { valid: false, reason: 'Malformed ASN.1 DER ECDSA signature encoding' };
  }

  try {
    const publicKey = createPublicKey({ key: params.publicKeyPem, format: 'pem', type: 'spki' });
    const ok = cryptoVerify(
      'sha256',
      params.transcriptBytes,
      { key: publicKey, dsaEncoding: 'der' },
      sigBuf,
    );
    return ok ? { valid: true } : { valid: false, reason: 'ECDSA signature verification failed' };
  } catch {
    return { valid: false, reason: 'Cryptographic signature verification failed' };
  }
}
