# Migration Checksum Investigation Report (`20261112000000_unified_payment_reference_claims`)

**Document:** `docs/reports/MIGRATION_CHECKSUM_INVESTIGATION.md`  
**Investigation Date:** 2026-11-16  
**Target Database Verified:** Local PostgreSQL 16 (`127.0.0.1:54322`, `brisksms_dev`)  
**Scope:** Forensic verification of `_prisma_migrations` checksum drift on `20261112000000_unified_payment_reference_claims`, fresh-database strict replay verification, schema DDL parity comparison, and safe resolution guidance.

---

## 1. Executive Summary

- **Affected Migration:** `20261112000000_unified_payment_reference_claims` (`applied_steps_count = 1`, `finished_at = 2026-11-12T04:27:22.705Z`).
- **Nature of Drift:** **Metadata-only historical drift in the pre-existing local development database (`brisksms_dev`).**
- **Fresh Database Behavior:** On a clean database (`brisksms_audit_fresh_check`), all **15 migrations** apply cleanly under `STRICT_MIGRATION_CHECKSUMS=true` and `migrateDeploy({ strictChecksums: true })` with **0 checksum mismatches**.
- **DDL / Schema Parity Result:** A full `pg_dump --schema-only --no-owner --no-privileges` comparison between `brisksms_dev` and `brisksms_audit_fresh_check` confirmed **zero table, column, index, constraint, or trigger differences**.

---

## 2. Cryptographic Evidence

Querying `brisksms_dev._prisma_migrations` across all **15** applied migrations established:

1. **Matching Migrations (14 of 15):**
   Every migration from `20261107000000` through `20261111010000` and from `20261114000000` through `20261116010000` has an identical SHA-256 digest in `_prisma_migrations` and on disk.
2. **Drifted Migration (1 of 15 — `20261112000000_unified_payment_reference_claims`):**
   - **Recorded in `brisksms_dev._prisma_migrations`:** `81d7b59c4be3a5596bc58922220c2ed2dbe4083eb0cd7ae8b1dd1dfe71597721` (`finished_at = 2026-11-12T04:27:22.705Z`, `applied_steps_count = 1`).
   - **Current SHA-256 of `packages/db/prisma/migrations/20261112000000_unified_payment_reference_claims/migration.sql`:** `8c01b9ce9f780aa96c116b117a8f1ccb00850c5cae4a321377c330b2e81d1588`.

---

## 3. Clean-Room Replay & Schema Parity Verification

To verify whether `brisksms_dev` had any structural/DDL divergence from the committed 15-migration chain:

1. Created a temporary isolated PostgreSQL database `brisksms_audit_fresh_check` on the same PostgreSQL 16 instance.
2. Executed `STRICT_MIGRATION_CHECKSUMS=true bun run packages/db/src/cli.ts migrate` and `migrateDeploy({ strictChecksums: true })` against `brisksms_audit_fresh_check`.
   - **Result:** All 15 migrations applied cleanly; `strictChecksums: true` reported **0 mismatches**.
3. Exported `pg_dump --schema-only --no-owner --no-privileges` for both `brisksms_dev` and `brisksms_audit_fresh_check` and diffed the normalized dumps.
   - **Result:** **0 DDL/table/index/constraint/trigger differences** (only volatile `\restrict` / `\unrestrict` dump header tokens differed).
4. Dropped `brisksms_audit_fresh_check` upon completion.

---

## 4. Safe Remediation Policy & Next Steps

1. **Preserve On-Disk Migration Integrity:** Do **not** modify `packages/db/prisma/migrations/20261112000000_unified_payment_reference_claims/migration.sql`, and do not rewrite applied migration files to match legacy dev metadata.
2. **Staging / Production / CI Environments:** Fresh or staging databases initialized from the repository migration files pass `STRICT_MIGRATION_CHECKSUMS=true` / `NODE_ENV=production` cleanly with zero changes.
3. **Local Development DB Synchronization (When Needed):** Because `pg_dump --schema-only` parity is verified, a developer whose local `brisksms_dev` holds the legacy `81d7b59c...` row can either:
   - Recreate their local dev DB cleanly (`bun run db:reset:dev` or drop/create + `bun run db:migrate`), or
   - Explicitly add an audited `db:repair:checksum` workflow (never auto-silenced in production!) or manually verify before updating dev metadata, while keeping strict checksum enforcement fail-closed in staging/production (`NODE_ENV=production` / `STRICT_MIGRATION_CHECKSUMS=true`).
