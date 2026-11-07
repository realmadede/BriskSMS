-- CreateTable
CREATE TABLE "smsgate_signing_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "device_id" VARCHAR(100),
    "encrypted_key" TEXT NOT NULL,
    "encrypted_prev_key" TEXT,
    "rotated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smsgate_signing_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "smsgate_signing_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "smsgate_signing_keys_organization_id_device_id_key" ON "smsgate_signing_keys"("organization_id", "device_id") WHERE "device_id" IS NOT NULL;
CREATE UNIQUE INDEX "smsgate_signing_keys_organization_id_default_key" ON "smsgate_signing_keys"("organization_id") WHERE "device_id" IS NULL;
CREATE INDEX "smsgate_signing_keys_organization_id_idx" ON "smsgate_signing_keys"("organization_id");

-- CreateTable
CREATE TABLE "smsgate_webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "device_id" VARCHAR(100),
    "event_fingerprint" VARCHAR(128) NOT NULL,
    "provider_message_id" VARCHAR(100) NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "signature" VARCHAR(128) NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'PROCESSED',
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smsgate_webhook_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "smsgate_webhook_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "smsgate_webhook_events_event_fingerprint_key" ON "smsgate_webhook_events"("event_fingerprint");
CREATE INDEX "smsgate_webhook_events_organization_id_provider_message_id_idx" ON "smsgate_webhook_events"("organization_id", "provider_message_id");
