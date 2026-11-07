import { existsSync } from 'node:fs';

/**
 * Tenant-scoped database query context
 */
export interface TenantContext {
  organizationId: string;
  userId?: string;
}

/**
 * Validates that an operation possesses a valid organizationId context
 */
export function assertTenantContext(context: unknown): asserts context is TenantContext {
  if (
    !context ||
    typeof context !== 'object' ||
    !('organizationId' in context) ||
    typeof (context as { organizationId: unknown }).organizationId !== 'string' ||
    !(context as { organizationId: string }).organizationId.trim()
  ) {
    throw new Error('TenantContext violation: organizationId is required for this operation.');
  }
}

/**
 * Operational error thrown when PostgreSQL is unreachable or unavailable.
 * The system NEVER falls back to in-memory persistence when PostgreSQL is down.
 */
export class DatabaseUnavailableError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'DATABASE_UNAVAILABLE';

  constructor(message: string = 'PostgreSQL database is currently unavailable.', public readonly cause?: unknown) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

export type SqlRow = Record<string, any>;

export interface SqlExecutor {
  <T extends SqlRow = SqlRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  unsafe<T extends SqlRow = SqlRow>(query: string, values?: unknown[]): Promise<T[]>;
}

export interface SqlPool extends SqlExecutor {
  begin<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface BunSqlConstructor {
  new (options: Record<string, unknown> | string): SqlPool;
}

function getBunSql(): BunSqlConstructor {
  const g = globalThis as unknown as { Bun?: { SQL?: BunSqlConstructor } };
  if (!g.Bun?.SQL) {
    throw new DatabaseUnavailableError('Bun.SQL PostgreSQL driver is required in the runtime environment.');
  }
  return g.Bun.SQL;
}

export interface ResolvedDbConnectionConfig {
  mode: 'unix' | 'tcp';
  options: Record<string, unknown>;
  database: string;
}

/**
 * Resolves PostgreSQL connection options from DATABASE_URL or PG* environment variables.
 * Supports standard TCP (postgresql://user:pass@host:port/db) and local Unix sockets (/tmp/brisksms-pg).
 */
export function resolveDbConnectionConfig(customDatabaseUrl?: string): ResolvedDbConnectionConfig {
  const rawUrl =
    customDatabaseUrl ??
    process.env.DATABASE_URL ??
    'postgresql://brisksms:brisksms_dev_secret@localhost:5432/brisksms_dev?schema=public';

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DatabaseUnavailableError(`Invalid DATABASE_URL format: ${rawUrl}`);
  }

