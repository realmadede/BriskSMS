-- ==============================================================================
-- Migration: 20261112000000_unified_payment_reference_claims
-- Description: Establishes unified, platform-wide payment reference claims,
--              append-only claim audit history, and historical collision quarantine.
-- ==============================================================================

-- 1. Create Enums
DO $$ BEGIN
  CREATE TYPE "claim_status" AS ENUM (
    'PROVISIONAL',
    'EXPIRED',
    'CONFIRMED_PROVIDER',
    'UNRESOLVED_COLLISION',
    'DISPUTED',
    'RELEASED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "claim_evidence_tier" AS ENUM (
    'AUTHORITATIVE_PROVIDER',
    'CLIENT_REPORTED',
    'UNRESOLVED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "claim_event_action" AS ENUM (
    'PROVISIONALLY_CLAIMED',
    'SUPPLEMENTARY_ATTACHED',
    'EXPIRED',
    'CONFIRMED_PROVIDER',
    'SUPERSEDED_EVICTION',
    'COLLISION_QUARANTINED',
    'DISPUTE_RAISED',
    'ADJUDICATED_RESOLUTION',
    'RELEASED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "payment_verification_state" AS ENUM (
    'UNVERIFIED',
    'HUMAN_ATTESTED',
    'PROVIDER_AUTHENTICATED',
    'REJECTED',
    'REVIEW_REQUIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Alter Canonical payment_reference_claims Table
ALTER TABLE "payment_reference_claims"
  ALTER COLUMN "organization_id" DROP NOT NULL;

ALTER TABLE "payment_reference_claims"
  ADD COLUMN IF NOT EXISTS "status" "claim_status" NOT NULL DEFAULT 'PROVISIONAL',
  ADD COLUMN IF NOT EXISTS "evidence_tier" "claim_evidence_tier" NOT NULL DEFAULT 'CLIENT_REPORTED',
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "confirmed_by_id" UUID,
  ADD COLUMN IF NOT EXISTS "release_reason" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Re-establish Foreign Keys with Restrict Referral Policy
ALTER TABLE "payment_reference_claims"
  DROP CONSTRAINT IF EXISTS "payment_reference_claims_organization_id_fkey",
  ADD CONSTRAINT "payment_reference_claims_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

ALTER TABLE "payment_reference_claims"
  DROP CONSTRAINT IF EXISTS "payment_reference_claims_payment_id_fkey",
  ADD CONSTRAINT "payment_reference_claims_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "normalized_payments"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS "claim_status_idx" ON "payment_reference_claims"("status");
CREATE INDEX IF NOT EXISTS "claim_expires_at_idx" ON "payment_reference_claims"("expires_at");

-- 3. Create Append-Only History Table
CREATE TABLE IF NOT EXISTS "payment_reference_claim_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "claim_id" UUID NOT NULL REFERENCES "payment_reference_claims"("id") ON DELETE CASCADE,
  "provider" "PaymentProvider" NOT NULL,
  "provider_reference" VARCHAR(100) NOT NULL,
  "organization_id" UUID REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "action" "claim_event_action" NOT NULL,
  "previous_status" "claim_status",
  "new_status" "claim_status" NOT NULL,
  "evidence_tier" "claim_evidence_tier" NOT NULL,
  "evidence_id" UUID,
  "actor_id" UUID,
  "actor_type" VARCHAR(32) NOT NULL DEFAULT 'SYSTEM',
  "reason" VARCHAR(255),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "claim_events_claim_idx" ON "payment_reference_claim_events"("claim_id");
CREATE INDEX IF NOT EXISTS "claim_events_provider_ref_idx" ON "payment_reference_claim_events"("provider", "provider_reference");

-- Immutability Trigger
DROP TRIGGER IF EXISTS "trg_claim_events_immutable" ON "payment_reference_claim_events";
CREATE TRIGGER "trg_claim_events_immutable"
  BEFORE UPDATE OR DELETE ON "payment_reference_claim_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

-- 4. Create Historical Collision Quarantine Table
CREATE TABLE IF NOT EXISTS "payment_reference_claim_collisions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "claim_id" UUID NOT NULL REFERENCES "payment_reference_claims"("id") ON DELETE CASCADE,
  "provider" "PaymentProvider" NOT NULL,
  "provider_reference" VARCHAR(100) NOT NULL,
  "competing_records" JSONB NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'UNRESOLVED',
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "adjudicated_at" TIMESTAMPTZ(6),
  "adjudicated_by_id" UUID,
  "adjudication_rationale" TEXT,
  "awarded_organization_id" UUID REFERENCES "organizations"("id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "claim_collisions_provider_ref_idx" ON "payment_reference_claim_collisions"("provider", "provider_reference");

-- 5. Provenance-Aware Backfill & Collision Quarantine Script
DO $$
DECLARE
  rec RECORD;
  collision_claim_id UUID;
  existing_claim_id UUID;
BEGIN
  -- A. Identify and Quarantine Multi-Tenant Collisions
  FOR rec IN (
    SELECT "provider", "reference", COUNT(*) as cnt, jsonb_agg(jsonb_build_object(
      'payment_id', "id",
      'organization_id', "organization_id",
      'state', "state",
      'created_at', "created_at",
      'amount_cents', "amount_cents",
      'sender_phone', "sender_phone"
    )) as records
    FROM "normalized_payments"
    WHERE "reference" IS NOT NULL AND TRIM("reference") <> ''
    GROUP BY "provider", "reference"
    HAVING COUNT(DISTINCT "organization_id") > 1
  ) LOOP
    SELECT "id" INTO existing_claim_id
    FROM "payment_reference_claims"
    WHERE "provider" = rec.provider AND "provider_reference" = UPPER(TRIM(rec.reference));

    IF existing_claim_id IS NOT NULL THEN
      UPDATE "payment_reference_claims"
      SET
        "organization_id" = NULL,
        "payment_id" = NULL,
        "checkout_id" = NULL,
        "status" = 'UNRESOLVED_COLLISION',
        "evidence_tier" = 'UNRESOLVED',
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = existing_claim_id;

      collision_claim_id := existing_claim_id;
    ELSE
      INSERT INTO "payment_reference_claims" (
        "id", "provider", "provider_reference", "organization_id",
        "status", "evidence_tier", "claimed_at"
      )
      VALUES (
        gen_random_uuid(), rec.provider, UPPER(TRIM(rec.reference)), NULL,
        'UNRESOLVED_COLLISION', 'UNRESOLVED', CURRENT_TIMESTAMP
      )
      RETURNING "id" INTO collision_claim_id;
    END IF;

    INSERT INTO "payment_reference_claim_collisions" (
      "claim_id", "provider", "provider_reference", "competing_records", "status"
    )
    VALUES (
      collision_claim_id, rec.provider, UPPER(TRIM(rec.reference)), rec.records, 'UNRESOLVED'
    );

    INSERT INTO "payment_reference_claim_events" (
      "claim_id", "provider", "provider_reference", "action", "new_status", "evidence_tier", "reason"
    )
    VALUES (
      collision_claim_id, rec.provider, UPPER(TRIM(rec.reference)),
      'COLLISION_QUARANTINED', 'UNRESOLVED_COLLISION', 'UNRESOLVED',
      'Historical multi-tenant collision detected during P0.2 migration'
    );
  END LOOP;

  -- B. Backfill Provider-Authenticated Confirmed Claims (STK Push Success)
  UPDATE "payment_reference_claims" c
  SET
    "status" = 'CONFIRMED_PROVIDER',
    "evidence_tier" = 'AUTHORITATIVE_PROVIDER',
    "confirmed_at" = COALESCE(stk.updated_at, c.claimed_at),
    "updated_at" = CURRENT_TIMESTAMP
  FROM "stk_push_transactions" stk
  WHERE c.checkout_id = stk.id
    AND stk.status = 'SUCCESS'
    AND c.status <> 'UNRESOLVED_COLLISION';

  -- C. Backfill Expired Provisional Claims (> 2 hours old)
  UPDATE "payment_reference_claims"
  SET
    "status" = 'EXPIRED',
    "evidence_tier" = 'CLIENT_REPORTED',
    "expires_at" = "claimed_at" + INTERVAL '2 hours',
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "status" = 'PROVISIONAL'
    AND "claimed_at" < CURRENT_TIMESTAMP - INTERVAL '2 hours';

END $$;
