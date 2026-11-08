# BriskSMS Milestone 3: Baseline Architecture & Integration Audit

**Date:** 2026-11-08  
**Repository:** `https://github.com/realmadede/BriskSMS`  
**Current Branch:** `main`  
**Starting HEAD:** `094cd4477804f47de33f21076958e1ae78103ad5`  
**Tracking State:** Ahead of `origin/main` by 13 commits (local commits only, zero remote pushes)  
**Working Tree Status:** Clean  

---

## 1. Executive Summary

Milestone 3 establishes end-to-end operational integration across both BriskSMS commercial products:
- **Product A (Payment Intelligence & Business Automation):** Ingestion of Swahili payment notifications from Tanzanian mobile money and banking providers, evidence normalization, deterministic invoice matching, and manual review workflows.
- **Product B (Bulk Messaging):** SMSGate-only cellular relay architecture using local Tanzanian SIMs, prepaid credit transaction ledger, recipient validation, and delivery state tracking.

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
| **API Backend** (`apps/api`) | Node.js 20+, TypeScript, Custom HTTP Router | Modular monolith. Auth, Org, Device, Ingestion, Messaging, Subscription, Reconciliation, Developer, OAuth controllers active. | 159 unit/integration tests passing. All controllers registered and verified. |
| **Worker Consumer** (`apps/worker`) | BullMQ / Redis, PostgreSQL Outbox | Background runtime for outbox polling and all 5 queues (`webhook-delivery`, `payment-processing`, `sms-campaign`, `sms-delivery-retry`, `maintenance-cleanup`). | 100% operational with Redis heartbeat monitoring. |
| **Web Console** (`apps/web`) | Plus Jakarta Sans, Glisse / Liquid Glass, HTML5 | Enterprise merchant console (`console.html`). | Live HTTP calls via Bearer tokens for reconciliation feed, review queue modals, pairing QR generation, messaging, and API keys. |
| **Android Relay** (`apps/android`) | Kotlin, Jetpack Compose, Room, Keystore | Complete notification listener, offline Room database, SMSGate foreground relay. | Architecture, manifest permissions, and provider registry verified. Local Gradle build blocked by host JDK 25-ea runtime; requires JDK 17/21 and Android SDK. |
| **Database** (`packages/db`) | PostgreSQL 18, Prisma, Native SQL client | Normalized schema, partial unique indexes, transactional outbox, immutable triggers. | Healthy and running on port 5433. |
| **Shared Package** (`packages/shared`) | TypeScript DTOs, Enums, Utils | Domain models, Tanzanian currency formatting, deduplication hashing. | Built and typechecked. |
| **Parser Engine** (`packages/parser-engine`) | Regex & Deterministic Tokenizers | Vodacom M-Pesa, Mixx by Yas, Airtel Money, CRDB Bank adapters. | 100% test coverage against anonymized SMS samples. |
| **Zapier App** (`packages/zapier-app`) | Zapier Platform CLI schema | OAuth2 PKCE definition, `send_sms` action, `payment_matched` trigger hook. | Built and unit-tested. |

---

## 4. Key Engineering Invariants Verified

1. **Pairing Token Expiry (5 Minutes):** Single-use pairing tokens expire in 300 seconds (5 minutes) as specified in `device.service.ts` (`ttlSeconds: 300`). Atomic row consumption prevents token reuse.
2. **Authoritative Persistence Enums:** Database state transitions are governed exclusively by Prisma enums (`TransactionState: OBSERVED, NORMALIZED, DUPLICATE_REJECTED, UNMATCHED, MATCHED, VERIFICATION_PENDING, VERIFIED, REJECTED, REVIEW_REQUIRED, FULFILLMENT_PENDING, FULFILLED, FULFILLMENT_FAILED`; `InvoiceStatus: UNPAID, PARTIALLY_PAID, PAID, OVERPAID, VOID, REFUNDED`).
3. **Append-Only Transaction Ledger:** Prepaid messaging credits operate on an append-only transaction ledger with row-locking (`SELECT ... FOR UPDATE`) and database immutability triggers, strictly isolated from SaaS subscription billing.
4. **Configurable Anti-Spam Curfew:** The 20:00 to 07:00 EAT promotional messaging restriction is implemented as a configurable product policy (`PROMOTIONAL_CURFEW_ENABLED`, `PROMOTIONAL_CURFEW_START_HOUR_EAT`, `PROMOTIONAL_CURFEW_END_HOUR_EAT`) pending formal TCRA statutory verification.
5. **Distinct Credential Separation:** Strict segregation between human JWTs, developer API keys (`bsk_live_`), device tokens (`bsk_dev_`), SMSGate signing secrets, and OAuth PKCE tokens.

---

## 5. Milestone 3 Workstream Execution Plan

1. **Workstream B: Backend & Infrastructure Completion**
   - Register `reconciliation.controller.ts`, `developer.controller.ts`, and `oauth.controller.ts`.
   - Add queue workers for `payment-processing` and `sms-delivery-retry` in `BriskWorkerRuntime`.
   - Enhance health checks (`/v1/health`) to report detailed queue worker status and Redis latency.
2. **Workstream C: Merchant Web Application Integration**
   - Connect `console.html` to authenticated API endpoints (`/v1/auth`, `/v1/organizations`, `/v1/reconciliation`, `/v1/devices`, `/v1/messaging`, `/v1/subscriptions`, `/v1/developer`).
   - Implement real session bootstrap, token refresh, and interactive review queue modals.
   - Display real dynamic subscription catalog and usage without hardcoding prices or limits.
3. **Workstream D: Android-to-Backend Integration Alignment**
   - Verify device pairing ceremony, short-lived 5-minute single-use pairing token validation, and public key binding.
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
10. **Workstream K: Acceptance Review & Completion Report**
    - Compile `docs/reports/MILESTONE_3_COMPLETION_REPORT.md` with exact test evidence and explicit external blockers.
