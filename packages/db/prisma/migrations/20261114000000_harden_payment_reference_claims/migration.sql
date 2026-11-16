-- ==============================================================================
-- Migration: 20261114000000_harden_payment_reference_claims
-- Description: Additive P0.2 hardening migration:
--              1. Cross-channel case/whitespace-insensitive canonical collision detection
--                 and safe quarantine (no arbitrary winner selection).
--              2. Canonical DB CHECK constraints & expression unique indexes preventing
--                 case/whitespace-variant duplicates across claims and successful STK rows.
--              3. Null-organization ownership invariant enforced at DB layer
--                 (allowed only for UNRESOLVED_COLLISION and RELEASED).
--              4. Restrictive foreign-key deletion protection across claims, collisions,
--                 and append-only claim events.
-- ==============================================================================

-- 1. Preflight Canonicalization & Historical Collision Quarantine
DO $$
DECLARE
  rec RECORD;
  primary_claim_id UUID;
  was_already_quarantined BOOLEAN;
  competing_json JSONB;
  unresolved_collision_exists BOOLEAN;
  bad_empty_count INTEGER;
  bad_stk_dupe_count INTEGER;
  sec_row RECORD;
  sec_event_count INTEGER;
BEGIN
  -- Preflight guard: fail loudly on empty/whitespace-only claims
  SELECT COUNT(*) INTO bad_empty_count
  FROM "payment_reference_claims"
  WHERE "provider_reference" IS NULL OR BTRIM("provider_reference") = '';

  IF bad_empty_count > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_BLOCKER: Found % payment_reference_claims row(s) with NULL or empty provider_reference.', bad_empty_count;
  END IF;

  -- A. Detect cross-tenant collisions and case-variant claim duplicates using CANONICAL UPPER(BTRIM(...))
  FOR rec IN (
    WITH all_channel_refs AS (
      SELECT
        c."provider",
        UPPER(BTRIM(c."provider_reference")) AS norm_ref,
        c."organization_id",
        'CLAIM'::TEXT AS source_channel
      FROM "payment_reference_claims" c
      WHERE c."organization_id" IS NOT NULL
        AND c."provider_reference" IS NOT NULL
        AND BTRIM(c."provider_reference") <> ''

      UNION ALL

      SELECT
        p."provider",
        UPPER(BTRIM(p."reference")) AS norm_ref,
        p."organization_id",
        'NORMALIZED_PAYMENT'::TEXT AS source_channel
      FROM "normalized_payments" p
      WHERE p."reference" IS NOT NULL
        AND BTRIM(p."reference") <> ''

      UNION ALL

      SELECT
        s."provider",
        UPPER(BTRIM(s."provider_reference")) AS norm_ref,
        s."organization_id",
        'STK_SUCCESS'::TEXT AS source_channel
      FROM "stk_push_transactions" s
      WHERE s."status" = 'SUCCESS'
        AND s."provider_reference" IS NOT NULL
        AND BTRIM(s."provider_reference") <> ''
    ),
    claim_case_dupes AS (
      SELECT
        "provider",
        UPPER(BTRIM("provider_reference")) AS norm_ref,
        COUNT(*) AS claim_row_count
      FROM "payment_reference_claims"
      GROUP BY "provider", UPPER(BTRIM("provider_reference"))
      HAVING COUNT(*) > 1
    ),
    quarantined_claims AS (
      SELECT
        "provider",
        UPPER(BTRIM("provider_reference")) AS norm_ref
      FROM "payment_reference_claims"
      WHERE "status" = 'UNRESOLVED_COLLISION'
    ),
    colliding_keys AS (
      SELECT "provider", norm_ref
      FROM all_channel_refs
      GROUP BY "provider", norm_ref
      HAVING COUNT(DISTINCT "organization_id") > 1

      UNION

      SELECT "provider", norm_ref FROM claim_case_dupes
    )
    SELECT ck."provider", ck.norm_ref
    FROM colliding_keys ck
    ORDER BY ck."provider" ASC, ck.norm_ref ASC
  ) LOOP
    -- Snapshot all competing evidence across normalized_payments, stk_push_transactions, and existing claims
    SELECT jsonb_build_object(
      'normalized_payments', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'payment_id', p."id",
          'organization_id', p."organization_id",
          'raw_reference', p."reference",
          'state', p."state",
          'amount_cents', p."amount_cents",
          'sender_phone', p."sender_phone",
          'created_at', p."created_at"
        ) ORDER BY p."created_at" ASC, p."id" ASC)
        FROM "normalized_payments" p
        WHERE p."provider" = rec."provider"
          AND UPPER(BTRIM(p."reference")) = rec.norm_ref
      ), '[]'::jsonb),
      'stk_push_transactions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'checkout_id', s."id",
          'organization_id', s."organization_id",
          'raw_provider_reference', s."provider_reference",
          'status', s."status",
          'amount_cents', s."amount_cents",
          'settled_payment_id', s."settled_payment_id",
          'created_at', s."created_at"
        ) ORDER BY s."created_at" ASC, s."id" ASC)
        FROM "stk_push_transactions" s
        WHERE s."provider" = rec."provider"
          AND s."status" = 'SUCCESS'
          AND s."provider_reference" IS NOT NULL
          AND UPPER(BTRIM(s."provider_reference")) = rec.norm_ref
      ), '[]'::jsonb),
      'existing_claims', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'claim_id', c."id",
          'organization_id', c."organization_id",
          'raw_provider_reference', c."provider_reference",
          'status', c."status",
          'evidence_tier', c."evidence_tier",
          'payment_id', c."payment_id",
          'checkout_id', c."checkout_id",
          'claimed_at', c."claimed_at"
        ) ORDER BY c."claimed_at" ASC, c."id" ASC)
        FROM "payment_reference_claims" c
        WHERE c."provider" = rec."provider"
          AND UPPER(BTRIM(c."provider_reference")) = rec.norm_ref
      ), '[]'::jsonb)
    ) INTO competing_json;

    -- Locate canonical (or oldest) existing claim row to hold the quarantined slot
    SELECT c."id", (c."status" = 'UNRESOLVED_COLLISION')
    INTO primary_claim_id, was_already_quarantined
    FROM "payment_reference_claims" c
    WHERE c."provider" = rec."provider"
      AND UPPER(BTRIM(c."provider_reference")) = rec.norm_ref
    ORDER BY (c."provider_reference" = rec.norm_ref) DESC, c."claimed_at" ASC, c."id" ASC
    LIMIT 1
    FOR UPDATE;

    -- Safely consolidate duplicate case-variant claim rows if any exist
    IF primary_claim_id IS NOT NULL THEN
      FOR sec_row IN (
        SELECT c."id"
        FROM "payment_reference_claims" c
        WHERE c."provider" = rec."provider"
          AND UPPER(BTRIM(c."provider_reference")) = rec.norm_ref
          AND c."id" <> primary_claim_id
        FOR UPDATE
      ) LOOP
        SELECT COUNT(*) INTO sec_event_count
        FROM "payment_reference_claim_events"
        WHERE "claim_id" = sec_row."id";

        IF sec_event_count > 0 THEN
          RAISE EXCEPTION
            'PREFLIGHT_BLOCKER: Duplicate case-variant claim row % has % immutable audit event(s); manual reconciliation required before deduplicating canonical reference (%, %).',
            sec_row."id", sec_event_count, rec."provider", rec.norm_ref;
        END IF;

        UPDATE "payment_reference_claim_collisions"
        SET "claim_id" = primary_claim_id
        WHERE "claim_id" = sec_row."id";

        DELETE FROM "payment_reference_claims"
        WHERE "id" = sec_row."id";
      END LOOP;

      IF NOT COALESCE(was_already_quarantined, FALSE) OR EXISTS (
        SELECT 1 FROM "payment_reference_claims"
        WHERE "id" = primary_claim_id AND "provider_reference" <> rec.norm_ref
      ) THEN
        UPDATE "payment_reference_claims"
        SET
          "provider_reference" = rec.norm_ref,
          "organization_id" = NULL,
          "payment_id" = NULL,
          "checkout_id" = NULL,
          "status" = 'UNRESOLVED_COLLISION',
          "evidence_tier" = 'UNRESOLVED',
          "expires_at" = NULL,
          "confirmed_at" = NULL,
          "confirmed_by_id" = NULL,
          "release_reason" = NULL,
          "version" = "version" + 1,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = primary_claim_id;
      END IF;
    ELSE
      was_already_quarantined := FALSE;
      INSERT INTO "payment_reference_claims" (
        "id", "provider", "provider_reference", "organization_id",
        "status", "evidence_tier", "claimed_at"
      )
      VALUES (
        gen_random_uuid(), rec."provider", rec.norm_ref, NULL,
        'UNRESOLVED_COLLISION', 'UNRESOLVED', CURRENT_TIMESTAMP
      )
      RETURNING "id" INTO primary_claim_id;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM "payment_reference_claim_collisions"
      WHERE "claim_id" = primary_claim_id AND "status" = 'UNRESOLVED'
    ) INTO unresolved_collision_exists;

    IF NOT unresolved_collision_exists THEN
      INSERT INTO "payment_reference_claim_collisions" (
        "claim_id", "provider", "provider_reference", "competing_records", "status"
      )
      VALUES (
        primary_claim_id, rec."provider", rec.norm_ref, competing_json, 'UNRESOLVED'
      );
    END IF;

    IF NOT COALESCE(was_already_quarantined, FALSE) THEN
      INSERT INTO "payment_reference_claim_events" (
        "claim_id", "provider", "provider_reference", "action",
        "new_status", "evidence_tier", "reason", "metadata"
      )
      VALUES (
        primary_claim_id, rec."provider", rec.norm_ref, 'COLLISION_QUARANTINED',
        'UNRESOLVED_COLLISION', 'UNRESOLVED',
        'Canonical case/whitespace collision detected and quarantined during P0.2 hardening migration',
        jsonb_build_object('competing_records', competing_json)
      );
    END IF;
  END LOOP;

  -- B. Preflight check for duplicate same-org successful STK transactions under canonical ref
  SELECT COUNT(*) INTO bad_stk_dupe_count
  FROM (
    SELECT "provider", UPPER(BTRIM("provider_reference"))
    FROM "stk_push_transactions"
    WHERE "status" = 'SUCCESS'
      AND "provider_reference" IS NOT NULL
      AND BTRIM("provider_reference") <> ''
    GROUP BY "provider", UPPER(BTRIM("provider_reference"))
    HAVING COUNT(*) > 1
  ) dupes;

  IF bad_stk_dupe_count > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_BLOCKER: Found % duplicate canonical provider_reference group(s) among SUCCESS stk_push_transactions.', bad_stk_dupe_count;
  END IF;

  -- C. Normalize remaining non-colliding claim references, collision rows, and STK references
  UPDATE "payment_reference_claims"
  SET
    "provider_reference" = UPPER(BTRIM("provider_reference")),
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "provider_reference" <> UPPER(BTRIM("provider_reference"));

  UPDATE "payment_reference_claims"
  SET
    "payment_id" = NULL,
    "checkout_id" = NULL,
    "expires_at" = NULL,
    "confirmed_at" = NULL,
    "confirmed_by_id" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "status" IN ('UNRESOLVED_COLLISION', 'RELEASED')
    AND ("payment_id" IS NOT NULL OR "checkout_id" IS NOT NULL OR "organization_id" IS NOT NULL);

  UPDATE "payment_reference_claims"
  SET
    "evidence_tier" = 'AUTHORITATIVE_PROVIDER',
    "confirmed_at" = COALESCE("confirmed_at", "claimed_at"),
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "status" = 'CONFIRMED_PROVIDER'
    AND ("evidence_tier" <> 'AUTHORITATIVE_PROVIDER' OR "confirmed_at" IS NULL);

  UPDATE "payment_reference_claim_collisions"
  SET "provider_reference" = UPPER(BTRIM("provider_reference"))
  WHERE "provider_reference" <> UPPER(BTRIM("provider_reference"));

  UPDATE "stk_push_transactions"
  SET
    "provider_reference" = UPPER(BTRIM("provider_reference")),
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "status" = 'SUCCESS'
    AND "provider_reference" IS NOT NULL
    AND "provider_reference" <> UPPER(BTRIM("provider_reference"));
