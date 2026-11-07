import { randomUUID } from 'node:crypto';
import { assertTenantContext } from './client.js';
import { BriskRedisClient, redisClient } from './redis.js';
import { StructuredLogger } from './logger.js';

export type BullJobStatus = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'dead-letter';

export interface BullBackoffOptions {
  type: 'exponential' | 'fixed';
  delay: number;
}

export interface BullJobOptions {
  jobId?: string;
  attempts?: number;
  backoff?: BullBackoffOptions;
  backoffMs?: number;
  delay?: number;
  timeoutMs?: number;
  requireOrganizationContext?: boolean;
  correlationId?: string;
}

export interface BullJobData {
  organizationId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

export interface BullJob<T extends BullJobData = BullJobData> {
  id: string;
  name: string;
  queueName: string;
  data: T;
  opts: Required<Omit<BullJobOptions, 'jobId' | 'correlationId'>> & { correlationId: string };
  status: BullJobStatus;
  attemptsMade: number;
  failedReason?: string;
  returnvalue?: unknown;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
}

const FORBIDDEN_JOB_SECRET_KEYS =
  /^(password|passwordHash|accessToken|refreshToken|plainTextSecret|apiSecret|signingSecret|privateKey|privateKeyPem|deviceToken|encryptedApiToken)$/i;

/**
 * Ensures no sensitive credentials or private keys are serialized into Redis job payloads.
 */
function assertNoSensitiveCredentialsInPayload(payload: unknown, path: string = 'data'): void {
  if (!payload || typeof payload !== 'object') return;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_JOB_SECRET_KEYS.test(k)) {
      throw new Error(`SECURITY_VIOLATION: Sensitive credential field '${path}.${k}' is forbidden in background job payloads.`);
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      assertNoSensitiveCredentialsInPayload(v, `${path}.${k}`);
    }
  }
}

export interface QueueJobCounts {
  waiting: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  deadLetter: number;
}

/**
 * Redis-backed BullMQ-compatible Queue with atomic Lua scripts, idempotency,
 * delayed scheduling, and Dead-Letter Queue (DLQ) visibility.
 */
export class BullQueue<T extends BullJobData = BullJobData> {
  private readonly prefix: string;
  private readonly logger: StructuredLogger;

  constructor(
    public readonly name: string,
    private readonly redis: BriskRedisClient = redisClient,
  ) {
    this.prefix = `bull:${name}`;
    this.logger = new StructuredLogger(`queue:${name}`);
  }

  private key(suffix: string): string {
    return `${this.prefix}:${suffix}`;
  }

  /**
   * Enqueues a job idempotently into Redis.
   * If a job with the same `jobId` already exists in waiting/delayed/active/completed state,
   * returns the existing job without duplicating execution.
   */
  async add(jobName: string, data: T, opts: BullJobOptions = {}): Promise<BullJob<T>> {
    assertNoSensitiveCredentialsInPayload(data);

    const requireOrg = opts.requireOrganizationContext ?? true;
    if (requireOrg) {
      assertTenantContext(data);
    }

    const jobId = opts.jobId || randomUUID();
    const correlationId = opts.correlationId || (typeof data.correlationId === 'string' ? data.correlationId : randomUUID());
    const now = Date.now();
    const delay = Math.max(0, opts.delay ?? 0);

    const normalizedOpts = {
      attempts: Math.max(1, opts.attempts ?? 3),
      backoff: opts.backoff ?? { type: 'exponential' as const, delay: opts.backoffMs ?? 200 },
      delay,
      timeoutMs: opts.timeoutMs ?? 15000,
      requireOrganizationContext: requireOrg,
      correlationId,
    };

    const jobKey = this.key(`job:${jobId}`);
    const waitKey = this.key('wait');
    const delayedKey = this.key('delayed');
    const initialStatus: BullJobStatus = delay > 0 ? 'delayed' : 'waiting';

    // Atomic Lua script for idempotent job insertion
    const luaAdd = `
      local jobKey = KEYS[1]
      local waitKey = KEYS[2]
      local delayedKey = KEYS[3]
      local existingStatus = redis.call('HGET', jobKey, 'status')
      if existingStatus and existingStatus ~= 'dead-letter' and existingStatus ~= 'failed' then
        return 0
      end
      redis.call('HSET', jobKey,
        'id', ARGV[1],
        'name', ARGV[2],
        'queueName', ARGV[3],
        'data', ARGV[4],
        'opts', ARGV[5],
        'status', ARGV[6],
        'attemptsMade', '0',
        'timestamp', ARGV[7],
        'failedReason', ''
      )
      if tonumber(ARGV[8]) > 0 then
        redis.call('ZADD', delayedKey, tonumber(ARGV[7]) + tonumber(ARGV[8]), ARGV[1])
      else
        redis.call('RPUSH', waitKey, ARGV[1])
      end
      return 1
    `;

    const inserted = await this.redis.eval<number>(
      luaAdd,
      [jobKey, waitKey, delayedKey],
      [
        jobId,
        jobName,
        this.name,
        JSON.stringify({ ...data, correlationId }),
        JSON.stringify(normalizedOpts),
        initialStatus,
        now,
        delay,
      ],
    );

    if (inserted === 0) {
      const existing = await this.getJob(jobId);
      if (existing) {
        this.logger.debug('Deduplicated idempotent job enqueue', {
          correlationId,
          organizationId: data.organizationId,
          jobId,
          existingStatus: existing.status,
        });
        return existing;
      }
    }

    this.logger.info('Enqueued background job', {
      correlationId,
      organizationId: data.organizationId,
      jobId,
      jobName,
      status: initialStatus,
      delay,
    });

    return {
      id: jobId,
      name: jobName,
      queueName: this.name,
      data: { ...data, correlationId },
      opts: normalizedOpts,
      status: initialStatus,
      attemptsMade: 0,
      timestamp: now,
    };
  }