  const database = parsed.pathname.replace(/^\//, '') || 'brisksms_dev';
  const username = decodeURIComponent(parsed.username || process.env.PGUSER || 'brisksms');
  const password = decodeURIComponent(parsed.password || process.env.PGPASSWORD || '');
  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  const hostParam = parsed.searchParams.get('host') || process.env.PGHOST;

  // Explicit Unix socket path via ?host=/path or PGHOST=/path
  if (hostParam && hostParam.startsWith('/')) {
    const socketFile = hostParam.includes('.s.PGSQL.')
      ? hostParam
      : `${hostParam.replace(/\/$/, '')}/.s.PGSQL.${port}`;
    return {
      mode: 'unix',
      database,
      options: {
        path: socketFile,
        username,
        password: password || undefined,
        database,
        max: 15,
        idleTimeout: 30,
      },
    };
  }

  // Automatic local Unix socket detection when localhost is specified and /tmp/brisksms-pg socket exists
  const defaultLocalSocket = `/tmp/brisksms-pg/.s.PGSQL.${port}`;
  if (
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
    process.env.FORCE_TCP_POSTGRES !== 'true' &&
    existsSync(defaultLocalSocket)
  ) {
    return {
      mode: 'unix',
      database,
      options: {
        path: defaultLocalSocket,
        username,
        password: password || undefined,
        database,
        max: 15,
        idleTimeout: 30,
      },
    };
  }

  return {
    mode: 'tcp',
    database,
    options: {
      hostname: parsed.hostname || 'localhost',
      port,
      username,
      password: password || undefined,
      database,
      max: 15,
      idleTimeout: 30,
    },
  };
}

let activePool: SqlPool | null = null;
let activePoolUrl: string | undefined;
const DB_OUTAGE_KEY = '__BRISK_SIMULATE_DB_DOWN__';

/**
 * Test helper to simulate PostgreSQL connection loss without killing the shared daemon
 */
export function setSimulatedDatabaseOutage(isDown: boolean): void {
  (globalThis as Record<string, unknown>)[DB_OUTAGE_KEY] = isDown;
}

export function isSimulatedDatabaseOutage(): boolean {
  return Boolean((globalThis as Record<string, unknown>)[DB_OUTAGE_KEY]);
}

/**
 * Returns the singleton PostgreSQL connection pool.
 */
export function getDbPool(customDatabaseUrl?: string): SqlPool {
  if (isSimulatedDatabaseOutage()) {
    throw new DatabaseUnavailableError('PostgreSQL connection refused (simulated outage).');
  }
  const targetUrl = customDatabaseUrl ?? process.env.DATABASE_URL;
  if (!activePool || (customDatabaseUrl && activePoolUrl !== targetUrl)) {
    const SQL = getBunSql();
    const resolved = resolveDbConnectionConfig(targetUrl);
    activePool = new SQL(resolved.options);
    activePoolUrl = targetUrl;
  }
  return activePool;
}

/**
 * Closes and resets the active PostgreSQL connection pool.
 */
export async function closeDbPool(): Promise<void> {
  if (activePool) {
    try {
      await activePool.close();
    } finally {
      activePool = null;
      activePoolUrl = undefined;
    }
  }
}

function isConnectionError(err: unknown): boolean {
  if (err instanceof DatabaseUnavailableError) return true;
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code ?? '';
  const msg = (err as { message?: string }).message ?? '';
  return (
    code === 'ERR_POSTGRES_CONNECTION_REFUSED' ||
    code === 'ERR_POSTGRES_CONNECTION_CLOSED' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOENT' ||
    msg.includes('Failed to connect') ||
    msg.includes('Connection closed') ||
    msg.includes('connection refused')
  );
}

/**
 * Executes a parameterized query against PostgreSQL.
 * Wraps connection errors in DatabaseUnavailableError (no silent fallback to memory).
 */
export const db: SqlPool = {
  async apply(_target: unknown, _thisArg: unknown, argArray: [TemplateStringsArray, ...unknown[]]) {
    const pool = getDbPool();
    try {
      return await pool(argArray[0], ...argArray.slice(1));
    } catch (err) {
      if (isConnectionError(err)) {
        throw new DatabaseUnavailableError('Failed to connect to PostgreSQL database.', err);
      }
      throw err;
    }
  },
} as unknown as SqlPool;

/**
 * Tagged template SQL query executor against the authoritative PostgreSQL database.
 */
export async function sql<T extends SqlRow = SqlRow>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  const pool = getDbPool();
  try {
    return await pool<T>(strings, ...values);
  } catch (err) {
    if (isConnectionError(err)) {
      throw new DatabaseUnavailableError('Failed to connect to PostgreSQL database.', err);
    }
    throw err;
  }
}

/**
 * Executes raw SQL (DDL / migrations) against PostgreSQL.
 */
export async function sqlUnsafe<T extends SqlRow = SqlRow>(
  query: string,
  values?: unknown[],
): Promise<T[]> {
  const pool = getDbPool();
  try {
    return await pool.unsafe<T>(query, values);
  } catch (err) {
    if (isConnectionError(err)) {
      throw new DatabaseUnavailableError('Failed to connect to PostgreSQL database.', err);
    }
    throw err;
  }
}

/**
 * Executes a callback inside an explicit ACID PostgreSQL transaction (BEGIN ... COMMIT / ROLLBACK).
 * Supports nested transaction reuse if a transaction executor `tx` is already provided.
 */
export async function withTransaction<T>(
  fn: (tx: SqlExecutor) => Promise<T>,
  existingTx?: SqlExecutor,
): Promise<T> {
  if (existingTx) {
    return fn(existingTx);
  }
  const pool = getDbPool();
  try {
    return await pool.begin(async (tx) => {
      return await fn(tx);
    });
  } catch (err) {
    if (isConnectionError(err)) {
      throw new DatabaseUnavailableError('PostgreSQL transaction failed due to database unavailability.', err);
    }
    throw err;
  }
}

export interface DatabaseHealthStatus {
  status: 'UP' | 'DOWN';
  latencyMs: number;
  error?: string;
}

/**
 * Verifies live PostgreSQL connectivity via `SELECT 1`.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealthStatus> {
  const start = Date.now();
  try {
    const rows = await sql<{ ok: number }>`SELECT 1 AS ok`;
    if (rows[0]?.ok === 1) {
      return {
        status: 'UP',
        latencyMs: Date.now() - start,
      };
    }
    return {
      status: 'DOWN',
      latencyMs: Date.now() - start,
      error: 'Unexpected response from PostgreSQL health query',
    };
  } catch (err) {
    return {
      status: 'DOWN',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown database error',
    };
  }
}