END $$;

-- 2. Upgrade Foreign Keys to Restrictive Deletion
ALTER TABLE "payment_reference_claims"
  DROP CONSTRAINT IF EXISTS "payment_reference_claims_payment_id_fkey",
  ADD CONSTRAINT "payment_reference_claims_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "normalized_payments"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "payment_reference_claim_events"
  DROP CONSTRAINT IF EXISTS "payment_reference_claim_events_claim_id_fkey",
  ADD CONSTRAINT "payment_reference_claim_events_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "payment_reference_claims"("id") ON DELETE RESTRICT;

ALTER TABLE "payment_reference_claim_collisions"
  DROP CONSTRAINT IF EXISTS "payment_reference_claim_collisions_claim_id_fkey",
  ADD CONSTRAINT "payment_reference_claim_collisions_claim_id_fkey"
    FOREIGN KEY ("claim_id") REFERENCES "payment_reference_claims"("id") ON DELETE RESTRICT;

-- 3. Enforce Canonical Reference, Null-Org Ownership, and Status Invariants
ALTER TABLE "payment_reference_claims"
  DROP CONSTRAINT IF EXISTS "chk_claim_provider_ref_canonical",
  ADD CONSTRAINT "chk_claim_provider_ref_canonical"
    CHECK (
      "provider_reference" = UPPER(BTRIM("provider_reference"))
      AND LENGTH(BTRIM("provider_reference")) > 0
      AND "provider_reference" !~ '[[:space:]]'
    );

