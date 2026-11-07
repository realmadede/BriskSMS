-- ==============================================================================
-- BriskSMS Milestone 1: Authoritative PostgreSQL Foundation Migration
-- Migration ID: 20261107000000_init_foundation
-- ==============================================================================

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. Enums
-- ------------------------------------------------------------------------------

CREATE TYPE "TransactionState" AS ENUM (
  'OBSERVED',
  'NORMALIZED',
  'DUPLICATE_REJECTED',
  'UNMATCHED',
  'MATCHED',
  'VERIFICATION_PENDING',
  'VERIFIED',
  'REJECTED',
  'REVIEW_REQUIRED',
  'FULFILLMENT_PENDING',
  'FULFILLED',
  'FULFILLMENT_FAILED'
);

CREATE TYPE "PaymentProvider" AS ENUM (
  'MPESA',
  'MIXX',
  'AIRTEL_MONEY',
  'HALOPESA',
  'TTCL_PESA',
  'CRDB_BANK',
  'NMB_BANK',
  'MANUAL_BANK_TRANSFER'
);

CREATE TYPE "UserRole" AS ENUM (
  'OWNER',
  'ADMIN',
  'FINANCE',
  'CASHIER',
  'DEVELOPER'
);

CREATE TYPE "DeviceStatus" AS ENUM (
  'PENDING_PAIRING',
  'ACTIVE',
  'DISCONNECTED',
  'QUARANTINED',
  'REVOKED'
);

CREATE TYPE "DeviceIngestionMode" AS ENUM (
  'NOTIFICATION_LISTENER',
  'SMS_RECEIVER',
  'HYBRID'
);

CREATE TYPE "EvidenceSourceType" AS ENUM (
  'ANDROID_NOTIFICATION_RELAY',
  'DIRECT_PROVIDER_API',
  'UNIFIED_AGGREGATOR',
  'BANK_INTEGRATION',
  'AUTHORIZED_MANUAL_IMPORT'
);

CREATE TYPE "InvoiceStatus" AS ENUM (
  'UNPAID',
  'PARTIALLY_PAID',
  'PAID',
  'OVERPAID',
  'VOID',
  'REFUNDED'
);

CREATE TYPE "CreditLedgerEntryType" AS ENUM (
  'PURCHASE',
  'RESERVATION',
  'RELEASE',
  'USAGE_DEDUCTION',
  'REFUND',
  'ADMIN_ADJUSTMENT'
);

CREATE TYPE "SmsStatus" AS ENUM (
  'QUEUED',
  'SUBMITTED',
  'DELIVERED',
  'UNDELIVERED',
  'FAILED'
);

CREATE TYPE "CampaignStatus" AS ENUM (
  'DRAFT',
  'SCHEDULED',
  'DISPATCHING',
  'COMPLETED',
  'PAUSED',
  'CANCELLED'
);

CREATE TYPE "GatewayMode" AS ENUM (
  'MANAGED_GATEWAY',
  'EXTERNAL_RELAY',
  'TELCO_AGGREGATOR'
);

CREATE TYPE "SenderIdStatus" AS ENUM (
  'PENDING_DOCUMENTS',
  'SUBMITTED_TO_TCRA',
  'APPROVED',
  'REJECTED'
);

CREATE TYPE "OutboxStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'DEAD_LETTER'
);

CREATE TYPE "VerificationMethod" AS ENUM (
  'INDEPENDENT_PROVIDER_QUERY',
  'BANK_STATEMENT_RECONCILIATION',
  'MANUAL_FINANCE_APPROVAL',
  'MANUAL_REJECTION'
);

CREATE TYPE "ProductType" AS ENUM (
  'PAYMENT_INTELLIGENCE',
  'BULK_MESSAGING'
);

CREATE TYPE "BillingInterval" AS ENUM (
  'MONTHLY',
  'QUARTERLY',
  'SEMI_ANNUALLY',
  'ANNUALLY',
  'CUSTOM'
);

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELED',
  'EXPIRED'
);

