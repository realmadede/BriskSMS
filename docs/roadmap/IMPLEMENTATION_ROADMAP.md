# Deliverable G: Phased Commercial Implementation Roadmap

**Document Version:** 2.0.0  
**Last Synced:** 2026-11-16  
**Classification:** Engineering Roadmap & Current Execution Status  
**Target:** Full Commercial SaaS Platform (Enterprise Grade)  
**Authoritative Verification Snapshot:** [`FULL_REPOSITORY_HARD_AUDIT.md`](../audit/FULL_REPOSITORY_HARD_AUDIT.md)

---

## 1. Roadmap Architecture & Execution Philosophy

This roadmap represents the deliberate, phased engineering plan to deliver BriskSMS as a production-grade commercial platform. 

Every phase has:
1. **Clear Predecessor Dependencies:** No phase begins until the technical and security gates of the prior phase are validated.
2. **Explicit Deliverables:** Concrete code modules, packages, and configuration files.
3. **Automated Test Suites:** Unit, integration, invariant, and end-to-end verification.
4. **Security Gates:** Audits and criteria required before advancing.
5. **Acceptance Criteria:** Quantifiable criteria for sign-off.

---

## 2. Current Roadmap Status Overview

```
Phase 0: Engineering Foundation & Monorepo Scaffolding (COMPLETED)
   |
   v
Phase 1: Multi-Tenancy, Identity & Cryptographic Device Management (COMPLETED)
   |
   v
Phase 2: Dynamic Subscription Catalog & Entitlements Engine (COMPLETED)
   |
   v
[P0 Security & Dispatch Gates: P0.1 / P0.2 / Carrier Dispatch / Device Pairing PoP (COMPLETED)]
   |
   v
[P1 Durable Database-Backed Fleet Command Queue (COMPLETED)]
   |
   v
[P1 Android Outbound SMSGate Job Acquisition (COMPLETED)]
   |
   v
[P2 MNP-Safe Carrier Routing & Docs Reconciliation (COMPLETED)]
   |
   v
Phase 3: Android Companion App & Keystore Relay (CORE APP IMPLEMENTED & APK/UNIT VERIFIED; Physical Device Field Tests Pending)
   |
   v
Phase 4: Payment Parsing Engine, Deduplication & Invoicing Reconciliation (CORE ENGINE IMPLEMENTED & VERIFIED; NMB Parser Deferred)
   |
   v
Phase 5: BriskSMS Cellular Gateway & Bulk Messaging Engine (CORE ENGINE IMPLEMENTED & VERIFIED; Physical Hardware Trial Pending)
   |
   v
Phase 6: Developer Platform, Transactional Outbox & Zapier App (CORE PLATFORM IMPLEMENTED; Native RouterOS/WHMCS Workers Deferred)
   |
   v
Phase 7: Merchant Web Portal (CUSTOM GLISSE PORTAL IMPLEMENTED in apps/web; Angular 19+ SPA / Playwright E2E Deferred)
   |
   v
[Full Repository Hard Audit & SaaS Production-Readiness: AUD-01..AUD-30 (COMPLETED — 543/543 Workspace Tests Across 41 Files + Android Unit/APK Verified)]
   |
   v
Phase 8: External Carrier Onboarding, Live Staging, Penetration Testing & Production Launch (IN PROGRESS / EXTERNAL PREREQUISITES)
```

---

### Phase 0: Engineering Foundation & Monorepo Scaffolding (COMPLETED)
- **Status:** **Completed & Verified.**
- **Deliverables:**
  - Bun workspace root (`package.json`, `bun.lock`, `apps/*`, `packages/*`), `.gitignore`, `.editorconfig`, `packages/config`.
  - `docker-compose.yml` defining PostgreSQL 16+ and Redis 7+.
  - `packages/shared` (DTOs, enums, domain errors, crypto/phone/currency utilities) and `packages/db` (Prisma schema, `Bun.SQL` parameterized client, custom migration CLI, custom RESP Redis client & queue primitives).
  - `.github/workflows/ci.yml` (`verify` monorepo job and `android-verify` Gradle job).

---