ALTER TABLE "payment_reference_claims"
  DROP CONSTRAINT IF EXISTS "chk_claim_org_nullability",
  ADD CONSTRAINT "chk_claim_org_nullability"
    CHECK (
      ("status" IN ('UNRESOLVED_COLLISION', 'RELEASED') AND "organization_id" IS NULL)
      OR ("status" NOT IN ('UNRESOLVED_COLLISION', 'RELEASED') AND "organization_id" IS NOT NULL)
    );

ALTER TABLE "payment_reference_claims"
  DROP CONSTRAINT IF EXISTS "chk_claim_confirmed_authoritative",
  ADD CONSTRAINT "chk_claim_confirmed_authoritative"
    CHECK (
      "status" <> 'CONFIRMED_PROVIDER'
      OR ("evidence_tier" = 'AUTHORITATIVE_PROVIDER' AND "confirmed_at" IS NOT NULL)
    );

ALTER TABLE "payment_reference_claim_collisions"
  DROP CONSTRAINT IF EXISTS "chk_claim_collision_provider_ref_canonical",
  ADD CONSTRAINT "chk_claim_collision_provider_ref_canonical"
    CHECK (
      "provider_reference" = UPPER(BTRIM("provider_reference"))
      AND LENGTH(BTRIM("provider_reference")) > 0
      AND "provider_reference" !~ '[[:space:]]'
    );

