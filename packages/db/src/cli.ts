import { closeDbPool, checkDatabaseHealth } from './client.js';
import { migrateDeploy, getAppliedMigrations, resetDevDatabase } from './migrate.js';
import { seedCommercialCatalog } from './seed.js';

async function main() {
  const command = process.argv[2] || 'status';

  try {
    switch (command) {
      case 'migrate': {
        const res = await migrateDeploy();
        console.log(JSON.stringify({ status: 'OK', applied: res.applied, skipped: res.skipped }, null, 2));
        break;
      }
      case 'seed': {
        await migrateDeploy();
        const res = await seedCommercialCatalog();
        console.log(JSON.stringify({ status: 'OK', ...res }, null, 2));
        break;
      }
      case 'reset-dev': {
        const res = await resetDevDatabase();
        console.log(JSON.stringify({ status: 'OK', reset: true, ...res }, null, 2));
        break;
      }
      case 'status': {
        const health = await checkDatabaseHealth();
        const migrations = health.status === 'UP' ? await getAppliedMigrations() : [];
        console.log(
          JSON.stringify(
            {
              health,
              appliedMigrations: migrations.map((m) => ({
                name: m.migration_name,
                checksum: m.checksum,
                finishedAt: m.finished_at,
              })),
            },
            null,
            2,
          ),
        );
        break;
      }
      default:
        console.error(`Unknown db command: ${command}. Use: migrate | seed | reset-dev | status`);
        process.exit(1);
    }
  } finally {
    await closeDbPool();
  }
}

main().catch((err) => {
  console.error('[BriskSMS DB CLI Error]:', err instanceof Error ? err.message : err);
  process.exit(1);
});
