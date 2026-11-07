import { BriskWorkerRuntime } from './workers.js';
import { closeDatabasePool, closeRedisClient } from '@brisksms/db';

const runtime = new BriskWorkerRuntime();

async function bootstrap() {
  await runtime.start();
}

async function shutdown(signal: string) {
  console.log(`[BriskSMS Worker] Received ${signal}. Draining active jobs...`);
  await runtime.stop();
  await closeRedisClient();
  await closeDatabasePool();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

bootstrap().catch((err) => {
  console.error('[BriskSMS Worker] Fatal startup error:', err);
  process.exit(1);
});
