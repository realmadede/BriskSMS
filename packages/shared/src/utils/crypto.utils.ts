import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Computes a deterministic SHA-256 deduplication hash for an incoming transaction
 * Invariant formula: SHA256(org_id + provider + provider_reference + amount_cents + timestamp)
 */
export function computeDeduplicationHash(
  organizationId: string,
  provider: string,
  reference: string,
  amountCents: number | bigint,
  timestamp: string | Date,
): string {
  const normalizedTime = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  const canonicalPayload = [
    organizationId.trim(),
    provider.trim().toUpperCase(),
    reference.trim().toUpperCase(),
    amountCents.toString(),
    normalizedTime,
  ].join('|');

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

/**
 * Computes HMAC-SHA256 signature for outgoing webhook payload
 */
export function computeWebhookSignature(secret: string, timestamp: number, payloadBody: string): string {
  const signedPayload = `${timestamp}.${payloadBody}`;
  return createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
}

/**
 * Constant-time signature verification to prevent timing attacks
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  payloadBody: string,
  expectedSignature: string,
): boolean {
  if (typeof expectedSignature !== 'string') {
    return false;
  }
  const cleanExpected = expectedSignature.trim();
  if (!/^[0-9a-f]{64}$/i.test(cleanExpected)) {
    return false;
  }

  const computedSignature = computeWebhookSignature(secret, timestamp, payloadBody);
  const computedBuffer = Buffer.from(computedSignature, 'hex');
  const expectedBuffer = Buffer.from(cleanExpected, 'hex');

  if (computedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(computedBuffer, expectedBuffer);
}

/**
 * Known insecure, development, and CI default keys that must NEVER be used in production.
 */
export const INSECURE_DEFAULT_KEYS = new Set([
  'brisksms_ci_encryption_master_key_32_bytes_min!',
  'brisksms_dev_encryption_master_key_32_bytes_min!',
  'dev_master_key_for_testing_only_1234567890',
  'test_encryption_master_key_32_bytes_long!!',
]);

function getMasterKeyBuffer(customKey?: string): Buffer {
  const isProd = process.env.NODE_ENV === 'production';
  const rawKey = customKey || process.env.ENCRYPTION_MASTER_KEY;
  if (!rawKey || typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new Error('Encryption failed: ENCRYPTION_MASTER_KEY is not configured or empty');
  }
  const trimmed = rawKey.trim();

  if (isProd) {
    if (
      INSECURE_DEFAULT_KEYS.has(trimmed) ||
      trimmed.toLowerCase().includes('ci_encryption') ||
      trimmed.toLowerCase().includes('dev_encryption')
    ) {
      throw new Error('Encryption failed: Insecure or test ENCRYPTION_MASTER_KEY detected in production');
    }
    if (trimmed.length < 32) {
      throw new Error('Encryption failed: ENCRYPTION_MASTER_KEY must be at least 32 characters in production');
    }
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return createHash('sha256').update(trimmed, 'utf8').digest();
}

/**
 * Encrypts a secret at rest using AES-256-GCM.
 * Output format: "aes-256-gcm:ivHex:tagHex:cipherHex"
 */
export function encryptSecret(plaintext: string, masterKey?: string): string {
  if (plaintext === undefined || plaintext === null) {
    throw new Error('Plaintext secret cannot be null or undefined');
  }
  const key = getMasterKeyBuffer(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes-256-gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted secret.
 */
export function decryptSecret(ciphertext: string, masterKey?: string): string {
  if (!ciphertext || typeof ciphertext !== 'string') {
    throw new Error('Ciphertext is required for decryption');
  }
  const key = getMasterKeyBuffer(masterKey);
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'aes-256-gcm') {
    throw new Error('Invalid ciphertext format for AES-256-GCM');
  }
  const iv = Buffer.from(parts[1]!, 'hex');
  const tag = Buffer.from(parts[2]!, 'hex');
  const encrypted = Buffer.from(parts[3]!, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Checks whether a given string is formatted as an AES-256-GCM encrypted secret.
 */
export function isEncryptedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === 'aes-256-gcm' && parts[1]!.length === 24 && parts[2]!.length === 32;
}

/**
 * Masks sensitive secret values for safe display/audit without leaking full material.
 */
export function maskSecret(value: string): string {
  if (!value) return '********';
  if (value.length <= 12) return `${value.slice(0, 2)}******`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export interface OutboundUrlValidationOptions {
  allowPrivateEnvVar?: string;
  allowHttpInProd?: boolean;
  label?: string;
}

/**
 * Validates outbound HTTP(S) destinations against SSRF (loopback, metadata, RFC1918, ULA, and embedded credentials).
 */
export function validateOutboundHttpUrl(
  rawUrl: string,
  options: OutboundUrlValidationOptions = {},
): URL {
  const label = options.label ?? 'Outbound URL';
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error(`${label} is required`);
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Malformed ${label}: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid ${label} scheme "${parsed.protocol}". Only HTTP and HTTPS are permitted.`);
  }

  if (process.env.NODE_ENV === 'production' && !options.allowHttpInProd && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use https:// in production`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivateAllowed =
    Boolean(options.allowPrivateEnvVar) && process.env[options.allowPrivateEnvVar!] === 'true';

  if (isProhibitedNetworkDestination(host) && !isPrivateAllowed) {
    throw new Error(
      `${label} resolves to prohibited internal or private network destination: "${host}". Only public internet endpoints are permitted.`,
    );
  }

  return parsed;
}

/**
 * Checks whether an IP address or literal hostname belongs to loopback, link-local,
 * cloud metadata, CGNAT, ULA/private, or unspecified network ranges, including
 * canonicalized hex IPv4-mapped IPv6 forms (e.g. `::ffff:7f00:1`).
 */
export function isProhibitedNetworkDestination(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0] ?? '';

  if (!host) return true;

  // Canonicalize IPv4-mapped IPv6 forms: `::ffff:7f00:1`, `::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1`
  const mappedHexMatch = host.match(/^(?:0:0:0:0:0:|::)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHexMatch) {
    const hi = parseInt(mappedHexMatch[1]!, 16);
    const lo = parseInt(mappedHexMatch[2]!, 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isProhibitedNetworkDestination(ipv4);
  }
  const mappedDottedMatch = host.match(/^(?:0:0:0:0:0:|::)ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedDottedMatch) {
    return isProhibitedNetworkDestination(mappedDottedMatch[1]!);
  }

  const isLoopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    /^0\.\d+\.\d+\.\d+$/.test(host) ||
    host === '::' ||
    host === '::1' ||
    /^0+:0+:0+:0+:0+:0+:0+:[01]$/.test(host) ||
    /^127\.\d+\.\d+\.\d+$/.test(host);

  const isLinkLocalOrMetadata =
    host.startsWith('169.254.') ||
    /^fe[89ab][0-9a-f]:/i.test(host) ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host === 'instance-data';

  const isPrivateIpv4 =
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host);

  const isPrivateOrReservedIpv6 =
    /^f[cd][0-9a-f]{2}:/i.test(host) || /^ff[0-9a-f]{2}:/i.test(host);

  return isLoopback || isLinkLocalOrMetadata || isPrivateIpv4 || isPrivateOrReservedIpv6;
}

/**
 * Performs synchronous SSRF URL validation plus asynchronous DNS resolution check
 * to block domain names (e.g. split-horizon DNS or *.nip.io) that resolve to private/reserved IPs.
 */
export async function validateResolvedOutboundUrl(
  rawUrl: string,
  options: OutboundUrlValidationOptions = {},
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<URL> {
  const parsed = validateOutboundHttpUrl(rawUrl, options);
  const label = options.label ?? 'URL';
  const isPrivateAllowed =
    Boolean(options.allowPrivateEnvVar) && process.env[options.allowPrivateEnvVar!] === 'true';

  if (isPrivateAllowed) {
    return parsed;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const { isIP } = await import('node:net');
  if (isIP(host) !== 0) {
    return parsed;
  }

  let records: Array<{ address: string; family: number }> = [];
  try {
    if (dnsLookup) {
      records = await dnsLookup(host);
    } else {
      const { lookup } = await import('node:dns/promises');
      records = await lookup(host, { all: true, verbatim: true });
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') {
      return parsed;
    }
    throw err;
  }

  for (const rec of records) {
    if (isProhibitedNetworkDestination(rec.address)) {
      throw new Error(
        `${label} hostname "${host}" resolves via DNS to prohibited internal or private IP address "${rec.address}".`,
      );
    }
  }

  return parsed;
}

