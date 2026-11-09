-- CreateTable
CREATE TABLE "message_idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(80) NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "message_id" UUID,
    "response_payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_idempotency_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "message_idempotency_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "message_idempotency_records_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "sms_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "message_idempotency_records_org_key_unique" ON "message_idempotency_records"("organization_id", "idempotency_key");
CREATE INDEX "message_idempotency_records_organization_id_status_idx" ON "message_idempotency_records"("organization_id", "status");
