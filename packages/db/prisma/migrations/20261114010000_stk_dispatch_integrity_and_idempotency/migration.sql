-- ==============================================================================
-- Migration: 20261114010000_stk_dispatch_integrity_and_idempotency
-- Description: Additive P0 Carrier Dispatch Adapter Integrity & Idempotency:
--              1. Adds INITIATING, DISPATCH_UNCERTAIN, and UNSUPPORTED values to StkPushStatus.
--              2. Adds idempotency_key, request_fingerprint, provider_checkout_id, and
--                 dispatch_outcome columns to stk_push_transactions.
--              3. Adds org-scoped idempotency uniqueness and provider_checkout_id lookup index.
-- ==============================================================================

ALTER TYPE "StkPushStatus" ADD VALUE IF NOT EXISTS 'INITIATING';
ALTER TYPE "StkPushStatus" ADD VALUE IF NOT EXISTS 'DISPATCH_UNCERTAIN';
ALTER TYPE "StkPushStatus" ADD VALUE IF NOT EXISTS 'UNSUPPORTED';

ALTER TABLE "stk_push_transactions"
  ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "request_fingerprint" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "provider_checkout_id" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "dispatch_outcome" VARCHAR(40);

CREATE UNIQUE INDEX IF NOT EXISTS "stk_push_transactions_org_idempotency_unique"
  ON "stk_push_transactions"("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "stk_push_transactions_provider_checkout_idx"
  ON "stk_push_transactions"("provider", "provider_checkout_id")
  WHERE "provider_checkout_id" IS NOT NULL;