  /**
   * Retrieves a job by ID from Redis.
   */
  async getJob(jobId: string): Promise<BullJob<T> | null> {
    const raw = await this.redis.hgetall(this.key(`job:${jobId}`));
    if (!raw || !raw.id) return null;

    return {
      id: raw.id,
      name: raw.name || 'default',
      queueName: raw.queueName || this.name,
      data: JSON.parse(raw.data || '{}') as T,
      opts: JSON.parse(raw.opts || '{}'),
      status: (raw.status as BullJobStatus) || 'waiting',
      attemptsMade: parseInt(raw.attemptsMade || '0', 10),
      failedReason: raw.failedReason || undefined,
      returnvalue: raw.returnvalue ? JSON.parse(raw.returnvalue) : undefined,
      timestamp: parseInt(raw.timestamp || '0', 10),
      processedOn: raw.processedOn ? parseInt(raw.processedOn, 10) : undefined,
      finishedOn: raw.finishedOn ? parseInt(raw.finishedOn, 10) : undefined,
    };
  }

  /**
   * Promotes due delayed jobs into the waiting queue atomically.
   */
  async promoteDelayedJobs(nowMs: number = Date.now()): Promise<number> {
    const luaPromote = `
      local delayedKey = KEYS[1]
      local waitKey = KEYS[2]
      local prefix = ARGV[1]
      local now = tonumber(ARGV[2])
      local due = redis.call('ZRANGEBYSCORE', delayedKey, '-inf', now)
      for _, jobId in ipairs(due) do
        redis.call('ZREM', delayedKey, jobId)
        redis.call('HSET', prefix .. ':job:' .. jobId, 'status', 'waiting')
        redis.call('RPUSH', waitKey, jobId)
      end
      return #due
    `;
    return this.redis.eval<number>(
      luaPromote,
      [this.key('delayed'), this.key('wait')],
      [this.prefix, nowMs],
    );
  }

  /**
   * Recovers stalled jobs from the active set whose lock has expired.
   */
  async recoverStalledJobs(nowMs: number = Date.now()): Promise<number> {
    const activeJobIds = await this.redis.smembers(this.key('active'));
    let recovered = 0;

    for (const jobId of activeJobIds) {
      const lockUntilStr = await this.redis.hget(this.key(`job:${jobId}`), 'lockUntil');
      const lockUntil = lockUntilStr ? parseInt(lockUntilStr, 10) : 0;
      if (lockUntil > 0 && lockUntil <= nowMs) {
        const job = await this.getJob(jobId);
        if (!job) {
          await this.redis.srem(this.key('active'), jobId);
          continue;
        }
        await this.redis.srem(this.key('active'), jobId);
        if (job.attemptsMade >= job.opts.attempts) {
          await this.redis.hset(this.key(`job:${jobId}`), {
            status: 'dead-letter',
            failedReason: 'STALLED_JOB_MAX_ATTEMPTS_EXCEEDED',
            finishedOn: nowMs,
          });
          await this.redis.sadd(this.key('dlq'), jobId);
        } else {
          await this.redis.hset(this.key(`job:${jobId}`), {
            status: 'waiting',
            lockUntil: 0,
          });
          await this.redis.lpush(this.key('wait'), jobId);
        }
        recovered++;
      }
    }

    return recovered;
  }