### Phase 1: Multi-Tenancy, Identity & Cryptographic Device Management (COMPLETED)
- **Status:** **Completed & Verified.**
- **Deliverables:**
  - `apps/api/src/modules/auth/`: Registration, email/password login, Google OpenID Connect RS256 + `bsk_g_nonce` protection, Resend email verification (`bsk_ev_...`), HMAC-SHA256 JWT access tokens (`15m`), opaque SHA-256 hashed 30-day rotating refresh token families (`refresh_tokens.family_id`), distributed `revoked_sessions` lookup, Double-Submit CSRF + Origin/Fetch Metadata guards, and Redis atomic Lua rate limiting.
  - `apps/api/src/modules/organization/`: Organization creation, member invitations (no sentinel password hashes), and RBAC (`UserRole`: `OWNER`, `ADMIN`, `FINANCE`, `CASHIER`, `DEVELOPER`) with `OWNER` protection.
  - `apps/api/src/modules/device/`: 5-minute single-use QR pairing (`bsk_pair_...`), EC P-256 Proof-of-Possession challenge/pair flow (`bsk_dev_...`), telemetry, durable `device_commands`, and revocation.
  - Multi-tenant PostgreSQL persistence with ACID row locks and query-level tenant assertions. *(Note: TOTP 2FA challenge enforcement is deferred beyond `users.two_factor_secret` schema storage.)*

---

### Phase 2: Dynamic Subscription Catalog & Entitlements Engine (COMPLETED)
- **Status:** **Completed & Verified.**
- **Deliverables:**
  - Database models in `packages/db/prisma/schema.prisma`: `CommercialProduct`, `SubscriptionPlan`, `PlanVersion`, `PlanPrice`, `FeatureDefinition`, `PlanEntitlement`, `OrganizationSubscription`, `SubscriptionHistory`, `SubscriptionBillingInvoice`.
  - `apps/api/src/modules/subscription/`: `catalog.service.ts`, fail-closed `subscription.service.ts` (requires matching verified `stk_push_transactions` or `normalized_payments` before paid activation, returning `402 PAYMENT_VERIFICATION_REQUIRED` otherwise), and period/trial-bounded `entitlement.service.ts`.
  - Platform-admin protected catalog mutation endpoints (`/v1/admin/catalog/plans`, `/v1/admin/catalog/plans/:code/versions`) guarded by `PLATFORM_ADMIN_SECRET` (`503` unconfigured / `403` mismatch).
- **Security Gate:** Mathematical separation between Product A SaaS subscriptions and Product B prepaid SMS credit ledger; immutable price snapshotting.

---

### P0 Financial Integrity, Carrier Dispatch & Device Security Gates (COMPLETED)
- **P0.1 & P0.2 Global Payment-Reference Claim Boundary (COMPLETED):** Enforced canonical `(provider, provider_reference)` uniqueness (`payment_reference_claims`), monotonic PostgreSQL lock ordering, collision quarantine (`payment_reference_claim_collisions`), append-only `payment_reference_claim_events`, separation-of-duties manual verification, and fail-closed provider callback verification (`DisabledProviderCallbackVerifier`).
- **P0 Carrier Dispatch Adapter Integrity (COMPLETED):** Eliminated mock STK initiation success/fabricated references; unconfigured MNOs fail closed (`UNCONFIGURED`, HTTP `503`), unsupported rails fail closed (`UNSUPPORTED`, HTTP `422`), checkout state machine separates `INITIATING`, `DISPATCH_UNCERTAIN`, `UNSUPPORTED`, and `PENDING` with org-scoped idempotency (`20261114010000_stk_dispatch_integrity_and_idempotency`). See [`CARRIER_STK_INTEGRATION_READINESS.md`](../architecture/CARRIER_STK_INTEGRATION_READINESS.md).
- **P0 Android Device Pairing Proof-of-Possession (COMPLETED):** Challenge-response enrollment protocol (`POST /v1/devices/pairing-challenge` -> EC P-256 `SHA256withECDSA` signature over binary transcript `BRISKSMS-DEVICE-PAIRING-POP-V1` -> atomic `POST /v1/devices/pair`, migration `20261114020000_device_pairing_proof_of_possession`), strict SPKI key validation/uniqueness (`public_key_fingerprint`), silent key-replacement prohibition (`DEVICE_KEY_REPLACEMENT_FORBIDDEN`), and revoked-device re-pairing recovery (`BriskApiClient.kt` / `PairingScreen.kt`).

