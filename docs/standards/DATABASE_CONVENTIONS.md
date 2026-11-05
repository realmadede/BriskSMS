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

## 5. Migration Rules

1. **Forward-Only Migrations:** All schema changes must be committed via versioned Prisma migrations (`prisma migrate dev`). Never edit previous migration files.
2. **Zero-Downtime Schema Evolution:**
   - Never rename or drop a column in a single release.
   - Follow the Expand-Contract pattern:
     1. Release 1: Add new nullable column.
     2. Release 2: Double-write to both columns and backfill existing rows.
     3. Release 3: Switch reads to new column.
     4. Release 4: Drop old column.
3. **Destructive Operations:** Dropping tables or executing destructive data migrations requires explicit technical lead review and a verified database backup snapshot.
