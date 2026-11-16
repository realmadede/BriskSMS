import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BullQueue,
  closeRedisClient,
  db,
  getRedisClient,
  migrateDeploy,
  redisClient,
  resolveRedisConfig,
} from '../src/index.js';

describe('@brisksms/db primitives verification', () => {
  afterEach(async () => {
    await closeRedisClient().catch(() => {});
  });

  it('exposes db as a callable tagged-template proxy executing live PostgreSQL queries', async () => {
    assert.equal(typeof db, 'function');
    const rows = await db<{ ok: number }>`SELECT 1 AS ok`;
    assert.equal(rows[0]?.ok, 1);

    const migStatus = await migrateDeploy({ strictChecksums: false });
    assert.ok(Array.isArray(migStatus.checksumMismatches));
  });

  it('parses password and DB index in resolveRedisConfig', () => {
    const cfg = resolveRedisConfig('redis://:secretpass@127.0.0.1:6379/2');
    assert.equal(cfg.mode, 'tcp');
    assert.equal(cfg.password, 'secretpass');
    assert.equal(cfg.db, 2);
  });

  it('uses SCAN in redis.keys() and removes job from dlq/failed when re-adding', async () => {
    const client = getRedisClient();
    const keyA = `brisk:test:scan:${Date.now()}:a`;
    const keyB = `brisk:test:scan:${Date.now()}:b`;
    await client.set(keyA, '1', 30);
    await client.set(keyB, '2', 30);

    const found = await redisClient.keys(`brisk:test:scan:*`);
    assert.ok(found.includes(keyA));
    assert.ok(found.includes(keyB));
    await client.del(keyA, keyB);

    const queueName = `db-primitives-${Date.now()}`;
    const q = new BullQueue<{ organizationId: string }>(queueName, client);
    const jobId = `job-${Date.now()}`;

    await q.add('retry-check', { organizationId: 'org-test' }, { jobId });
    await client.sadd(`bull:${queueName}:dlq`, jobId);
    await client.sadd(`bull:${queueName}:failed`, jobId);
    await client.hset(`bull:${queueName}:job:${jobId}`, { status: 'dead-letter' });

    const readded = await q.add('retry-check', { organizationId: 'org-test' }, { jobId });
    assert.equal(readded.status, 'waiting');

    const dlqMembers = await client.smembers(`bull:${queueName}:dlq`);
    const failedMembers = await client.smembers(`bull:${queueName}:failed`);
    assert.equal(dlqMembers.includes(jobId), false);
    assert.equal(failedMembers.includes(jobId), false);

    await client.del(
      `bull:${queueName}:wait`,
      `bull:${queueName}:delayed`,
      `bull:${queueName}:dlq`,
      `bull:${queueName}:failed`,
      `bull:${queueName}:job:${jobId}`,
    );
  });
});
