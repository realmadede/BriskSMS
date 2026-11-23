-- Append-only record of every action taken from the platform admin console (/nexus).
-- Not tied to one organization: target_organization_id is set only when an action concerns a workspace.
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_user_id" UUID NOT NULL,
    "ip_address" VARCHAR(64),
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50),
    "target_id" VARCHAR(100),
    "target_organization_id" UUID,
    "reason" TEXT,
    "previous_state" JSONB,
    "new_state" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs" ("created_at" DESC);
CREATE INDEX "platform_audit_logs_action_idx" ON "platform_audit_logs" ("action", "created_at" DESC);

CREATE TRIGGER "platform_audit_logs_immutable"
  BEFORE UPDATE OR DELETE ON "platform_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();
