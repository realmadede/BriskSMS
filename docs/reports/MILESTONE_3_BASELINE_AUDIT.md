# BriskSMS Milestone 3: Baseline Architecture & Integration Audit

**Date:** 2026-11-08  
**Repository:** `https://github.com/realmadede/BriskSMS`  
**Current Branch:** `main`  
**Starting HEAD:** `094cd4477804f47de33f21076958e1ae78103ad5`  
**Tracking State:** Ahead of `origin/main` by 12 commits (local commits only, zero remote pushes)  
**Working Tree Status:** Clean  

---

## 1. Executive Summary

Milestone 3 establishes end-to-end operational integration across both BriskSMS commercial products:
- **Product A (Payment Intelligence & Business Automation):** Ingestion of Swahili payment notifications from Tanzanian mobile money and banking providers, evidence normalization, deterministic invoice matching, and manual review workflows.
- **Product B (Bulk Messaging):** SMSGate-only cellular relay architecture using local Tanzanian SIMs, prepaid credit ledger, recipient validation, and delivery state tracking.

This baseline audit evaluates the existing codebase, verifies recent Milestone 2.5/2.6 security fixes against authoritative specifications, uncovers integration gaps, and defines the execution plan for completing the merchant experience, backend services, Android companion client, and developer platform.

---

## 2. Verification of Milestone 2.5 / 2.6 Security Implementations

### 2.1. SMSGate Upstream Webhook Event Identity
- **Verified Fact:** Official SMSGate documentation (`docs.sms-gate.app`) and open-source gateway repositories (`capcom6/android-sms-gateway`) confirm that webhook delivery events contain an outer envelope with an authoritative upstream event identifier (`id: "Ey6ECgOkVVFjz3CL48B8C"`), alongside `deviceId`, `event`, and a nested `payload` (`messageId`, `deliveredAt`, `simNumber`).
- **Fingerprint Stability:** 
  $$\text{event\_fingerprint} = \text{SHA-256}(\text{orgId} \parallel ":" \parallel \text{deviceId} \parallel ":" \parallel \text{stableKey})$$
  Where `stableKey` is either `evt:${upstreamEventId}` or `${providerMessageId}:${eventType}:${rawTimestamp}:${simNumber}`.
- **Retry Invariant:** Ephemeral transport headers (`X-Signature` and `X-Timestamp`) are strictly excluded. The carrier event timestamp (`rawTimestamp`) is preserved as static evidence across retries. When SMSGate retries dispatching with a fresh timestamp and signature, the fingerprint remains identical, guaranteeing duplicate detection without second financial mutations.

### 2.2. Authoritative Tenant & Device Binding
- **Verified Fact:** The webhook controller does not trust request-supplied query parameters (`?org=`), headers (`x-organization-id`), or payload tenant fields.
- **Resolution Pipeline:** `smsGateKeyService.resolveAuthoritativeDeviceOrganization(deviceId)` resolves the organization directly from the persisted `smsgate_signing_keys` and `devices` tables.
- **Guards Verified:**
  - Revoked devices fail closed with `403 DEVICE_REVOKED`.
  - Ambiguous devices registered to multiple tenants fail closed with `409 AMBIGUOUS_DEVICE_IDENTITY`.
  - Mismatched tenant routing hints fail closed with `403 TENANT_DEVICE_MISMATCH`.
  - Target message owner mismatches fail closed with `403 TENANT_MESSAGE_MISMATCH`.

### 2.3. SMSGate Key Rotation & Single-Key Invariant
- **Verified Fact:** Upstream SMSGate application supports only **one active signing key** (`webhooks.signing_key`). The Android device or VPS never signs with two keys simultaneously.
- **Receiver Transition Model:** BriskSMS retains the prior key in `encrypted_prev_key` with a 24-hour grace period timestamp (`rotated_at`). During this window, `resolveCandidateKeys()` evaluates `[currentKey, previousKey]`, enabling an operator to rotate the key on the backend and update the physical phone without dropped delivery reports.