  /**
   * Returns operational counts across all job lifecycle states.
   */
  async getJobCounts(): Promise<QueueJobCounts> {
    const [waiting, delayed, active, completed, failed, deadLetter] = await Promise.all([
      this.redis.llen(this.key('wait')),
      this.redis.zcard(this.key('delayed')),
      this.redis.scard(this.key('active')),
      this.redis.scard(this.key('completed')),
      this.redis.scard(this.key('failed')),
      this.redis.scard(this.key('dlq')),
    ]);
    return { waiting, delayed, active, completed, failed, deadLetter };
  }

  async getCounts(): Promise<QueueJobCounts> {
    return this.getJobCounts();
  }

  /**
   * Returns all jobs currently in the Dead-Letter Queue (terminal failures).
   */
  async getDeadLetterJobs(): Promise<BullJob<T>[]> {
    const ids = await this.redis.smembers(this.key('dlq'));
    const jobs: BullJob<T>[] = [];
    for (const id of ids) {
      const j = await this.getJob(id);
      if (j) jobs.push(j);
    }
    return jobs;
  }

  /**
   * Clears all keys for this queue (used in tests).
   */
  async obliterate(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}:*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

export interface BullWorkerOptions {
  concurrency?: number;
  lockDurationMs?: number;
  pollIntervalMs?: number;
  autorun?: boolean;
}

export type BullProcessor<T extends BullJobData = BullJobData, R = unknown> = (
  job: BullJob<T>,
) => Promise<R>;

/**
 * Redis-backed BullMQ-compatible Worker with concurrency controls, timeouts,
 * exponential backoff retries, organization context validation, and graceful shutdown.
 */
export class BullWorker<T extends BullJobData = BullJobData, R = unknown> {
  private readonly prefix: string;
  private readonly logger: StructuredLogger;
  private readonly concurrency: number;
  private readonly lockDurationMs: number;
  private readonly pollIntervalMs: number;
  private isRunning = false;
  private isClosing = false;
  private activeCount = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activePromises = new Set<Promise<void>>();

  constructor(
    public readonly queueName: string,
    private readonly processor: BullProcessor<T, R>,
    opts: BullWorkerOptions = {},
    private readonly redis: BriskRedisClient = redisClient,
  ) {
    this.prefix = `bull:${queueName}`;
    this.logger = new StructuredLogger(`worker:${queueName}`);
    this.concurrency = Math.max(1, opts.concurrency ?? 5);
    this.lockDurationMs = opts.lockDurationMs ?? 30000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;

    if (opts.autorun === true) {
      this.start();
    }
  }

  private key(suffix: string): string {
    return `${this.prefix}:${suffix}`;
  }

  start(): void {
    if (this.isRunning || this.isClosing) return;
    this.isRunning = true;
    this.scheduleNextTick(0);
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.isRunning || this.isClosing) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.isRunning || this.isClosing) return;