CREATE TYPE "EntitlementType" AS ENUM (
  'NUMERIC_LIMIT',
  'BOOLEAN_FLAG',
  'TIERED_TIER'
);

-- ------------------------------------------------------------------------------
-- 2. Identity & Organizations
-- ------------------------------------------------------------------------------

CREATE TABLE "organizations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(255) NOT NULL,
  "slug" VARCHAR(100) NOT NULL,
  "country_code" VARCHAR(3) NOT NULL DEFAULT 'TZA',
  "timezone" VARCHAR(50) NOT NULL DEFAULT 'Africa/Dar_es_Salaam',
  "plan_tier" VARCHAR(50) NOT NULL DEFAULT 'STARTER',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" VARCHAR(255) NOT NULL,
  "password_hash" VARCHAR(255) NOT NULL,
  "full_name" VARCHAR(255) NOT NULL,
  "phone_number" VARCHAR(50),
  "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "two_factor_secret" VARCHAR(100),
  "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "users_organizations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'FINANCE',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "users_organizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "users_organizations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "users_organizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "users_organizations_organization_id_user_id_key" ON "users_organizations"("organization_id", "user_id");
CREATE INDEX "users_organizations_user_id_idx" ON "users_organizations"("user_id");

CREATE TABLE "organization_invitations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'FINANCE',
  "invited_by_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "accepted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");
CREATE INDEX "organization_invitations_organization_id_status_idx" ON "organization_invitations"("organization_id", "status");

