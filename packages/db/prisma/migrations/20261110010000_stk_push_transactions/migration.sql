-- ==============================================================================
-- Migration: 20261110010000_stk_push_transactions
-- Description: Introduces stk_push_transactions table for tracking carrier USSD/STK pushes,
--              status polling, and asynchronous webhook callback reconciliation.
-- ==============================================================================

-- 1. Create StkPushStatus enum
CREATE TYPE "StkPushStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED');

-- 2. Create stk_push_transactions table
CREATE TABLE "stk_push_transactions" (
    "id" VARCHAR(64) PRIMARY KEY NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "phone_number" VARCHAR(32) NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'TZS',
    "status" "StkPushStatus" NOT NULL DEFAULT 'PENDING',
    "invoice_id" UUID,
    "reference_number" VARCHAR(100),
    "memo" VARCHAR(255),
    "provider_reference" VARCHAR(100),
    "result_code" INTEGER,
    "result_description" TEXT,
    "error_message" TEXT,
    "settled_payment_id" UUID,
    "raw_callback_payload" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stk_push_transactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stk_push_transactions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stk_push_transactions_settled_payment_id_fkey" FOREIGN KEY ("settled_payment_id") REFERENCES "normalized_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- 3. Indexes for fast status polling, organization queries, and carrier reference matching
CREATE INDEX "stk_push_transactions_org_id_idx" ON "stk_push_transactions"("organization_id");
CREATE INDEX "stk_push_transactions_status_idx" ON "stk_push_transactions"("status");
CREATE INDEX "stk_push_transactions_provider_ref_idx" ON "stk_push_transactions"("provider_reference");
CREATE INDEX "stk_push_transactions_phone_number_idx" ON "stk_push_transactions"("phone_number");