---

### P1 Durable Database-Backed Fleet Command Queue (COMPLETED)
- **Objective:** Replaced process-local `pendingCommands` in `device.service.ts` with durable, tenant-isolated PostgreSQL persistence (`device_commands`, migration `20261115000000_durable_device_commands`), monotonic locking + `FOR UPDATE SKIP LOCKED` claiming over `POST /v1/devices/:id/telemetry`, lease recovery (`leaseToken` / `leaseExpiresAt`), org-scoped `Idempotency-Key` + request fingerprinting, strict 4-command allowlist (`PAUSE_RELAY`, `RESUME_RELAY`, `SWITCH_SIM`, `WIPE_AND_REVOKE`), explicit/inline idempotent acknowledgements, and command history/cancellation (`GET /v1/devices/:id/commands`, `POST /v1/devices/:id/commands/:commandId/cancel`).

---

### P1 Android Outbound SMSGate Job Acquisition (COMPLETED)
- **Objective:** Implemented durable PostgreSQL-backed Model B Android outbound SMSGate job acquisition and outcome reporting (`outbound_sms_jobs`, migration `20261116000000_android_outbound_sms_jobs`), keeping Product A and Product B strictly isolated.
- **Delivered Invariants:** `POST /v1/messaging/device-jobs` (and `deliveryChannel: 'ANDROID_COMPANION'` on `POST /v1/messaging/send`) reserve credits atomically and enqueue leased jobs; paired Android companions acquire jobs (`POST /v1/messaging/device-jobs/acquire`), commit `/dispatching` before calling `SmsManager`, fail closed expired `DISPATCHING` leases to `UNCERTAIN` with zero auto-retry or refund, refund credits once on pre-radio failures/expirations/cancellations, and persist encrypted outcomes across process death (`PendingSmsJobResultStore`).

---

### P2 MNP-Safe Carrier Routing & Phone Normalization (COMPLETED)
- **Objective:** Eliminated prefix-only wallet routing assumptions under Tanzania Mobile Number Portability (MNP) and unified canonical phone normalization.
- **Delivered Invariants:** `POST /v1/payments/stk-push` accepts an explicit `provider` override (`routingResolution: 'EXPLICIT'`), keeping `inferCarrierHintFromPrefix()` (`detectTanzanianCarrier` deprecated) as a non-authoritative fallback (`PREFIX_HEURISTIC`); `RecipientParserService` delegates to shared `normalizeTanzanianPhone()` (`TANZANIAN_MOBILE_PREFIXES`, including `061` and `077`).

---

### Phase 3: Android Companion App & Keystore Relay (CORE APP IMPLEMENTED & UNIT/APK VERIFIED)
- **Status:** **Core Application Implemented & Offline Gradle Verified; Physical Hardware / Live SIM Field Validation Pending Staging.**
- **Implemented in `apps/android/`:**
  - Hardware-backed EC P-256 `KeystoreManager` + Keystore AES-256-GCM `KeystoreSecureStorage` and `EvidenceEncryptor`.
  - Room SQLite offline queues (`BriskDatabase`, `OfflineEvidenceEntity`, `SmsDispatchEntity`) + `PendingSmsJobResultStore`.
  - Play-Store compliant Mode 1 `BriskNotificationListenerService` with strict package whitelist (`PaymentProviderRegistry`) and hardware Keystore AES-256-GCM encryption (`EvidenceEncryptor`); carrier regex parsing remains exclusively server-side in `packages/parser-engine`.
  - Foreground relay `SmsGateRelayService`, `SimManager` (400/day SIM cap failover + pacing), `OutboundSmsJobCoordinator`, `BootCompletedReceiver`, `EvidenceUploadWorker`, `TelemetryWorker`, `DeviceCommandProcessor`, and Jetpack Compose screens (`PairingScreen` with ML Kit QR scanner, `OverviewScreen`, `DashboardScreen`, `PaymentIntelligenceScreen`, `BulkMessagingScreen`, `DeviceHealthScreen`, `SettingsScreen`).
  - Verified with **10 JVM unit test classes (41 `@Test` methods)**, Kotlin debug compilation, `assembleDebug`, and R8 Full Mode `assembleRelease` APK generation under Gradle `8.14.3` + Temurin JDK `17`.
