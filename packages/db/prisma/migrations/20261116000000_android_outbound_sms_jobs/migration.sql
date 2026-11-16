-- ==============================================================================
-- P1: Android Outbound SMSGate Job Acquisition Queue
-- ==============================================================================
-- Separate from device_commands (fleet management) and from external HTTP SMSGate
-- webhook delivery. Tracks durable PostgreSQL-backed outbound SMS jobs acquired
-- by paired BriskSMS Android companions, enforcing separate claim vs dispatch
-- intent, bounded leases, uncertain-dispatch protection, and idempotent refunds.

CREATE TYPE "OutboundSmsJobStatus" AS ENUM (
  'QUEUED',
  'CLAIMED',
  'DISPATCHING',
  'SUBMITTED',
  'DELIVERED',
  'FAILED',
  'EXPIRED',
  'UNCERTAIN',
  'CANCELLED'
);

CREATE TABLE "outbound_sms_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "assigned_device_id" UUID,
  "claimed_by_device_id" UUID,
  "idempotency_key" VARCHAR(120),
  "request_fingerprint" VARCHAR(64) NOT NULL,
  "recipient_phone" VARCHAR(50) NOT NULL,
  "message_text" TEXT NOT NULL,
  "sim_slot" SMALLINT NOT NULL DEFAULT 1,
  "status" "OutboundSmsJobStatus" NOT NULL DEFAULT 'QUEUED',
  "lease_token" VARCHAR(128),
  "lease_expires_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "claimed_at" TIMESTAMPTZ(6),
  "dispatch_started_at" TIMESTAMPTZ(6),
  "submitted_at" TIMESTAMPTZ(6),
  "delivered_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "gateway_reference" VARCHAR(120),
  "radio_result_code" INTEGER,
  "failure_code" VARCHAR(64),
  "error_message" TEXT,
  "last_result_payload" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "outbound_sms_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbound_sms_jobs_message_id_key" UNIQUE ("message_id"),
  CONSTRAINT "outbound_sms_jobs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "outbound_sms_jobs_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "sms_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "outbound_sms_jobs_assigned_device_id_fkey"
    FOREIGN KEY ("assigned_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "outbound_sms_jobs_claimed_by_device_id_fkey"
    FOREIGN KEY ("claimed_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "outbound_sms_jobs_sim_slot_check"
    CHECK ("sim_slot" IN (1, 2)),
  CONSTRAINT "outbound_sms_jobs_attempts_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" >= 1 AND "attempt_count" <= "max_attempts"),
  CONSTRAINT "outbound_sms_jobs_expiry_check"
    CHECK ("expires_at" >= "created_at")
);

CREATE UNIQUE INDEX "outbound_sms_jobs_org_idempotency_unique"
  ON "outbound_sms_jobs"("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX "outbound_sms_jobs_acquire_idx"
  ON "outbound_sms_jobs"("organization_id", "status", "assigned_device_id", "lease_expires_at", "expires_at", "created_at")
  WHERE "status" IN ('QUEUED', 'CLAIMED', 'DISPATCHING');

CREATE INDEX "outbound_sms_jobs_org_created_idx"
  ON "outbound_sms_jobs"("organization_id", "created_at" DESC);
