import net from 'node:net';
import { existsSync } from 'node:fs';

export class RedisUnavailableError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'REDIS_UNAVAILABLE';

  constructor(message: string = 'Redis queue broker is currently unavailable.', public override readonly cause?: unknown) {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

export type RespValue = string | number | null | RespValue[];

export interface ResolvedRedisConfig {
  mode: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

export function resolveRedisConfig(customUrl?: string): ResolvedRedisConfig {
  const rawUrl = customUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const socketEnv = process.env.REDIS_SOCKET_PATH;

  if (socketEnv) {
    return { mode: 'unix', socketPath: socketEnv };
  }

  if (rawUrl.startsWith('unix:') || rawUrl.startsWith('/')) {
    return { mode: 'unix', socketPath: rawUrl.replace(/^unix:(\/\/)?/, '') };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RedisUnavailableError(`Invalid REDIS_URL: ${rawUrl}`);
  }

  const defaultUnixSocket = '/tmp/brisksms-redis/redis.sock';
  if (
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
    process.env.FORCE_TCP_REDIS !== 'true' &&
    existsSync(defaultUnixSocket)
  ) {
    return { mode: 'unix', socketPath: defaultUnixSocket };
  }

  return {
    mode: 'tcp',
    host: parsed.hostname || 'localhost',
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: parsed.pathname && parsed.pathname !== '/' ? parseInt(parsed.pathname.slice(1), 10) : 0,
  };
}

const REDIS_OUTAGE_KEY = '__BRISK_SIMULATE_REDIS_DOWN__';

export function setSimulatedRedisOutage(isDown: boolean): void {
  (globalThis as Record<string, unknown>)[REDIS_OUTAGE_KEY] = isDown;
}

export function isSimulatedRedisOutage(): boolean {
  return Boolean((globalThis as Record<string, unknown>)[REDIS_OUTAGE_KEY]);
}

function encodeRespCommand(args: Array<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'utf8')];
  for (const arg of args) {
    const str = String(arg);
    const byteBuf = Buffer.from(str, 'utf8');
    parts.push(Buffer.from(`$${byteBuf.length}\r\n`, 'utf8'));
    parts.push(byteBuf);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

interface ParseResult {
  value: RespValue;
  bytesConsumed: number;
  isError?: boolean;
}

function parseRespBuffer(buf: Buffer, offset: number = 0): ParseResult | null {
  if ( offset >= buf.length ) return null;
  const prefix = String.fromCharCode(buf[offset]!);
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;

  const headerPayload = buf.subarray(offset + 1, lineEnd).toString('utf8');

  if (prefix === '+') {
    return { value: headerPayload, bytesConsumed: lineEnd + 2 - offset };
  }
  if (prefix === '-') {
    return { value: headerPayload, bytesConsumed: lineEnd + 2 - offset, isError: true };
  }
  if (prefix === ':') {
    return { value: parseInt(headerPayload, 10), bytesConsumed: lineEnd + 2 - offset };
  }
  if (prefix === '$') {
    const len = parseInt(headerPayload, 10);
    if (len === -1) {
      return { value: null, bytesConsumed: lineEnd + 2 - offset };
    }
    const bodyStart = lineEnd + 2;
    const bodyEnd = bodyStart + len;
    if (buf.length < bodyEnd + 2) return null;
    const val = buf.subarray(bodyStart, bodyEnd).toString('utf8');
    return { value: val, bytesConsumed: bodyEnd + 2 - offset };
  }
  if (prefix === '*') {
    const count = parseInt(headerPayload, 10);
    if (count === -1) {
      return { value: null, bytesConsumed: lineEnd + 2 - offset };
    }
    const arr: RespValue[] = [];
    let cursor = lineEnd + 2;
    for (let i = 0; i < count; i++) {
      const elem = parseRespBuffer(buf, cursor);
      if (!elem) return null;
      if (elem.isError) {
        return { value: elem.value, bytesConsumed: cursor + elem.bytesConsumed - offset, isError: true };
      }
      arr.push(elem.value);
      cursor += elem.bytesConsumed;
    }
    return { value: arr, bytesConsumed: cursor - offset };
  }

  return null;
}

export class BriskRedisClient {
  private socket: net.Socket | null = null;
  private connectingPromise: Promise<net.Socket> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingQueue: Array<{
    resolve: (val: RespValue) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(private readonly customUrl?: string) {}

  private async getSocket(): Promise<net.Socket> {
    if (isSimulatedRedisOutage()) {
      throw new RedisUnavailableError('Redis connection refused (simulated outage).');
    }
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = new Promise<net.Socket>((resolve, reject) => {
      let cfg: ResolvedRedisConfig;
      try {
        cfg = resolveRedisConfig(this.customUrl);
      } catch (err) {
        this.connectingPromise = null;
        return reject(err);
      }

      const sock =
        cfg.mode === 'unix'
          ? net.createConnection({ path: cfg.socketPath! })
          : net.createConnection({ host: cfg.host!, port: cfg.port! });

      const onError = (err: Error) => {
        sock.destroy();
        if (this.socket === sock) {
          this.socket = null;
        }
        this.connectingPromise = null;
        const wrapped = new RedisUnavailableError(`Redis connection error: ${err.message}`, err);
        while (this.pendingQueue.length > 0) {
          this.pendingQueue.shift()!.reject(wrapped);
        }
        reject(wrapped);
      };

      sock.once('error', onError);

      sock.once('connect', () => {
        sock.removeListener('error', onError);
        sock.on('error', (err) => {
          const wrapped = new RedisUnavailableError(`Redis socket error: ${err.message}`, err);
          while (this.pendingQueue.length > 0) {
            this.pendingQueue.shift()!.reject(wrapped);
          }
          sock.destroy();
          if (this.socket === sock) this.socket = null;
        });

        sock.on('close', () => {
          if (this.socket === sock) this.socket = null;
          const wrapped = new RedisUnavailableError('Redis connection closed unexpectedly.');
          while (this.pendingQueue.length > 0) {
            this.pendingQueue.shift()!.reject(wrapped);
          }
        });

        sock.on('data', (chunk: Buffer) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          while (this.pendingQueue.length > 0) {
            const parsed = parseRespBuffer(this.buffer, 0);
            if (!parsed) break;
            this.buffer = this.buffer.subarray(parsed.bytesConsumed);
            const waiter = this.pendingQueue.shift()!;
            if (parsed.isError) {
              waiter.reject(new Error(String(parsed.value)));
            } else {
              waiter.resolve(parsed.value);
            }
          }
        });

        this.socket = sock;
        this.connectingPromise = null;
        resolve(sock);
      });
    });

    return this.connectingPromise;
  }

  async sendCommand<T = RespValue>(...args: Array<string | number>): Promise<T> {
    const sock = await this.getSocket();
    return new Promise<T>((resolve, reject) => {
      this.pendingQueue.push({
        resolve: (val) => resolve(val as unknown as T),
        reject,
      });
      sock.write(encodeRespCommand(args));
    });
  }

  async ping(): Promise<string> {
    return this.sendCommand<string>('PING');
  }

  async get(key: string): Promise<string | null> {
    return this.sendCommand<string | null>('GET', key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<string> {
    if (ttlSeconds !== undefined) {
      return this.sendCommand<string>('SET', key, value, 'EX', ttlSeconds);
    }
    return this.sendCommand<string>('SET', key, value);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.sendCommand<number>('DEL', ...keys);
  }

  async hset(key: string, fieldValues: Record<string, string | number>): Promise<number> {
    const args: Array<string | number> = ['HSET', key];
    for (const [k, v] of Object.entries(fieldValues)) {
      args.push(k, String(v));
    }
    return this.sendCommand<number>(...args);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.sendCommand<string | null>('HGET', key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const arr = await this.sendCommand<string[] | null>('HGETALL', key);
    const out: Record<string, string> = {};
    if (!arr) return out;
    for (let i = 0; i < arr.length; i += 2) {
      out[arr[i]!] = arr[i + 1] ?? '';
    }
    return out;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.sendCommand<number>('LPUSH', key, ...values);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.sendCommand<number>('RPUSH', key, ...values);
  }

  async lpop(key: string): Promise<string | null> {
    return this.sendCommand<string | null>('LPOP', key);
  }

  async rpop(key: string): Promise<string | null> {
    return this.sendCommand<string | null>('RPOP', key);
  }

  async llen(key: string): Promise<number> {
    return this.sendCommand<number>('LLEN', key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return (await this.sendCommand<string[]>('LRANGE', key, start, stop)) ?? [];
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.sendCommand<number>('ZADD', key, score, member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.sendCommand<number>('ZREM', key, ...members);
  }

  async zcard(key: string): Promise<number> {
    return this.sendCommand<number>('ZCARD', key);
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    return (await this.sendCommand<string[]>('ZRANGEBYSCORE', key, min, max)) ?? [];
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.sendCommand<number>('SADD', key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.sendCommand<number>('SREM', key, ...members);
  }

  async scard(key: string): Promise<number> {
    return this.sendCommand<number>('SCARD', key);
  }

  async smembers(key: string): Promise<string[]> {
    return (await this.sendCommand<string[]>('SMEMBERS', key)) ?? [];
  }

  async eval<T = RespValue>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
    return this.sendCommand<T>('EVAL', script, keys.length, ...keys, ...args);
  }

  async keys(pattern: string): Promise<string[]> {
    return (await this.sendCommand<string[]>('KEYS', pattern)) ?? [];
  }

  async flushdb(): Promise<string> {
    return this.sendCommand<string>('FLUSHDB');
  }

  async flushDb(): Promise<string> {
    return this.flushdb();
  }

  async quit(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.sendCommand('QUIT');
      } catch {
        // ignore close error
      } finally {
        this.socket.destroy();
        this.socket = null;
      }
    }
  }
}

export const redisClient = new BriskRedisClient();

export function getRedisClient(): BriskRedisClient {
  return redisClient;
}

export async function closeRedisClient(): Promise<void> {
  await redisClient.quit();
}

export interface RedisHealthStatus {
  status: 'UP' | 'DOWN';
  latencyMs: number;
  error?: string;
}

export async function checkRedisHealth(): Promise<RedisHealthStatus> {
  const start = Date.now();
  try {
    const reply = await redisClient.ping();
    if (reply === 'PONG') {
      return { status: 'UP', latencyMs: Date.now() - start };
    }
    return { status: 'DOWN', latencyMs: Date.now() - start, error: `Unexpected Redis PING response: ${reply}` };
  } catch (err) {
    return {
      status: 'DOWN',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown Redis error',
    };
  }
}

export interface WorkerHeartbeatInfo {
  workerId: string;
  queues: string[];
  pid: number;
  updatedAt: string;
}

export async function recordWorkerHeartbeat(workerId: string, queues: string[], ttlSeconds: number = 30): Promise<void> {
  const payload: WorkerHeartbeatInfo = {
    workerId,
    queues,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  await redisClient.set(`brisk:worker:heartbeat:${workerId}`, JSON.stringify(payload), ttlSeconds);
}

export async function removeWorkerHeartbeat(workerId: string): Promise<void> {
  await redisClient.del(`brisk:worker:heartbeat:${workerId}`);
}

export async function checkWorkerHealth(): Promise<{
  status: 'UP' | 'DEGRADED' | 'DOWN';
  activeWorkers: WorkerHeartbeatInfo[];
  error?: string;
}> {
  try {
    const keys = await redisClient.keys('brisk:worker:heartbeat:*');
    const activeWorkers: WorkerHeartbeatInfo[] = [];
    for (const k of keys) {
      const raw = await redisClient.get(k);
      if (raw) {
        try {
          activeWorkers.push(JSON.parse(raw) as WorkerHeartbeatInfo);
        } catch {
          // ignore malformed entry
        }
      }
    }
    return {
      status: activeWorkers.length > 0 ? 'UP' : 'DEGRADED',
      activeWorkers,
    };
  } catch (err) {
    return {
      status: 'DOWN',
      activeWorkers: [],
      error: err instanceof Error ? err.message : 'Unable to query worker heartbeats',
    };
  }
}
