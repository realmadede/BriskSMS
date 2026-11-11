-- ==============================================================================
-- Migration: 20261111010000_provider_reference_claims_and_unique_stk
-- Description: Establishes global provider-reference uniqueness, cross-organization
--              claim serialization, and database-level partial unique index on successful STK transactions.
-- ==============================================================================

-- 1. Create payment_reference_claims table
CREATE TABLE IF NOT EXISTS "payment_reference_claims" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "provider" "PaymentProvider" NOT NULL,
    "provider_reference" VARCHAR(100) NOT NULL,
    "organization_id" UUID NOT NULL,
    "checkout_id" VARCHAR(64),
    "payment_id" UUID,
    "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reference_claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payment_reference_claims_unique" UNIQUE ("provider", "provider_reference")
);

-- 2. Indexes for fast lookup by organization and provider reference
CREATE INDEX IF NOT EXISTS "payment_reference_claims_org_idx" ON "payment_reference_claims"("organization_id");
CREATE INDEX IF NOT EXISTS "payment_reference_claims_provider_ref_idx" ON "payment_reference_claims"("provider", "provider_reference");

-- 3. Unique partial index on stk_push_transactions ensuring no two successful transactions can share a provider reference
CREATE UNIQUE INDEX IF NOT EXISTS "stk_push_transactions_provider_ref_success_unique" 
ON "stk_push_transactions"("provider", "provider_reference") 
WHERE "status" = 'SUCCESS' AND "provider_reference" IS NOT NULL;

-- 4. Safe backfill: populate claims from existing normalized_payments
INSERT INTO "payment_reference_claims" ("provider", "provider_reference", "organization_id", "payment_id", "claimed_at")
SELECT DISTINCT ON (p."provider", UPPER(TRIM(p."reference")))
    p."provider",
    UPPER(TRIM(p."reference")),
    p."organization_id",
    p."id",
    p."created_at"
FROM "normalized_payments" p
WHERE p."reference" IS NOT NULL AND TRIM(p."reference") != ''
ON CONFLICT ("provider", "provider_reference") DO NOTHING;

-- 5. Safe backfill: populate claims from existing successful stk_push_transactions
INSERT INTO "payment_reference_claims" ("provider", "provider_reference", "organization_id", "checkout_id", "payment_id", "claimed_at")
SELECT DISTINCT ON (s."provider", UPPER(TRIM(s."provider_reference")))
    s."provider",
    UPPER(TRIM(s."provider_reference")),
    s."organization_id",
    s."id",
    s."settled_payment_id",
    s."created_at"
FROM "stk_push_transactions" s
WHERE s."status" = 'SUCCESS' AND s."provider_reference" IS NOT NULL AND TRIM(s."provider_reference") != ''
ON CONFLICT ("provider", "provider_reference") DO NOTHING;
