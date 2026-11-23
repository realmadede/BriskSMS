-- A customer's request to pay for a paid plan. Each one is backed by an ordinary invoice in the
-- platform billing workspace, so the payment is matched and verified by the normal reconciliation
-- engine. When that invoice is paid, the subscription is activated in the same transaction.
CREATE TABLE "billing_checkout_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "billing_organization_id" UUID NOT NULL,
    "billing_invoice_id" UUID NOT NULL,
    "reference_number" VARCHAR(100) NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "billing_interval" "BillingInterval" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "activated_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    CONSTRAINT "billing_checkout_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_checkout_requests_status_check" CHECK ("status" IN ('PENDING', 'ACTIVATED', 'CANCELLED')),
    CONSTRAINT "billing_checkout_requests_org_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
    CONSTRAINT "billing_checkout_requests_billing_org_fkey" FOREIGN KEY ("billing_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
    CONSTRAINT "billing_checkout_requests_invoice_fkey" FOREIGN KEY ("billing_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT,
    CONSTRAINT "billing_checkout_requests_plan_version_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "billing_checkout_requests_invoice_key" ON "billing_checkout_requests" ("billing_invoice_id");
-- A workspace has at most one open request at a time
CREATE UNIQUE INDEX "billing_checkout_requests_one_pending_key" ON "billing_checkout_requests" ("organization_id") WHERE "status" = 'PENDING';
CREATE INDEX "billing_checkout_requests_org_created_idx" ON "billing_checkout_requests" ("organization_id", "created_at" DESC);
