-- Durable dispatch claim/lease for message idempotency records.
-- PENDING      = reserved and credit deducted, gateway definitely NOT contacted (safe to dispatch).
-- DISPATCHING  = claimed by one dispatcher; gateway MAY have been contacted (never re-dispatched).
-- UNCERTAIN    = gateway outcome cannot be established; never auto-refunded, never auto-redispatched.
ALTER TABLE "message_idempotency_records"
    ADD COLUMN "claimed_by" VARCHAR(64),
    ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6),
    ADD COLUMN "dispatch_started_at" TIMESTAMPTZ(6),
    ADD CONSTRAINT "message_idempotency_records_status_check"
        CHECK ("status" IN ('PENDING', 'DISPATCHING', 'COMPLETED', 'FAILED', 'UNCERTAIN'));

CREATE INDEX "message_idempotency_records_unsettled_idx"
    ON "message_idempotency_records"("status", "created_at")
    WHERE "status" IN ('PENDING', 'DISPATCHING', 'UNCERTAIN');