- **Remaining / Deferred:**
  - Android instrumented on-device tests (e.g., Airplane Mode offline resilience test on hardware) and physical Tanzanian SIM radio/battery-exemption validation.
  - Mode 2 Enterprise Direct APK (`RECEIVE_SMS` `BroadcastReceiver`) — intentionally not included in the Play-Store compliant base build.

---

### Phase 4: Payment Parsing Engine, Deduplication & Reconciliation (CORE ENGINE IMPLEMENTED & VERIFIED)
- **Status:** **Core Engine Implemented & Verified; NMB Bank Alert Adapter Deferred.**
- **Implemented:**
  - `packages/parser-engine/`: Adapters for Vodacom M-Pesa (`mpesa.adapter.ts`), Mixx by Yas (`mixx.adapter.ts`), Airtel Money (`airtel.adapter.ts`), HaloPesa (`halopesa.adapter.ts`), and CRDB Bank (`crdb.adapter.ts`) extending `BaseProviderAdapter` (personal phone filtering, incoming-credit guard, exact `BigInt` minor-unit conversion, SHA-256 `computeDeduplicationHash`).
  - `apps/api/src/modules/ingestion/`: `POST /v1/ingestion/evidence` and append-only `raw_payment_evidence` + P0.2 claim acquisition.
  - `apps/api/src/modules/reconciliation/`: Invoices CRUD, deterministic matching, partial/overpayment `REVIEW_REQUIRED` routing, candidate suggestions, manual `POST /v1/reconciliation/verify`, and separation-of-duties checks.
- **Remaining / Deferred:** Dedicated NMB Bank SMS/notification parser adapter and expanding the real-world anonymized SMS fixture corpus beyond current unit/integration tests.

---

### Phase 5: BriskSMS Cellular Gateway & Bulk Messaging Engine (CORE ENGINE IMPLEMENTED & VERIFIED)
- **Status:** **Core Engine Implemented & Verified; Live Physical Gateway Hardware Validation Pending Staging.**
- **Implemented:**
  - `SmsGateProvider` (`POST /messages`, `/3rdparty/v1`, SSRF protection via `validateOutboundHttpUrl`, 15s timeout, strict HTTP `429 -> UNCERTAIN` classification), AES-256-GCM encrypted credentials in `messaging_accounts`, dual-key HMAC rotation for inbound `POST /v1/messaging/webhooks/smsgate` (`smsgate_signing_keys`, 24h grace window), durable `message_idempotency_records`, `DispatchRecoveryRunner`, `messaging_credit_ledger`, TCRA curfew gating (`20:00–07:00 EAT` default), campaign queuing/workers (`sms-campaign`, `sms-delivery-retry`), and `outbound_sms_jobs` Android acquisition.
  - Spreadsheet ingestion in `apps/web/src/console.html`: RFC-4180 CSV and SpreadsheetML XML parser using shared E.164 Tanzania normalization (`normalizeTanzanianPhone`); binary OOXML `.xlsx` uploads are explicitly rejected with guidance to export CSV/XML.
- **Remaining / Deferred:** Physical Android gateway hardware soak test under carrier rate limiting (429 behavior validation).

---

### Phase 6: Developer Platform, Transactional Outbox & Zapier App (CORE PLATFORM IMPLEMENTED)
- **Status:** **Core Platform & Zapier Integration Implemented & Verified; Direct Native MikroTik/WHMCS Worker Adapters Deferred.**
- **Implemented:**
  - `apps/api/src/modules/oauth/` & `oauth.service.ts`: `/v1/oauth/clients`, `/v1/oauth/authorize`, `/v1/oauth/token`, `/v1/oauth/revoke`, strict RFC 7636 PKCE (`S256` required; `plain` rejected), confidential client secret enforcement, `bsk_at_` / `bsk_rt_` tokens, and middleware authentication with `ApiKeyScope` enforcement (`sms:send`, `sms:read`, `payments:read`, `payments:write`, `payment:stk`, `invoices:read`, `invoices:write`, `devices:read`, `webhooks:manage`).
  - `apps/api/src/modules/developer/`: Scoped `bsk_live_...` API keys, AES-256-GCM encrypted `webhook_endpoints.secret` (`20261116010000_encrypt_webhook_endpoint_secrets`), `outbox_events` transactional writer, and worker HMAC-SHA256 `webhook-delivery` with SSRF checks and `redirect: 'error'`.
  - `packages/zapier-app/`: Zapier CLI OAuth2 PKCE (`S256`) config, triggers (`payment_matched`, `payment_needs_review`), and creates (`send_sms`, `create_invoice`) verified in `zapier-app.test.ts`.
