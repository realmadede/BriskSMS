-- ==============================================================================
-- P0: Android Device Pairing Proof-of-Possession (Challenge-Response Enrollment)
-- ==============================================================================
-- Adds cryptographic key metadata and uniqueness to devices, plus durable,
-- single-use, auditable pairing challenges bound to pairing token, organization,
-- enrollment attempt, public key fingerprint, algorithm, nonce, and expiry.

CREATE TYPE "PairingChallengeStatus" AS ENUM ('PENDING', 'CONSUMED', 'EXPIRED', 'REJECTED');

ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "public_key_fingerprint" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "key_algorithm" VARCHAR(32) NOT NULL DEFAULT 'EC_P256';

CREATE UNIQUE INDEX IF NOT EXISTS "devices_public_key_fingerprint_key"
  ON "devices"("public_key_fingerprint");

CREATE TABLE "device_pairing_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "pairing_token_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "challenge_nonce" VARCHAR(128) NOT NULL,
  "public_key_pem" TEXT NOT NULL,
  "public_key_fingerprint" VARCHAR(64) NOT NULL,
  "key_algorithm" VARCHAR(32) NOT NULL DEFAULT 'EC_P256',
  "signature_algorithm" VARCHAR(32) NOT NULL DEFAULT 'SHA256_ECDSA',
  "protocol_version" VARCHAR(64) NOT NULL DEFAULT 'BRISKSMS-DEVICE-PAIRING-POP-V1',
  "status" "PairingChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "rejected_at" TIMESTAMPTZ(6),
  "failure_reason" VARCHAR(255),
  "resulting_device_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "device_pairing_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_pairing_challenges_pairing_token_id_fkey"
    FOREIGN KEY ("pairing_token_id") REFERENCES "pairing_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_pairing_challenges_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "device_pairing_challenges_resulting_device_id_fkey"
    FOREIGN KEY ("resulting_device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "device_pairing_challenges_enrollment_id_key"
  ON "device_pairing_challenges"("enrollment_id");

CREATE INDEX "device_pairing_challenges_pairing_token_id_status_idx"
  ON "device_pairing_challenges"("pairing_token_id", "status");

CREATE INDEX "device_pairing_challenges_organization_id_expires_at_idx"
  ON "device_pairing_challenges"("organization_id", "expires_at");

CREATE INDEX "device_pairing_challenges_public_key_fingerprint_idx"
  ON "device_pairing_challenges"("public_key_fingerprint");