    try {
      const queue = new BullQueue<T>(this.queueName, this.redis);
      await queue.promoteDelayedJobs();
      await queue.recoverStalledJobs();

      while (this.activeCount < this.concurrency && !this.isClosing) {
        const claimed = await this.claimNextJob();
        if (!claimed) break;

        this.activeCount++;
        const execPromise = this.executeJob(claimed).finally(() => {
          this.activeCount--;
          this.activePromises.delete(execPromise);
        });
        this.activePromises.add(execPromise);
      }
    } catch (err) {
      this.logger.warn('Worker poll cycle encountered transient error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (this.isRunning && !this.isClosing) {
        this.scheduleNextTick(this.pollIntervalMs);
      }
    }
  }

  /**
   * Atomically pops the next waiting job, increments attemptsMade, and sets active lock.
   */
  private async claimNextJob(): Promise<BullJob<T> | null> {
    const now = Date.now();
    const lockUntil = now + this.lockDurationMs;
    const luaClaim = `
      local waitKey = KEYS[1]
      local activeKey = KEYS[2]
      local prefix = ARGV[1]
      local now = ARGV[2]
      local lockUntil = ARGV[3]
      local jobId = redis.call('LPOP', waitKey)
      if not jobId then
        return nil
      end
      local jobKey = prefix .. ':job:' .. jobId
      local attempts = tonumber(redis.call('HGET', jobKey, 'attemptsMade') or '0') + 1
      redis.call('HSET', jobKey,
        'status', 'active',
        'attemptsMade', tostring(attempts),
        'processedOn', now,
        'lockUntil', lockUntil
      )
      redis.call('SADD', activeKey, jobId)
      return jobId
    `;

    const jobId = await this.redis.eval<string | null>(
      luaClaim,
      [this.key('wait'), this.key('active')],
      [this.prefix, now, lockUntil],
    );

    if (!jobId) return null;
    const queue = new BullQueue<T>(this.queueName, this.redis);
    return queue.getJob(jobId);
  }

  /**
   * Processes a single job with tenant context validation, timeout protection,
   * exponential backoff retry, or dead-letter transition.
   */
  async processNextOnce(): Promise<{ processed: boolean; job?: BullJob<T> }> {
    const queue = new BullQueue<T>(this.queueName, this.redis);
    await queue.promoteDelayedJobs();
    await queue.recoverStalledJobs();

    const job = await this.claimNextJob();
    if (!job) return { processed: false };

    await this.executeJob(job);
    const updated = await queue.getJob(job.id);
    return { processed: true, job: updated ?? job };
  }

  async processNextTick(): Promise<{ processed: boolean; job?: BullJob<T> }> {
    return this.processNextOnce();
  }

  async drain(): Promise<number> {
    let count = 0;
    while (true) {
      const res = await this.processNextOnce();
      if (!res.processed) break;
      count++;
    }
    return count;
  }

  async stop(): Promise<void> {
    await this.close();
  }

  private async executeJob(job: BullJob<T>): Promise<void> {
    const startTime = Date.now();
    const correlationId = job.opts.correlationId || job.data.correlationId || randomUUID();

    try {
      // Enforce tenant context isolation on background jobs
      if (job.opts.requireOrganizationContext !== false) {
        assertTenantContext(job.data);
      }

      const timeoutMs = job.opts.timeoutMs || 15000;
      const result = await new Promise<R>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`JOB_TIMEOUT: Execution exceeded ${timeoutMs}ms`));
        }, timeoutMs);

        this.processor(job)
          .then((res) => {
            clearTimeout(timer);
            resolve(res);
          })
          .catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
      });

      const finishedOn = Date.now();
      await this.redis.srem(this.key('active'), job.id);
      await this.redis.srem(this.key('failed'), job.id);
      await this.redis.hset(this.key(`job:${job.id}`), {
        status: 'completed',
        returnvalue: JSON.stringify(result ?? null),
        finishedOn,
        lockUntil: 0,
      });
      await this.redis.sadd(this.key('completed'), job.id);

      this.logger.info('Job completed successfully', {
        correlationId,
        organizationId: job.data.organizationId,
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade,
        durationMs: finishedOn - startTime,
      });
    } catch (err) {
      const finishedOn = Date.now();
      const errorMsg = err instanceof Error ? err.message : String(err);
      const nonRetryable =
        errorMsg.includes('TenantContext violation') ||
        errorMsg.includes('CROSS_TENANT_VIOLATION') ||
        errorMsg.includes('NON_RETRYABLE');

      await this.redis.srem(this.key('active'), job.id);

      if (nonRetryable || job.attemptsMade >= job.opts.attempts) {
        // Terminal failure -> Dead-Letter Queue (DLQ)
        await this.redis.hset(this.key(`job:${job.id}`), {
          status: 'dead-letter',
          failedReason: errorMsg,
          finishedOn,
          lockUntil: 0,
        });
        await this.redis.sadd(this.key('dlq'), job.id);
        await this.redis.sadd(this.key('failed'), job.id);

        this.logger.error('Job moved to Dead-Letter Queue after exhausting retries', {
          correlationId,
          organizationId: job.data.organizationId,
          jobId: job.id,
          jobName: job.name,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts,
          failedReason: errorMsg,
        });
      } else {
        // Retry with exponential or fixed backoff
        const baseDelay = job.opts.backoff?.delay ?? 200;
        const backoffDelay =
          job.opts.backoff?.type === 'fixed'
            ? baseDelay
            : baseDelay * Math.pow(2, Math.max(0, job.attemptsMade - 1));

        const nextRunAt = finishedOn + backoffDelay;
        await this.redis.hset(this.key(`job:${job.id}`), {
          status: 'delayed',
          failedReason: errorMsg,
          lockUntil: 0,
        });
        await this.redis.sadd(this.key('failed'), job.id);
        await this.redis.zadd(this.key('delayed'), nextRunAt, job.id);

        this.logger.warn('Job failed; scheduled exponential backoff retry', {
          correlationId,
          organizationId: job.data.organizationId,
          jobId: job.id,
          jobName: job.name,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts,
          nextRetryInMs: backoffDelay,
          failedReason: errorMsg,
        });
      }
    }
  }

  /**
   * Gracefully shuts down the worker, waiting for all in-flight jobs to complete.
   */
  async close(): Promise<void> {
    this.isClosing = true;
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.activePromises.size > 0) {
      await Promise.allSettled([...this.activePromises]);
    }
  }
}

export const QUEUE_NAMES = {
  WEBHOOK_DELIVERY: 'webhook-delivery',
  PAYMENT_PROCESSING: 'payment-processing',
  SMS_CAMPAIGN: 'sms-campaign',
  SMS_DELIVERY_RETRY: 'sms-delivery-retry',
  MAINTENANCE_CLEANUP: 'maintenance-cleanup',
} as const;