ALTER TABLE "payment_reference_claim_collisions"
  DROP CONSTRAINT IF EXISTS "chk_claim_collision_status",
  ADD CONSTRAINT "chk_claim_collision_status"
    CHECK ("status" IN ('UNRESOLVED', 'ADJUDICATED', 'RELEASED'));

ALTER TABLE "payment_reference_claim_events"
  DROP CONSTRAINT IF EXISTS "chk_claim_event_provider_ref_canonical",
  ADD CONSTRAINT "chk_claim_event_provider_ref_canonical"
    CHECK (
      "provider_reference" = UPPER(BTRIM("provider_reference"))
      AND LENGTH(BTRIM("provider_reference")) > 0
      AND "provider_reference" !~ '[[:space:]]'
    ) NOT VALID;

DO $$
BEGIN
  ALTER TABLE "payment_reference_claim_events"
    VALIDATE CONSTRAINT "chk_claim_event_provider_ref_canonical";
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE 'Existing immutable claim events left unvalidated; all new inserts enforce chk_claim_event_provider_ref_canonical.';
END $$;

-- 4. Expression-Level Canonical Uniqueness Protection
CREATE UNIQUE INDEX IF NOT EXISTS "payment_reference_claims_canonical_ref_unique"
  ON "payment_reference_claims"("provider", UPPER(BTRIM("provider_reference")));

CREATE UNIQUE INDEX IF NOT EXISTS "stk_push_transactions_canonical_provider_ref_success_unique"
  ON "stk_push_transactions"("provider", UPPER(BTRIM("provider_reference")))
  WHERE "status" = 'SUCCESS'
    AND "provider_reference" IS NOT NULL
    AND BTRIM("provider_reference") <> '';
