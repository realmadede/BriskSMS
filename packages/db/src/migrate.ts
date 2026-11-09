import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, sqlUnsafe, withTransaction } from './client.js';
import { seedCommercialCatalog } from './seed.js';

export interface MigrationRecord {
  id: string;
  checksum: string;
  finished_at: Date | null;
  migration_name: string;
  logs: string | null;
  rolled_back_at: Date | null;
  started_at: Date;
  applied_steps_count: number;
}

function getMigrationsDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidate1 = join(currentDir, '..', 'prisma', 'migrations');
  if (existsSync(candidate1)) return candidate1;
  const candidate2 = join(process.cwd(), 'packages', 'db', 'prisma', 'migrations');
  if (existsSync(candidate2)) return candidate2;
  throw new Error(`Could not locate prisma/migrations directory from ${currentDir}`);
}

/**
 * Ensures the Prisma-compatible `_prisma_migrations` tracking table exists.
 */
async function ensureMigrationsTable(): Promise<void> {
  await sqlUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL UNIQUE,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Applies all pending version-controlled SQL migrations in `packages/db/prisma/migrations/`.
 * Works from an empty database and safely skips already-applied migrations on existing dev databases.
 */
export async function migrateDeploy(): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureMigrationsTable();

  const migrationsDir = getMigrationsDir();
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const existingRows = await sql<MigrationRecord>`
    SELECT "id", "checksum", "migration_name", "finished_at"
    FROM "_prisma_migrations"
    WHERE "rolled_back_at" IS NULL AND "finished_at" IS NOT NULL
  `;
  const appliedMap = new Map(existingRows.map((r) => [r.migration_name, r]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const folderName of entries) {
    const sqlPath = join(migrationsDir, folderName, 'migration.sql');
    if (!existsSync(sqlPath)) continue;

    const sqlContent = readFileSync(sqlPath, 'utf-8');
    const checksum = createHash('sha256').update(sqlContent, 'utf-8').digest('hex');

    if (appliedMap.has(folderName)) {
      skipped.push(folderName);
      continue;
    }

    // Check if the baseline tables already exist on a pre-populated dev DB without _prisma_migrations entry
    if (folderName === '20261107000000_init_foundation') {
      const tableCheck = await sql<{ exists: boolean }>`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'organizations'
        ) AS "exists"
      `;
      if (tableCheck[0]?.exists) {
        await sql`
          INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
          VALUES (${randomUUID()}, ${checksum}, NOW(), ${folderName}, 1)
          ON CONFLICT ("migration_name") DO NOTHING
        `;
        skipped.push(folderName);
        continue;
      }
    }

    const migrationId = randomUUID();
    await withTransaction(async (tx) => {
      await tx.unsafe!(sqlContent);
      await tx`
        INSERT INTO "_prisma_migrations" ("id", "checksum", "started_at", "finished_at", "migration_name", "applied_steps_count")
        VALUES (${migrationId}, ${checksum}, NOW(), NOW(), ${folderName}, 1)
      `;
    });

    applied.push(folderName);
  }

  return { applied, skipped };
}

/**
 * Returns the list of applied migrations from `_prisma_migrations`.
 */
export async function getAppliedMigrations(): Promise<MigrationRecord[]> {
  await ensureMigrationsTable();
  return sql<MigrationRecord>`
    SELECT "id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count"
    FROM "_prisma_migrations"
    ORDER BY "migration_name" ASC
  `;
}

/**
 * Asserts that a destructive reset operation is NEVER executed in production.
 */
function assertNotProduction(operationName: string): void {
  const env = (process.env.NODE_ENV || 'development').toLowerCase();
  const dbUrl = (process.env.DATABASE_URL || '').toLowerCase();

  if (
    env === 'production' ||
    env === 'prod' ||
    dbUrl.includes('prod.') ||
    dbUrl.includes('brisksms_prod') ||
    process.env.ALLOW_PRODUCTION_DB_RESET === 'true' // even if someone sets a flag, block in prod
  ) {
    throw new Error(
      `SECURITY_GUARD_VIOLATION: '${operationName}' is strictly prohibited in production environments (NODE_ENV=${process.env.NODE_ENV}).`,
    );
  }
}

/**
 * Completely resets the development database schema, re-runs all migrations from scratch,
 * and seeds the commercial catalog. Strictly blocked in production.
 */
export async function resetDevDatabase(): Promise<{ appliedMigrations: string[] }> {
  assertNotProduction('resetDevDatabase');

  await sqlUnsafe(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `);

  const migResult = await migrateDeploy();
  await seedCommercialCatalog();

  return { appliedMigrations: migResult.applied };
}

let migrationsEnsured = false;

/**
 * Fast test-isolation reset: ensures schema is migrated, truncates all tenant and catalog tables,
 * and re-seeds the default commercial catalog. Strictly blocked in production.
 */
export async function resetTestDatabaseState(): Promise<void> {
  assertNotProduction('resetTestDatabaseState');

  if (!migrationsEnsured) {
    await migrateDeploy();
    migrationsEnsured = true;
  }

  // TRUNCATE does not fire row-level BEFORE UPDATE/DELETE triggers, so it cleanly resets append-only tables in test suites
  await sqlUnsafe(`
    TRUNCATE TABLE
      "message_idempotency_records",
      "smsgate_webhook_events",
      "smsgate_signing_keys",
      "webhook_deliveries",
      "webhook_endpoints",
      "oauth_tokens",
      "oauth_authorization_codes",
      "oauth_clients",
      "api_keys",
      "outbox_events",
      "audit_logs",
      "sms_delivery_attempts",
      "sms_messages",
      "sms_campaign_recipients",
      "sms_campaigns",
      "sender_ids",
      "messaging_credit_ledger",
      "messaging_accounts",
      "automation_logs",
      "automation_rules",
      "invoice_payments",
      "invoice_items",
      "payment_verifications",
      "normalized_payments",
      "raw_payment_evidence",
      "invoices",
      "customers",
      "device_telemetry",
      "pairing_tokens",
      "devices",
      "revoked_sessions",
      "refresh_tokens",
      "organization_invitations",
      "users_organizations",
      "subscription_billing_invoices",
      "subscription_history",
      "organization_subscriptions",
      "plan_entitlements",
      "plan_prices",
      "plan_versions",
      "subscription_plans",
      "commercial_products",
      "feature_definitions",
      "organizations",
      "users"
    RESTART IDENTITY CASCADE;
  `);

  await seedCommercialCatalog();
}
