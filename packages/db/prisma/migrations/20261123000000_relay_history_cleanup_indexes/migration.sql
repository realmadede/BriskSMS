-- Lets the worker find finished outbound SMS jobs and device commands that are past their retention
-- period without scanning the whole table. Each index holds only finished rows, so it stays small
-- and does not slow down the live queue, which uses the separate acquire and poll indexes.
--
-- If these tables are ever large when this runs, build the indexes first with CREATE INDEX
-- CONCURRENTLY outside a transaction; IF NOT EXISTS then makes this migration a no-op.

CREATE INDEX IF NOT EXISTS "outbound_sms_jobs_history_cleanup_idx"
  ON "outbound_sms_jobs"("updated_at")
  WHERE "status" IN ('DELIVERED', 'FAILED', 'EXPIRED', 'CANCELLED');

CREATE INDEX IF NOT EXISTS "device_commands_history_cleanup_idx"
  ON "device_commands"("updated_at")
  WHERE "status" IN ('ACKNOWLEDGED', 'FAILED', 'EXPIRED', 'CANCELLED');
