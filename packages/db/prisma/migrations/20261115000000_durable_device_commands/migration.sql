-- ==============================================================================
-- P1: Durable PostgreSQL-Backed Fleet Command Queue
-- ==============================================================================
-- Replaces process-local pendingCommands Map with durable, tenant-scoped
-- PostgreSQL command persistence, atomic FOR UPDATE SKIP LOCKED claiming,
-- bounded delivery leases, idempotent acknowledgements, and full history.

CREATE TYPE "DeviceCommandType" AS ENUM (
  'PAUSE_RELAY',
  'RESUME_RELAY',
  'SWITCH_SIM',
  'WIPE_AND_REVOKE'
);

CREATE TYPE "DeviceCommandStatus" AS ENUM (
  'PENDING',
  'DELIVERED',
  'ACKNOWLEDGED',
  'FAILED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "device_commands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "created_by_id" UUID,
  "source" VARCHAR(32) NOT NULL DEFAULT 'ADMIN_API',
  "command_type" "DeviceCommandType" NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" "DeviceCommandStatus" NOT NULL DEFAULT 'PENDING',
  "idempotency_key" VARCHAR(120),
  "request_fingerprint" VARCHAR(64),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
  "max_delivery_attempts" INTEGER NOT NULL DEFAULT 5,
  "lease_token" UUID,
  "claimed_by_instance" VARCHAR(64),
  "delivered_at" TIMESTAMPTZ(6),
  "last_delivery_attempt_at" TIMESTAMPTZ(6),
  "lease_expires_at" TIMESTAMPTZ(6),
  "acknowledged_at" TIMESTAMPTZ(6),
  "ack_result" JSONB,
  "failure_reason" VARCHAR(255),
  "cancelled_at" TIMESTAMPTZ(6),
  "cancelled_by_id" UUID,
  "cancellation_reason" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_commands_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "device_commands_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_commands_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "device_commands_cancelled_by_id_fkey"
    FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "device_commands_attempts_check"
    CHECK ("delivery_attempts" >= 0 AND "max_delivery_attempts" >= 1 AND "delivery_attempts" <= "max_delivery_attempts"),
  CONSTRAINT "device_commands_expiry_check"
    CHECK ("expires_at" >= "created_at")
);

CREATE UNIQUE INDEX "device_commands_org_idempotency_unique"
  ON "device_commands"("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX "device_commands_poll_queue_idx"
  ON "device_commands"("organization_id", "device_id", "created_at" ASC)
  WHERE "status" IN ('PENDING', 'DELIVERED');

CREATE INDEX "device_commands_org_device_history_idx"
  ON "device_commands"("organization_id", "device_id", "created_at" DESC);
