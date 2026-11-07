import { randomUUID } from 'node:crypto';

const SENSITIVE_KEY_PATTERN =
  /^(password|passwordHash|accessToken|refreshToken|plainTextSecret|apiSecret|secret|signingSecret|privateKey|privateKeyPem|deviceToken|enrollmentToken|encryptedApiToken|twoFactorSecret|authorization|x-api-key|codeVerifier)$/i;

const SENSITIVE_VALUE_PATTERN =
  /\b(bsk_live_[a-zA-Z0-9_]+|bsk_ref_[a-zA-Z0-9_]+|bsk_dev_[a-zA-Z0-9_]+|bsk_pair_[a-zA-Z0-9_]+|bsk_at_[a-zA-Z0-9_]+|bsk_rt_[a-zA-Z0-9_]+|whsec_[a-zA-Z0-9_]+|scrypt:[a-f0-9]+:[a-f0-9]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)\b/g;

/**
 * Deeply redacts sensitive credentials, tokens, passwords, and raw notification payloads from log objects.
 */
export function redactSensitiveData(input: unknown, depth: number = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    return input.replace(SENSITIVE_VALUE_PATTERN, '[REDACTED_SECRET]');
  }

  if (typeof input === 'bigint') {
    return input.toString();
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item, depth + 1));
  }

  if (input instanceof Error) {
    return {
      name: input.name,
      message: redactSensitiveData(input.message, depth + 1),
      code: (input as { code?: unknown }).code,
    };
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
      } else if (key === 'rawPayload' && typeof value === 'string') {
        out[key] = `[PROTECTED_PAYLOAD_LEN_${value.length}]`;
      } else {
        out[key] = redactSensitiveData(value, depth + 1);
      }
    }
    return out;
  }

  return input;
}

export interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  service: string;
  correlationId: string;
  organizationId?: string;
  message: string;
  context?: Record<string, unknown>;
}

export class StructuredLogger {
  private static recentLogs: LogEntry[] = [];
  private static maxRecentLogs = 500;

  constructor(private readonly service: string = 'brisksms-api') {}

  static getRecentLogs(): LogEntry[] {
    return [...StructuredLogger.recentLogs];
  }

  static clearRecentLogs(): void {
    StructuredLogger.recentLogs = [];
  }

  private emit(
    level: LogEntry['level'],
    message: string,
    meta?: { correlationId?: string; organizationId?: string; [key: string]: unknown },
  ): LogEntry {
    const { correlationId, organizationId, ...rest } = meta ?? {};
    const sanitizedContext = Object.keys(rest).length > 0
      ? (redactSensitiveData(rest) as Record<string, unknown>)
      : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      correlationId: correlationId || randomUUID(),
      ...(organizationId ? { organizationId } : {}),
      message: String(redactSensitiveData(message)),
      ...(sanitizedContext ? { context: sanitizedContext } : {}),
    };

    StructuredLogger.recentLogs.push(entry);
    if (StructuredLogger.recentLogs.length > StructuredLogger.maxRecentLogs) {
      StructuredLogger.recentLogs.shift();
    }

    if (process.env.BRISKSMS_SILENT_LOGS !== 'true' && level === 'ERROR') {
      process.stderr.write(JSON.stringify(entry) + '\n');
    }

    return entry;
  }

  info(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('INFO', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('WARN', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('ERROR', message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('DEBUG', message, meta);
  }
}

export function createLogger(service: string): StructuredLogger {
  return new StructuredLogger(service);
}

export const logger = new StructuredLogger('brisksms');