### 2.4. Raw-Body Signature Handling
- **Verified Fact:** The HTTP layer in `apps/api/src/core/http.ts` preserves `rawBodyBuffer: Buffer<ArrayBufferLike>` before JSON decoding. The exact incoming byte sequence is concatenated directly with timestamp string bytes into `createHmac('sha256')`, preventing reserialization distortion on JSON whitespace, property order, and multi-byte Swahili Unicode.

### 2.5. Webhook Processing Transaction Boundaries
- **Verified Fact:** `messagingService.processSmsGateWebhookDelivery()` executes event identity reservation via `INSERT INTO smsgate_webhook_events ... ON CONFLICT ("event_fingerprint") DO NOTHING RETURNING id, status` inside `withTransaction`.
- **Atomicity:** Row locks on `sms_messages` (`FOR UPDATE`), terminal state mutation (`DELIVERED`/`FAILED`), and credit ledger refund (`messaging_accounts` + `messaging_credit_ledger`) execute within the same ACID transaction. Failed transactions roll back completely, remaining safely retryable.

### 2.6. Production Encryption Configuration
- **Verified Fact:** `validateProductionEncryptionConfig()` executes at application boot in `apps/api/src/main.ts`. In production (`NODE_ENV === 'production'`), startup halts immediately if `ENCRYPTION_MASTER_KEY` is missing, < 32 characters, or matches test/dev/CI default keys (`brisksms_ci_encryption_master_key_32_bytes_min!`).

---

## 3. Current Architecture & Component Inventory

| Component | Technology | Current State | Verification Status |
|---|---|---|---|
| **API Backend** (`apps/api`) | Node.js 20+, TypeScript, Custom HTTP Router | Modular monolith. Auth, Org, Device, Ingestion, Messaging, Subscription controllers active. | 175 tests passing. Missing HTTP controllers for Reconciliation, Developer Platform, and OAuth. |
| **Worker Consumer** (`apps/worker`) | BullMQ / Redis, PostgreSQL Outbox | Background runtime for outbox polling, webhook delivery, SMS campaigns, maintenance. | Missing consumer bindings for `payment-processing` and `sms-delivery-retry`. |
| **Web Console** (`apps/web`) | Plus Jakarta Sans, Glisse / Liquid Glass, HTML5 | Static landing page (`index.html`), developer docs (`developers.html`), prototype console (`console.html`). | Uses mock `localStorage` and simulated callbacks; needs real API integration with backend. |
| **Android Relay** (`apps/android`) | Kotlin, Jetpack Compose, Room, Keystore | Complete notification listener, offline AES-GCM evidence database, SMSGate relay logic. | Unit tests pass in CI; local build blocked by system Java 25 EA (requires JDK 17/21). |
| **Database** (`packages/db`) | PostgreSQL, Prisma, Native SQL client | Normalized schema, partial unique indexes, transactional outbox, audit logging. | Healthy and running on port 5433. |
| **Shared Package** (`packages/shared`) | TypeScript DTOs, Enums, Utils | Domain models, Tanzanian currency formatting, deduplication hashing. | Built and typechecked. |
| **Parser Engine** (`packages/parser-engine`) | Regex & Deterministic Tokenizers | Vodacom M-Pesa, Mixx by Yas, Airtel Money, CRDB Bank adapters. | 100% test coverage against anonymized SMS samples. |
| **Zapier App** (`packages/zapier-app`) | Zapier Platform CLI schema | OAuth2 PKCE definition, `send_sms` action, `payment_matched` trigger hook. | Built and unit-tested. |

---

## 4. Identified Gaps, Defects & Security Concerns

