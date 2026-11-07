# Database Design Conventions & Migration Standards

**Database Engine:** PostgreSQL 16+  
**ORM & Migration Tool:** Prisma ORM  
**Target Package:** `packages/db`  

---

## 1. Naming Conventions

1. **Tables:**
   - Snake_case, plural nouns: `organizations`, `users`, `devices`, `raw_payment_evidence`, `normalized_payments`, `invoices`, `messaging_credit_ledger`.
   - Pivot / Join tables: Explicitly describe both entities in snake_case (e.g., `users_organizations`, `invoice_payments`).
2. **Columns:**
   - Snake_case, descriptive names: `id`, `organization_id`, `created_at`, `updated_at`, `is_active`, `amount_cents`.
   - Foreign key columns must use `<singular_entity>_id` (e.g., `user_id`, `device_id`, `invoice_id`).
   - Boolean columns must use a prefix indicating boolean state: `is_active`, `has_exceeded_quota`, `is_revoked`.
   - Timestamps: Always store with timezone (`TIMESTAMPTZ`), named `<event>_at` (e.g., `created_at`, `updated_at`, `verified_at`, `revoked_at`).

---

## 2. Primary Keys & Identifiers

- **Primary Keys:**
  - All primary keys must be **UUIDv7** (time-ordered UUIDs) or standard UUIDs generated application-side or via PostgreSQL's `gen_random_uuid()`.
  - Sequential integer IDs (`SERIAL` / `BIGINT`) are **strictly prohibited** on public and tenant-facing tables to prevent enumeration attacks.

---

## 3. Mandatory Columns & Auditability

Every business table must include:
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

*Exception:* Immutable append-only log tables (`raw_payment_evidence`, `audit_logs`, `messaging_credit_ledger`) must **never** include `updated_at`, as their records can never be modified.

---

## 4. Indexing Standards

1. **Foreign Keys:** Every foreign key column must have an explicit B-tree index to optimize joins and cascading checks.
2. **Composite Tenant Indices:** All frequently queried tenant columns must be indexed in composite format with `organization_id` as the leading column:
   ```sql
   CREATE INDEX idx_payments_org_state_created ON normalized_payments (organization_id, state, created_at DESC);
   CREATE INDEX idx_invoices_org_status ON invoices (organization_id, status);
   ```
3. **Deduplication Constraints:**
   ```sql
   CREATE UNIQUE INDEX uq_payments_dedup_hash ON normalized_payments (organization_id, deduplication_hash);
   ```

---

## 5. Migration Rules & CLI Workflow

1. **Forward-Only Versioned Migrations:** All schema changes are committed via version-controlled SQL migrations under `packages/db/prisma/migrations/` and tracked in the PostgreSQL `_prisma_migrations` table with SHA-256 checksums (`20261107000000_init_foundation`). Never edit applied migration files.
2. **Database Lifecycle Commands:**
   - `npm run db:migrate` — Applies pending SQL migrations idempotently inside ACID transactions and records SHA-256 checksums in `_prisma_migrations`.
   - `npm run db:seed` — Idempotently seeds the dynamic commercial catalog (`PROD_PAYMENT_INTELLIGENCE`, `PROD_BULK_MESSAGING`, `PLAN_STARTER`, `PLAN_GROWTH`, `PLAN_ENTERPRISE`, feature definitions, and plan entitlements).
   - `npm run db:status` — Reports PostgreSQL connectivity, latency, and applied migrations.
   - `npm run db:reset:dev` — Truncates development/test tables and re-seeds the commercial catalog (strictly blocked when `NODE_ENV=production`).
3. **Zero-Downtime Schema Evolution:**
   - Never rename or drop a column in a single release.
   - Follow the Expand-Contract pattern:
     1. Release 1: Add new nullable column.
     2. Release 2: Double-write to both columns and backfill existing rows.
     3. Release 3: Switch reads to new column.
     4. Release 4: Drop old column.
4. **Destructive Operations:** Dropping tables or executing destructive data migrations requires explicit technical lead review and a verified database backup snapshot.

---

## 6. Database-Level Immutability & Financial Integrity Enforcement

1. **Append-Only Immutability Triggers (`prevent_immutable_record_mutation()`):**
   - PostgreSQL `BEFORE UPDATE OR DELETE` triggers block any modification or deletion on:
     - `raw_payment_evidence`
     - `payment_verifications`
     - `messaging_credit_ledger`
     - `subscription_history`
     - `audit_logs`
   - Any attempt to `UPDATE` or `DELETE` rows in these tables raises `IMMUTABLE_RECORD_VIOLATION` (`23514`).
2. **Historical Billing Snapshot Protection (`prevent_billing_invoice_snapshot_mutation()`):**
   - `subscription_billing_invoices` protects `plan_code_snapshot`, `version_number_snapshot`, `amount_cents`, `currency`, `billing_interval`, `entitlements_snapshot`, and `organization_id` from ever being altered after invoice issuance.
3. **Financial Retention (`ON DELETE RESTRICT`):**
   - Organizations owning financial or audit records (`invoices`, `raw_payment_evidence`, `normalized_payments`, `payment_verifications`, `messaging_accounts`, `messaging_credit_ledger`, `organization_subscriptions`, `subscription_billing_invoices`, `audit_logs`) cannot be deleted via `ON DELETE RESTRICT`.
4. **Transactional Outbox & Redis Queue Reliability:**
   - All domain events (`payment.evidence.received`, `payment.matched`, `payment.verified`, `invoice.paid`, `fulfillment.eligible`, `sms.status.updated`) are inserted into `outbox_events` inside the **same PostgreSQL ACID transaction** as the business state mutation.
   - `OutboxDispatcher` (`@brisksms/worker`) polls `outbox_events` using `SELECT ... FOR UPDATE SKIP LOCKED` and dispatches jobs to Redis-backed queues (`webhook-delivery`, `payment-processing`, `sms-campaign`, `sms-delivery-retry`, `maintenance-cleanup`) with deterministic `jobId` deduplication, exponential backoff, and Dead-Letter Queue (`dlq`) isolation.

