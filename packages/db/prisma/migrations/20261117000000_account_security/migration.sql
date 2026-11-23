-- Account security: 2FA recovery codes, pending email change, and a 30-day deletion hold.
ALTER TABLE "users" ALTER COLUMN "two_factor_secret" TYPE VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "two_factor_recovery_hashes" TEXT;
ALTER TABLE "users" ADD COLUMN "pending_email" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "deletion_scheduled_for" TIMESTAMPTZ(6);

-- A workspace is either an organization or one person. Existing auto-named workspaces are personal.
ALTER TABLE "organizations" ADD COLUMN "account_type" VARCHAR(20) NOT NULL DEFAULT 'ORGANIZATION';
UPDATE "organizations" SET "account_type" = 'PERSONAL' WHERE "name" LIKE '%''s Workspace';