- **Remaining / Deferred:** Native `apps/worker` adapters executing direct RouterOS API / SSH commands or WHMCS PHP calls (currently supported externally via signed webhooks & Zapier) and interactive OAuth consent screen UI.

---

### Phase 7: Enterprise Web Portal (CUSTOM GLISSE PORTAL IMPLEMENTED; Angular SPA Deferred)
- **Status:** **Lightweight Static Glisse Portal Implemented & Hardened (`apps/web`); Angular 19+ SPA & Browser E2E Deferred.**
- **Implemented in `apps/web/`:**
  - `server.ts`: Exported `handleWebRequest` & `createWebServer()`, baseline security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`), and strict `/assets/` canonical path containment.
  - `src/index.html`, `src/console.html`, `src/developers.html`: Editorial Stitch/Glisse marketing site, merchant console wired to live `/v1/*` APIs with XSS escaping (`escapeHtml()`), delegated click handlers, `formatMinorTzs()` scaling, CSV/XML campaign parsing, QR pairing polling, hash tab persistence, and honest REST HTTPS developer documentation.
  - Verified by `apps/web/test/web-server.test.ts` (4 tests, 39 assertions).
- **Remaining / Deferred:** Future migration to an Angular 19+ SPA with Jasmine/Karma component suites and live Playwright/Chromium browser E2E testing against running API + Web servers.

---

### Full Repository Hard Audit & SaaS Production-Readiness (COMPLETED — 2026-11-16)
- Audited all **17 subsystems** across the monorepo and completed findings **`AUD-01` through `AUD-30`** (`webhook_endpoints.secret` AES-256-GCM encryption migration `20261116010000`, fail-closed paid subscription verification including standalone callback-settled STK transactions, `PLATFORM_ADMIN_SECRET` catalog gate, OAuth `bsk_at_` scope & human-session guards, password reset + invitation acceptance + workspace switching, campaign queue dispatch/cancel + gateway retry worker + maintenance sweepers, operational developer/audit/outbox endpoints, Web Console dynamic QR + full workflow controls, Android `BuildConfig`/`WIPE_AND_REVOKE`/boot sync/vector icons/R8 hardening, dead-code removal, and multi-target `Dockerfile`).
- Post-edit verification: **543/543 workspace tests passing across 41 files** (`bun run test` on PostgreSQL + Redis), `bun run typecheck` + `bun run build` exit `0`, **15 migrations** applied (`STRICT_MIGRATION_CHECKSUMS=true`), and **10 Android JUnit test classes (`47 @Test`s) + `assembleDebug` + `assembleRelease`** passing.

---

### Phase 8: External Carrier Onboarding, Live Staging, Penetration Testing & Launch (IN PROGRESS / EXTERNAL PREREQUISITES)
- **Objective:** Final live staging validation, third-party carrier onboarding, security penetration testing, and commercial production launch.
- **Remaining Prerequisites:**
  1. **Git Commit, Sign & Push:** Commit working-tree changes with registered SSH key and run remote GitHub Actions CI (`verify` + `android-verify`).
  2. **External Credentials & Carrier Contracts:** Provision Google Cloud OAuth Client IDs, Resend verified domain/API key, official MNO STK agreements/verifiers (`MPESA`, `MIXX`, `AIRTEL_MONEY`, `HALOPESA`), and SMSGate gateway hardware.
  3. **Live Hardware & Browser Testing:** Physical Android device + Tanzanian SIM field trials and interactive Playwright browser E2E verification.
  4. **Infrastructure & Compliance:** Private VPC Redis isolation (no internal Redis TLS), edge reverse-proxy CSP & `X-Forwarded-For` sanitization (`TRUST_PROXY=true`), Multi-AZ PostgreSQL PITR drills, pre-existing local `_prisma_migrations` checksum drift note (`20261112000000`), independent penetration test, and PDPC RCMIS registration.