### Gap 1: Missing HTTP Controllers for Domain Services (API)
- **Defect:** `apps/api/src/app.ts` does not register routes for:
  - `ReconciliationService` (listing payments, review queue, invoice queries, manual verification).
  - `ApiKeyService` & `WebhookService` (generating/listing scoped keys, registering/listing outbound webhooks).
  - `OAuthService` (OAuth 2.0 PKCE `/v1/oauth/authorize` and `/v1/oauth/token`).
- **Remedy:** Implement dedicated controller modules and register them in `apps/api/src/app.ts`.

### Gap 2: Incomplete Queue Consumer Bindings (Worker)
- **Defect:** `QUEUE_NAMES` defines `payment-processing` and `sms-delivery-retry`, but `BriskWorkerRuntime` in `apps/worker/src/workers.ts` only registers workers for `webhook-delivery`, `sms-campaign`, and `maintenance-cleanup`.
- **Remedy:** Add worker consumers for `payment-processing` and `sms-delivery-retry` in `BriskWorkerRuntime`.

### Gap 3: Static Prototype Merchant Console (Web)
- **Defect:** `apps/web/src/console.html` relies on `localStorage`, simulated arrays, and mock dialogs instead of executing live HTTP calls to `http://localhost:3000/v1/...`.
- **Remedy:** Wire the merchant console to real backend endpoints using secure session tokens, real reconciliation queries, manual verification actions, live device telemetry, SMS campaign submission, credit ledger history, and dynamic subscription catalog display.

### Gap 4: Android Build Environment JDK Incompatibility
- **Defect:** The host development environment only has OpenJDK 25 early access (`java-25-openjdk-amd64`). Android Gradle Plugin 8.x fails on startup with `25.0.5-ea`.
- **Remedy:** Document the exact prerequisite (JDK 17 or JDK 21 LTS) and provide the headless CI verification path while testing Android logic through unit and contract suites.

---

## 5. Milestone 3 Workstream Execution Plan

1. **Workstream B: Backend & Infrastructure Completion**
   - Register `reconciliation.controller.ts`, `developer.controller.ts`, and `oauth.controller.ts`.
   - Add queue workers for `payment-processing` and `sms-delivery-retry` in `BriskWorkerRuntime`.
   - Enhance health checks to report detailed queue worker status.
2. **Workstream C: Merchant Web Application Integration**
   - Connect `console.html` to authenticated API endpoints (`/v1/auth`, `/v1/organizations`, `/v1/reconciliation`, `/v1/devices`, `/v1/messaging`, `/v1/subscriptions`, `/v1/developer`).
   - Implement real session lifecycle, token refresh, and logout.
   - Display real dynamic subscription catalog and usage without hardcoding prices or limits.
3. **Workstream D: Android-to-Backend Integration**
   - Verify device pairing ceremony, short-lived single-use pairing token validation, and public key binding.
   - Verify offline payment evidence encryption, synchronization, and deduplication.
4. **Workstream E: Payment Intelligence & Reconciliation**
   - Verify parser registry, evidence normalization, invoice reference matching, partial payments, overpayments, and manual review transitions.
5. **Workstream F: Bulk Messaging & SMSGate Integration**
   - Validate Tanzanian phone number formatting, SIM slot selection, prepaid credit reservation/deduction/refund, and campaign execution.
6. **Workstream G: Developer Platform & Zapier**
   - Verify scoped API keys, HMAC-signed outbox webhooks, and Zapier integration hooks.
7. **Workstream H: UX, Design System & Accessibility**
   - Verify WCAG 2.2 AA compliance, visible focus states, high-contrast financial data tables, and Plus Jakarta Sans typography.
8. **Workstream I: Security, Privacy & Operational Readiness**
   - Review multi-tenant isolation, fail-closed production encryption, and secret masking.
9. **Workstream J: End-to-End Integration Testing**
   - Implement and execute integration test scenarios A through F against real PostgreSQL and Redis.
10. **Workstream K: Completion Report & Documentation**
    - Compile `docs/reports/MILESTONE_3_COMPLETION_REPORT.md` with exact test evidence.
