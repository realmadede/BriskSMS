-- ==============================================================================
-- Migration: 20261110000000_email_verification_and_google_auth
-- Description: Adds Google SSO fields to users and introduces secure email
--              verification token tracking with single-use atomic consumption.
-- ==============================================================================

-- 1. Allow password_hash to be nullable for SSO users (e.g. Google Sign-In)
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- 2. Add Google Identity and OAuth provider fields to users
ALTER TABLE "users" ADD COLUMN "google_id" VARCHAR(255);
ALTER TABLE "users" ADD COLUMN "auth_provider" VARCHAR(32) NOT NULL DEFAULT 'LOCAL';
ALTER TABLE "users" ADD COLUMN "avatar_url" TEXT;

-- 3. Unique index on google_id (ignoring NULLs)
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id") WHERE "google_id" IS NOT NULL;

-- 4. Create email verification tokens table
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_verification_tokens_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 5. Indexes for fast token lookup and expiry enforcement
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");
CREATE INDEX "email_verification_tokens_token_hash_expires_at_idx" ON "email_verification_tokens"("token_hash", "expires_at");