CREATE TABLE "refresh_tokens" (
  "token_hash" VARCHAR(64) NOT NULL,
  "user_id" UUID NOT NULL,
  "jti" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("token_hash"),
  CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX "refresh_tokens_jti_idx" ON "refresh_tokens"("jti");

CREATE TABLE "revoked_sessions" (
  "jti" VARCHAR(64) NOT NULL,
  "user_id" UUID,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "revoked_sessions_expires_at_idx" ON "revoked_sessions"("expires_at");

-- ------------------------------------------------------------------------------
-- 3. Devices & Android Telemetry
-- ------------------------------------------------------------------------------

CREATE TABLE "devices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "label" VARCHAR(100) NOT NULL,
  "device_model" VARCHAR(100) NOT NULL,
  "manufacturer" VARCHAR(100) NOT NULL,
  "android_version" VARCHAR(20) NOT NULL,
  "app_version" VARCHAR(20) NOT NULL,
  "public_key_pem" TEXT NOT NULL,
  "device_token_hash" VARCHAR(64) NOT NULL,
  "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING_PAIRING',
  "ingestion_mode" "DeviceIngestionMode" NOT NULL DEFAULT 'NOTIFICATION_LISTENER',
  "last_sync_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "revoked_by_id" UUID,
  "revocation_reason" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "devices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "devices_device_token_hash_key" ON "devices"("device_token_hash");
CREATE INDEX "devices_organization_id_status_idx" ON "devices"("organization_id", "status");

CREATE TABLE "pairing_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "token" VARCHAR(128) NOT NULL,
  "organization_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "used_by_device_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pairing_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pairing_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pairing_tokens_token_key" ON "pairing_tokens"("token");
CREATE INDEX "pairing_tokens_organization_id_expires_at_idx" ON "pairing_tokens"("organization_id", "expires_at");

CREATE TABLE "device_telemetry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "device_id" UUID NOT NULL,
  "battery_pct" SMALLINT NOT NULL,
  "is_charging" BOOLEAN NOT NULL,
  "network_type" VARCHAR(20) NOT NULL,
  "signal_strength_dbm" INTEGER,
  "pending_offline_count" INTEGER NOT NULL DEFAULT 0,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "device_telemetry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_telemetry_battery_check" CHECK ("battery_pct" >= 0 AND "battery_pct" <= 100),
  CONSTRAINT "device_telemetry_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "device_telemetry_device_id_recorded_at_idx" ON "device_telemetry"("device_id", "recorded_at" DESC);

-- ------------------------------------------------------------------------------
-- 4. Customers, Invoices & Payment Intelligence
-- ------------------------------------------------------------------------------

CREATE TABLE "customers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "account_number" VARCHAR(100) NOT NULL,
  "full_name" VARCHAR(255) NOT NULL,
  "phone_number" VARCHAR(50),
  "email" VARCHAR(255),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "customers_organization_id_account_number_key" ON "customers"("organization_id", "account_number");
CREATE INDEX "customers_organization_id_phone_number_idx" ON "customers"("organization_id", "phone_number");

CREATE TABLE "invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "customer_id" UUID,
  "reference_number" VARCHAR(100) NOT NULL,
  "total_amount_cents" BIGINT NOT NULL,
  "paid_amount_cents" BIGINT NOT NULL DEFAULT 0,
  "balance_cents" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'TZS',
  "customer_phone" VARCHAR(50),
  "customer_name" VARCHAR(255),
  "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
  "due_date" TIMESTAMPTZ(6),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoices_amounts_non_negative_check" CHECK ("total_amount_cents" > 0 AND "paid_amount_cents" >= 0 AND "balance_cents" >= 0),
  CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "invoices_organization_id_reference_number_key" ON "invoices"("organization_id", "reference_number");
CREATE INDEX "invoices_organization_id_status_due_date_idx" ON "invoices"("organization_id", "status", "due_date");
CREATE INDEX "invoices_organization_id_customer_phone_idx" ON "invoices"("organization_id", "customer_phone");

CREATE TABLE "invoice_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "invoice_id" UUID NOT NULL,
  "description" VARCHAR(255) NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unit_price_cents" BIGINT NOT NULL,
  "total_price_cents" BIGINT NOT NULL,

  CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "raw_payment_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "source_type" "EvidenceSourceType" NOT NULL DEFAULT 'ANDROID_NOTIFICATION_RELAY',
  "device_id" UUID,
  "sender_address" VARCHAR(100) NOT NULL,
  "raw_payload" TEXT NOT NULL,
  "sim_slot" SMALLINT NOT NULL DEFAULT 1,
  "device_timestamp" TIMESTAMPTZ(6) NOT NULL,
  "signature" TEXT,
  "nonce" VARCHAR(64),
  "sequence_number" BIGINT,
  "parser_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  "parse_status" VARCHAR(32) NOT NULL DEFAULT 'OBSERVED',
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "raw_payment_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "raw_payment_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "raw_payment_evidence_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "raw_payment_evidence_organization_id_received_at_idx" ON "raw_payment_evidence"("organization_id", "received_at" DESC);
CREATE INDEX "raw_payment_evidence_device_id_sequence_number_idx" ON "raw_payment_evidence"("device_id", "sequence_number");

CREATE TABLE "normalized_payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "device_id" UUID,
  "raw_evidence_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "reference" VARCHAR(100) NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'TZS',
  "sender_phone" VARCHAR(50) NOT NULL,
  "sender_name" VARCHAR(255),
  "recipient_account" VARCHAR(100),
  "customer_memo" VARCHAR(255),
  "provider_timestamp" TIMESTAMPTZ(6) NOT NULL,
  "parser_version" VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  "state" "TransactionState" NOT NULL DEFAULT 'OBSERVED',
  "confidence_tier" VARCHAR(50),
  "deduplication_hash" VARCHAR(64) NOT NULL,
  "candidate_invoice_id" UUID,
  "matched_invoice_id" UUID,
  "review_reason" TEXT,
  "verified_at" TIMESTAMPTZ(6),
  "verified_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "normalized_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "normalized_payments_amount_positive_check" CHECK ("amount_cents" > 0),
  CONSTRAINT "normalized_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "normalized_payments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "normalized_payments_raw_evidence_id_fkey" FOREIGN KEY ("raw_evidence_id") REFERENCES "raw_payment_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "normalized_payments_matched_invoice_id_fkey" FOREIGN KEY ("matched_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "normalized_payments_raw_evidence_id_key" ON "normalized_payments"("raw_evidence_id");
CREATE UNIQUE INDEX "normalized_payments_organization_id_deduplication_hash_key" ON "normalized_payments"("organization_id", "deduplication_hash");
CREATE INDEX "normalized_payments_organization_id_state_created_at_idx" ON "normalized_payments"("organization_id", "state", "created_at" DESC);
CREATE INDEX "normalized_payments_organization_id_reference_idx" ON "normalized_payments"("organization_id", "reference");
CREATE INDEX "normalized_payments_organization_id_sender_phone_idx" ON "normalized_payments"("organization_id", "sender_phone");

CREATE TABLE "payment_verifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "invoice_id" UUID,
  "verification_method" "VerificationMethod" NOT NULL,
  "decision" VARCHAR(20) NOT NULL,
  "verified_by_id" UUID,
  "external_verification_ref" VARCHAR(100),
  "notes" TEXT,
  "previous_state" "TransactionState" NOT NULL,
  "new_state" "TransactionState" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payment_verifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_verifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "payment_verifications_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "normalized_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "payment_verifications_organization_id_payment_id_idx" ON "payment_verifications"("organization_id", "payment_id");

CREATE TABLE "invoice_payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "verification_id" UUID,
  "applied_amount_cents" BIGINT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_payments_applied_amount_positive_check" CHECK ("applied_amount_cents" > 0),
  CONSTRAINT "invoice_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "invoice_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "invoice_payments_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "normalized_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "invoice_payments_invoice_id_payment_id_key" ON "invoice_payments"("invoice_id", "payment_id");
CREATE INDEX "invoice_payments_organization_id_invoice_id_idx" ON "invoice_payments"("organization_id", "invoice_id");
CREATE INDEX "invoice_payments_payment_id_idx" ON "invoice_payments"("payment_id");

-- ------------------------------------------------------------------------------
-- 5. Business Automation Engine
-- ------------------------------------------------------------------------------

CREATE TABLE "automation_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "trigger_event" VARCHAR(100) NOT NULL,
  "conditions" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "action_type" VARCHAR(50) NOT NULL,
  "action_config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "automation_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "automation_rules_organization_id_is_active_idx" ON "automation_rules"("organization_id", "is_active");

CREATE TABLE "automation_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "payment_id" UUID,
  "action_type" VARCHAR(50) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "idempotency_key" VARCHAR(64) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 1,
  "last_error" TEXT,
  "executed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "automation_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "automation_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "automation_logs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "automation_logs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "normalized_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "automation_logs_idempotency_key_key" ON "automation_logs"("idempotency_key");
CREATE INDEX "automation_logs_organization_id_status_idx" ON "automation_logs"("organization_id", "status");

-- ------------------------------------------------------------------------------
-- 6. Product B: Bulk Messaging & Independent Credit Ledger
-- ------------------------------------------------------------------------------

CREATE TABLE "messaging_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "credit_balance" INTEGER NOT NULL DEFAULT 0,
  "reserved_credits" INTEGER NOT NULL DEFAULT 0,
  "gateway_mode" "GatewayMode" NOT NULL DEFAULT 'MANAGED_GATEWAY',
  "gateway_base_url" VARCHAR(255),
  "encrypted_api_token" TEXT,
  "default_sim_slot" INTEGER NOT NULL DEFAULT 1,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "messaging_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messaging_accounts_non_negative_credits_check" CHECK ("credit_balance" >= 0 AND "reserved_credits" >= 0),
  CONSTRAINT "messaging_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "messaging_accounts_organization_id_key" ON "messaging_accounts"("organization_id");

CREATE TABLE "messaging_credit_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "entry_type" "CreditLedgerEntryType" NOT NULL,
  "amount_credits" INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL,
  "reserved_after" INTEGER NOT NULL DEFAULT 0,
  "reference_id" VARCHAR(100),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "messaging_credit_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messaging_credit_ledger_balance_after_check" CHECK ("balance_after" >= 0 AND "reserved_after" >= 0),
  CONSTRAINT "messaging_credit_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "messaging_credit_ledger_organization_id_created_at_idx" ON "messaging_credit_ledger"("organization_id", "created_at" DESC);

CREATE TABLE "sender_ids" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "sender_id" VARCHAR(11) NOT NULL,
  "status" "SenderIdStatus" NOT NULL DEFAULT 'PENDING_DOCUMENTS',
  "rejection_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sender_ids_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sender_ids_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sender_ids_organization_id_sender_id_key" ON "sender_ids"("organization_id", "sender_id");

CREATE TABLE "sms_campaigns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "sender_id_id" UUID,
  "name" VARCHAR(100) NOT NULL,
  "message_template" TEXT NOT NULL,
  "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "recipient_count" INTEGER NOT NULL DEFAULT 0,
  "scheduled_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sms_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sms_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sms_campaigns_sender_id_id_fkey" FOREIGN KEY ("sender_id_id") REFERENCES "sender_ids"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "sms_campaigns_organization_id_status_idx" ON "sms_campaigns"("organization_id", "status");
CREATE INDEX "sms_campaigns_status_scheduled_at_idx" ON "sms_campaigns"("status", "scheduled_at");

CREATE TABLE "sms_campaign_recipients" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "recipient_phone" VARCHAR(50) NOT NULL,
  "variables" JSONB,
  "interpolated_text" TEXT NOT NULL,
  "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
  "message_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sms_campaign_recipients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sms_campaign_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sms_campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "sms_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "sms_campaign_recipients_campaign_id_recipient_phone_key" ON "sms_campaign_recipients"("campaign_id", "recipient_phone");
CREATE INDEX "sms_campaign_recipients_organization_id_campaign_id_status_idx" ON "sms_campaign_recipients"("organization_id", "campaign_id", "status");

CREATE TABLE "sms_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "campaign_id" UUID,
  "recipient_phone" VARCHAR(50) NOT NULL,
  "message_text" TEXT NOT NULL,
  "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
  "cost_credits" INTEGER NOT NULL DEFAULT 1,
  "sim_slot" INTEGER NOT NULL DEFAULT 1,
  "provider_message_id" VARCHAR(100),
  "gateway_provider" VARCHAR(50),
  "attempt_count" INTEGER NOT NULL DEFAULT 1,
  "last_error" TEXT,
  "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sms_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sms_messages_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "sms_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "sms_messages_organization_id_status_idx" ON "sms_messages"("organization_id", "status");
CREATE INDEX "sms_messages_provider_message_id_idx" ON "sms_messages"("provider_message_id");

CREATE TABLE "sms_delivery_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "gateway_provider" VARCHAR(50) NOT NULL,
  "provider_message_id" VARCHAR(100),
  "status" "SmsStatus" NOT NULL,
  "error_message" TEXT,
  "raw_response" JSONB,
  "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sms_delivery_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sms_delivery_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sms_delivery_attempts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "sms_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "sms_delivery_attempts_organization_id_message_id_idx" ON "sms_delivery_attempts"("organization_id", "message_id");

-- ------------------------------------------------------------------------------
-- 7. Developer Platform, OAuth 2.0, Webhooks & Outbox
-- ------------------------------------------------------------------------------

CREATE TABLE "api_keys" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "key_hash" VARCHAR(64) NOT NULL,
  "key_prefix" VARCHAR(16) NOT NULL,
  "label" VARCHAR(100) NOT NULL,
  "permissions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "last_used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "rotated_from_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_organization_id_revoked_at_idx" ON "api_keys"("organization_id", "revoked_at");

CREATE TABLE "oauth_clients" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "client_secret_hash" VARCHAR(64),
  "redirect_uris" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "is_public" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oauth_clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "oauth_clients_organization_id_idx" ON "oauth_clients"("organization_id");

CREATE TABLE "oauth_authorization_codes" (
  "code" VARCHAR(128) NOT NULL,
  "client_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "redirect_uri" VARCHAR(500) NOT NULL,
  "scopes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "code_challenge" VARCHAR(128) NOT NULL,
  "code_challenge_method" VARCHAR(10) NOT NULL DEFAULT 'S256',
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "oauth_authorization_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "oauth_authorization_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "oauth_authorization_codes_organization_id_client_id_idx" ON "oauth_authorization_codes"("organization_id", "client_id");

CREATE TABLE "oauth_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "access_token_hash" VARCHAR(64) NOT NULL,
  "refresh_token_hash" VARCHAR(64) NOT NULL,
  "client_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "scopes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "access_token_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "refresh_token_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oauth_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "oauth_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "oauth_tokens_access_token_hash_key" ON "oauth_tokens"("access_token_hash");
CREATE UNIQUE INDEX "oauth_tokens_refresh_token_hash_key" ON "oauth_tokens"("refresh_token_hash");
CREATE INDEX "oauth_tokens_organization_id_client_id_idx" ON "oauth_tokens"("organization_id", "client_id");

CREATE TABLE "webhook_endpoints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "url" VARCHAR(500) NOT NULL,
  "secret" VARCHAR(64) NOT NULL,
  "subscribed_events" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "webhook_endpoints_organization_id_is_active_idx" ON "webhook_endpoints"("organization_id", "is_active");

CREATE TABLE "webhook_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "endpoint_id" UUID NOT NULL,
  "outbox_event_id" UUID,
  "event_type" VARCHAR(100) NOT NULL,
  "payload" JSONB NOT NULL,
  "response_status" INTEGER,
  "response_body" TEXT,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(20) NOT NULL DEFAULT 'DELIVERED',
  "next_retry_at" TIMESTAMPTZ(6),
  "delivered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "webhook_deliveries_organization_id_endpoint_id_delivered_at_idx" ON "webhook_deliveries"("organization_id", "endpoint_id", "delivered_at" DESC);

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_type" VARCHAR(20) NOT NULL,
  "action" VARCHAR(100) NOT NULL,
  "resource_type" VARCHAR(50) NOT NULL,
  "resource_id" UUID NOT NULL,
  "previous_state" JSONB,
  "new_state" JSONB,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "audit_logs_organization_id_resource_type_resource_id_idx" ON "audit_logs"("organization_id", "resource_type", "resource_id");
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "event_type" VARCHAR(100) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "is_delivered" BOOLEAN NOT NULL DEFAULT false,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_attempt_at" TIMESTAMPTZ(6),
  "locked_at" TIMESTAMPTZ(6),
  "locked_by" VARCHAR(100),
  "last_error" TEXT,
  "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "outbox_events_status_next_attempt_at_created_at_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");
CREATE INDEX "outbox_events_organization_id_is_delivered_created_at_idx" ON "outbox_events"("organization_id", "is_delivered", "created_at");

-- ------------------------------------------------------------------------------
-- 8. Dynamic Subscription & Commercial Catalog
-- ------------------------------------------------------------------------------

CREATE TABLE "commercial_products" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(50) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" TEXT,
  "product_type" "ProductType" NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "commercial_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commercial_products_code_key" ON "commercial_products"("code");

CREATE TABLE "subscription_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "product_id" UUID NOT NULL,
  "code" VARCHAR(50) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" TEXT,
  "is_public" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_plans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "commercial_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

CREATE TABLE "plan_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_id" UUID NOT NULL,
  "version_number" INTEGER NOT NULL,
  "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effective_to" TIMESTAMPTZ(6),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "trial_period_days" INTEGER NOT NULL DEFAULT 0,
  "grace_period_days" INTEGER NOT NULL DEFAULT 3,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_versions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "plan_versions_plan_id_version_number_key" ON "plan_versions"("plan_id", "version_number");

CREATE TABLE "plan_prices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_version_id" UUID NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'TZS',
  "amount_cents" BIGINT NOT NULL,
  "billing_interval" "BillingInterval" NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_prices_amount_non_negative_check" CHECK ("amount_cents" >= 0),
  CONSTRAINT "plan_prices_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "plan_prices_plan_version_id_currency_billing_interval_key" ON "plan_prices"("plan_version_id", "currency", "billing_interval");

CREATE TABLE "feature_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(50) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" TEXT,
  "type" "EntitlementType" NOT NULL,
  "default_value" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "feature_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feature_definitions_key_key" ON "feature_definitions"("key");

CREATE TABLE "plan_entitlements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_version_id" UUID NOT NULL,
  "feature_key" VARCHAR(50) NOT NULL,
  "value" VARCHAR(100) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_entitlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_entitlements_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "plan_entitlements_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "feature_definitions"("key") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "plan_entitlements_plan_version_id_feature_key_key" ON "plan_entitlements"("plan_version_id", "feature_key");

CREATE TABLE "organization_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "plan_version_id" UUID NOT NULL,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
  "currency" VARCHAR(3) NOT NULL,
  "unit_price_cents" BIGINT NOT NULL,
  "billing_interval" "BillingInterval" NOT NULL,
  "current_period_start" TIMESTAMPTZ(6) NOT NULL,
  "current_period_end" TIMESTAMPTZ(6) NOT NULL,
  "trial_ends_at" TIMESTAMPTZ(6),
  "canceled_at" TIMESTAMPTZ(6),
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_subscriptions_price_non_negative_check" CHECK ("unit_price_cents" >= 0),
  CONSTRAINT "organization_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "organization_subscriptions_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "organization_subscriptions_organization_id_key" ON "organization_subscriptions"("organization_id");
CREATE INDEX "organization_subscriptions_organization_id_status_idx" ON "organization_subscriptions"("organization_id", "status");

CREATE TABLE "subscription_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "plan_version_id" UUID NOT NULL,
  "event_type" VARCHAR(50) NOT NULL,
  "previous_status" "SubscriptionStatus",
  "new_status" "SubscriptionStatus" NOT NULL,
  "unit_price_cents" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "billing_interval" "BillingInterval" NOT NULL,
  "actor_id" UUID,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_history_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_history_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "organization_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "subscription_history_org_sub_created_idx" ON "subscription_history"("organization_id", "subscription_id", "created_at" DESC);

CREATE TABLE "subscription_billing_invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "invoice_number" VARCHAR(50) NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "period_end" TIMESTAMPTZ(6) NOT NULL,
  "is_paid" BOOLEAN NOT NULL DEFAULT false,
  "paid_at" TIMESTAMPTZ(6),
  "payment_provider_ref" VARCHAR(100),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "subscription_billing_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_billing_invoices_amount_non_negative_check" CHECK ("amount_cents" >= 0),
  CONSTRAINT "subscription_billing_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "subscription_billing_invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "organization_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "subscription_billing_invoices_invoice_number_key" ON "subscription_billing_invoices"("invoice_number");
CREATE INDEX "subscription_billing_invoices_organization_id_is_paid_idx" ON "subscription_billing_invoices"("organization_id", "is_paid");

-- ------------------------------------------------------------------------------
-- 9. Database-Level Immutability & Snapshot Protection Triggers
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_immutable_record_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RECORD_VIOLATION: Table "%" is append-only; % operations are forbidden.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_raw_payment_evidence_immutable
  BEFORE UPDATE OR DELETE ON "raw_payment_evidence"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER trg_messaging_credit_ledger_immutable
  BEFORE UPDATE OR DELETE ON "messaging_credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER trg_payment_verifications_immutable
  BEFORE UPDATE OR DELETE ON "payment_verifications"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

CREATE TRIGGER trg_subscription_history_immutable
  BEFORE UPDATE OR DELETE ON "subscription_history"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_record_mutation();

-- Prevent modification of historical financial terms on subscription_billing_invoices
CREATE OR REPLACE FUNCTION prevent_subscription_invoice_snapshot_tampering()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD_VIOLATION: Subscription billing invoices cannot be deleted.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.currency <> OLD.currency OR NEW.invoice_number <> OLD.invoice_number OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'IMMUTABLE_SNAPSHOT_VIOLATION: Historical invoice amount_cents, currency, and organization_id are immutable.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_subscription_billing_invoices_snapshot
  BEFORE UPDATE OR DELETE ON "subscription_billing_invoices"
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_invoice_snapshot_tampering();
