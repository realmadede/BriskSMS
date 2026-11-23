-- Fixed packs of prepaid SMS credits that a workspace can buy, configured by the platform admin.
-- Kept apart from the plan catalog: credits belong to the bulk messaging ledger only.
CREATE TABLE "credit_packs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "credits" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "credit_packs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_packs_credits_check" CHECK ("credits" > 0),
    CONSTRAINT "credit_packs_amount_check" CHECK ("amount_cents" > 0)
);

CREATE UNIQUE INDEX "credit_packs_code_key" ON "credit_packs" ("code");

-- A customer's request to buy a pack. Like a plan request, it is backed by an ordinary invoice in the
-- platform billing workspace; when that invoice is paid the credits are added in the same transaction.
-- Credits and price are copied from the pack, so later pack edits never change an issued request.
CREATE TABLE "credit_purchases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "billing_organization_id" UUID NOT NULL,
    "billing_invoice_id" UUID NOT NULL,
    "reference_number" VARCHAR(100) NOT NULL,
    "pack_id" UUID NOT NULL,
    "credits" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "activated_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    CONSTRAINT "credit_purchases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_purchases_status_check" CHECK ("status" IN ('PENDING', 'ACTIVATED', 'CANCELLED')),
    CONSTRAINT "credit_purchases_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
    CONSTRAINT "credit_purchases_billing_org_fkey" FOREIGN KEY ("billing_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
    CONSTRAINT "credit_purchases_invoice_fkey" FOREIGN KEY ("billing_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT,
    CONSTRAINT "credit_purchases_pack_fkey" FOREIGN KEY ("pack_id") REFERENCES "credit_packs"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "credit_purchases_invoice_key" ON "credit_purchases" ("billing_invoice_id");
-- A workspace has at most one open credit purchase at a time
CREATE UNIQUE INDEX "credit_purchases_one_pending_key" ON "credit_purchases" ("organization_id") WHERE "status" = 'PENDING';
CREATE INDEX "credit_purchases_org_created_idx" ON "credit_purchases" ("organization_id", "created_at" DESC);
