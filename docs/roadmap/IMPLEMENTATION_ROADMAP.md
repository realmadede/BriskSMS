# Deliverable G: Phased Commercial Implementation Roadmap

**Document Version:** 1.0.0  
**Classification:** Engineering Roadmap & Milestones  
**Target:** Full Commercial SaaS Platform (Enterprise Grade)  

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

## 2. Phase-by-Phase Implementation Plan

```
Phase 0: Engineering Foundation & Monorepo Scaffolding (COMPLETED)
   |
   v
Phase 1: Multi-Tenancy, Identity & Cryptographic Device Management (COMPLETED - e2f4dd4)
   |
   v
Phase 2: Dynamic Subscription Catalog & Entitlements Engine (COMPLETED)
   |
   v
Phase 3: Native Android Ingestion Relay & Keystore Client (IMMEDIATE NEXT MILESTONE)
   |
   v
Phase 4: Payment Parsing Engine, Deduplication & Multi-Tier Reconciliation
   |
   v
Phase 5: BriskSMS Cellular Gateway & Bulk Messaging Engine (Dual-Mode SIM Relay)
   |
   v
Phase 6: Developer Platform, Transactional Outbox & BriskSMS Zapier Application
   |
   v
Phase 7: Enterprise Web Portal (Angular 19+) & Commercial Self-Service
   |
   v
Phase 8: Security Hardening, Penetration Testing & Production Launch
```

---

### Phase 0: Engineering Foundation & Monorepo Scaffolding
- **Objective:** Establish the development environment, monorepo workspace, shared packages, containerized local services, and CI/CD pipelines.
- **Dependencies:** None.
- **Deliverables:**
  - Workspace root `package.json` with npm workspaces (`apps/*`, `packages/*`).
  - `.gitignore`, `.editorconfig`, shared ESLint (`packages/config`), Prettier, and `tsconfig.base.json`.
  - `docker-compose.yml` defining PostgreSQL 16+ and Redis 7+ containers.
  - `packages/shared` initialized with base TypeScript types, error classes, and DTO contracts.
  - `packages/db` initialized with Prisma ORM setup.
  - GitHub Actions CI workflow (`.github/workflows/ci.yml`) enforcing linting, typechecking, and tests.
- **Tests:**
  - Workspace compilation test (`npm run build`).
  - Docker Compose healthcheck test for PostgreSQL and Redis.
- **Security Gate:** Zero secret leaks in commit history; all commits signed with SSH key.
- **Acceptance Criteria:** Clean workspace build and passing CI workflow with 100% green status.

---

### Phase 1: Multi-Tenancy, Identity & Cryptographic Device Management (COMPLETED — commit e2f4dd4)
- **Status:** **Completed & Verified.**
- **Objective:** Build the core tenant isolation layer, authentication, role-based access control (RBAC), and asymmetric Android device pairing.
- **Dependencies:** Phase 0.
- **Deliverables:**
  - `apps/api/src/modules/auth/`: Registration, JWT issuance, HTTP-only refresh tokens, Scrypt password hashing, verification.
  - `apps/api/src/modules/organization/`: Organization creation, membership management, RBAC guards (`OWNER`, `ADMIN`, `OPERATOR`, `CASHIER`, `AUDITOR`).
  - `apps/api/src/modules/device/`: 5-minute cryptographic QR pairing flow, device public key registration, heartbeat telemetry, device revocation.
  - Multi-tenant in-memory transactional store with ACID row locks and query-level tenant assertions.
- **Tests:**
  - 14 automated integration tests across `auth.test.ts`, `organization.test.ts`, and `device.test.ts` (100% passing).
- **Security Gate:** Verified cross-tenant isolation; all tenant queries enforce `organizationId`.
- **Acceptance Criteria:** Met in full.

---

### Phase 2: Dynamic Subscription Catalog & Entitlements Engine (COMPLETED)
- **Status:** **Completed & Verified.**
- **Objective:** Implement a 100% backend-managed dynamic commercial catalog, versioned subscription plans, snapshot pricing, and dynamic entitlement guards across all client channels.
- **Dependencies:** Phase 1 (Organizations & Auth).
- **Deliverables:**
  - Database models in `packages/db`: `CommercialProduct`, `SubscriptionPlan`, `PlanVersion`, `PlanPrice`, `FeatureDefinition`, `PlanEntitlement`, `OrganizationSubscription`, `SubscriptionBillingInvoice`.
  - Zero hardcoded commercial variables: all plan names, prices, currencies, device limits, member limits, API caps, and feature flags resolved from database records.
  - `apps/api/src/modules/subscription/`:
    - `catalog.service.ts`: Dynamic public catalog retrieval and privileged administrative catalog versioning.
    - `subscription.service.ts`: Atomic checkout, immutable price snapshotting, and billing invoice generation.
    - `entitlement.service.ts`: Dynamic evaluation of numeric quotas (`MAX_CONNECTED_DEVICES`, `MAX_ORGANIZATION_MEMBERS`) and boolean feature flags (`API_ACCESS`, `ZAPIER_INTEGRATION`).
    - Enforced quotas inside `device.service.ts` and `organization.service.ts`.
  - Secure Administrative Catalog APIs (`/v1/admin/catalog/plans`, `/v1/admin/catalog/plans/:code/versions`).
- **Tests:**
  - 7 automated integration tests in `apps/api/test/subscription.test.ts` (100% passing).
  - Overall monorepo test suite: **39/39 passing** (0 failures).
- **Security Gate:** Mathematical separation between Product A recurring SaaS ledger and Product B prepaid SMS credit ledger; no client-controlled price injection; immutable price snapshotting.
- **Acceptance Criteria:** Met in full.

---

### Phase 3: Android Ingestion Relay & Keystore Client (IMMEDIATE NEXT MILESTONE)
- **Objective:** Develop the native Android companion application with hardware-backed Keystore security, local offline queuing, and resilient background synchronization for payment notifications.
- **Dependencies:** Phase 1 (Device API endpoints) & Phase 2 (Device quota entitlements).
- **Deliverables:**
  - Android application in `apps/android/` using Kotlin and Jetpack Compose.
  - Android Keystore integration for asymmetric keypair generation and request signing.
  - Room SQLite database for persistent offline message queuing (`raw_notifications`).
  - Mode 1: `NotificationListenerService` with strict package filtering and user disclosure flow (Vodacom M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, CRDB, NMB).
  - Mode 2: Optional `BroadcastReceiver` for direct carrier SMS reception on dedicated business devices.
  - Foreground Service with persistent status notification and battery optimization exemption onboarding.
  - WorkManager / Coroutine HTTP client with exponential backoff and network reconnection listeners.
- **Tests:**
  - Instrumentation tests for Android Keystore signing and verification.
  - Offline resilience test: Inject 50 notifications while in Airplane Mode, reconnect, verify 100% synced without duplicates.
- **Security Gate:** Verification that personal messages (non-financial) are discarded on-device before persistence or transmission.
- **Acceptance Criteria:** Android device successfully pairs via QR code, captures simulated M-Pesa notifications, and delivers signed payloads to backend API.

---

### Phase 4: Payment Parsing Engine, Deduplication & Invoicing Reconciliation Matrix
- **Objective:** Implement the versioned parser engine for all Tanzanian mobile money providers and banks, deterministic cryptographic deduplication, and the multi-tier reconciliation engine.
- **Dependencies:** Phase 3 (Raw payload ingestion).
- **Deliverables:**
  - `packages/parser-engine/`: Adapters for Vodacom M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, CRDB Bank, NMB Bank.
  - Fast ingestion endpoint (`POST /v1/ingest/notifications`), append-only immutable `raw_payment_evidence`.
  - Cryptographic SHA-256 deduplication key: `hash(org_id + provider + provider_ref + amount + timestamp)`.
  - `apps/api/src/modules/reconciliation/`: Invoices CRUD, matching waterfall (Memo, Customer/Phone, Checkout window), partial/overpayment accounting, and Accountant Review Queue (`REVIEW_REQUIRED`).
- **Tests:**
  - 100+ real-world anonymized Tanzanian provider SMS test corpus passing.
  - Concurrency test: 50 concurrent payments targeting the same invoice without race conditions.
  - Deduplication replay test: Duplicate notifications safely rejected without duplicate settlement.
- **Security Gate:** Financial invariant verification: All balance calculations computed in integer minor units (cents); raw evidence table is append-only.
- **Acceptance Criteria:** Deterministic settlement of matching invoices; ambiguous transactions safely routed to manual accountant review.

---

### Phase 5: BriskSMS Cellular Gateway & Bulk Messaging Engine (Product B)
- **Objective:** Implement the commercial bulk messaging module with dual-mode cellular SIM gateway integration (Mode A: External Relay, Mode B: Managed BriskSMS Private Gateway on 24/7 VPS behind Cloudflare), multi-SIM slot routing, CSV/XLSX recipient ingestion, and append-only immutable credit transaction ledger with ACID reservations.
- **Dependencies:** Phase 1 (Organizations & RBAC) & Phase 2 (Entitlements).
- **Deliverables:**
  - Internal provider boundary: `MessagingProvider` interface.
  - `SmsGateProvider` adapter: `POST /api/v1/message`, dual-mode base URL resolution (`gateway.brisksms.com`), multi-SIM slot selection (`simNumber: 1` vs `2`), and HMAC webhook signature verification.
  - Multi-tenant gateway credentials management: AES-256-GCM encrypted token storage in `messaging_accounts`.
  - CSV/XLSX upload pipeline: Streaming parser, E.164 phone validation (Tanzanian carriers: 074/075/076, 071/065/067, 078/068/069, 062, 073), duplicate elimination, column mapping, and template variable substitution.
  - Configurable recipient batch limit (default 1,000 recipients per campaign).
  - TCRA anti-spam curfew compliance: Automatic marketing broadcast lock between 20:00 and 07:00 EAT.
  - BullMQ carrier-pacing queue: Sliding-window rate limiter (1 SMS / 3 seconds per SIM) to prevent carrier anti-spam SIM blocks.
  - Append-only immutable credit transaction ledger (`messaging_credit_ledger`) with atomic usage deductions and delivery-failure refunds.
- **Tests:**
  - Mock gateway dispatch and failure retry tests.
  - CSV/XLSX upload parser test with malformed phone numbers and deduplication.
  - Prepaid credit ledger concurrency test: High-volume message dispatch cannot overdraw credit balance below zero.
- **Security Gate:** Complete ledger isolation between Product B prepaid SMS units and Product A SaaS subscriptions.
- **Acceptance Criteria:** Bulk campaign uploaded via spreadsheet, validated, queued, and dispatched via cellular gateway with live delivery report tracking.

---

### Phase 6: Developer Platform, Transactional Outbox & BriskSMS Zapier Application
- **Objective:** Construct the official BriskSMS Zapier application, RFC 6749 OAuth 2.0 authorization server with PKCE, instant REST Hooks, and a resilient Transactional Outbox pattern.
- **Dependencies:** Phase 4 (Reconciliation events) & Phase 5 (Messaging events).
- **Deliverables:**
  - Official Zapier CLI application package (`@brisksms/zapier-app`).
  - OAuth 2.0 authorization server: `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, PKCE verification, organization-level consent picker.
  - Granular OAuth scopes: `payments:read`, `invoices:read`, `devices:read`, `sms:send`, `contacts:write`, `campaigns:read`.
  - Transactional Outbox pattern: `outbox_events` table written atomically with business transactions; background poller delivers events with exponential backoff.
  - REST Hook subscription endpoints: `/api/v1/zapier/hooks/subscribe` and `/unsubscribe`, automatic pruning on `410 Gone`.
  - Developer Platform: Scoped API keys (`bsk_live_...` / `bsk_test_...`), HMAC-SHA256 signed webhooks, rate limiting headers, Make.com and n8n compatibility.
- **Tests:**
  - Full OAuth 2.0 lifecycle test: Authorize $\rightarrow$ Exchange Token $\rightarrow$ Refresh Token $\rightarrow$ Revoke.
  - Outbox resilience test: Simulated webhook server downtime does not block reconciliation; events retried and delivered upon recovery.
  - Zapier trigger tests (Payment Evidence, Payment Matched, Review Required, Invoice Paid, Device Offline).
- **Security Gate:** Zero exposure of device private keys, tenant credentials, or financial mutation actions via Zapier.
- **Acceptance Criteria:** User can connect BriskSMS to Zapier via OAuth 2.0 and trigger automated downstream actions from payment and SMS events.

---

### Phase 7: Enterprise Web Portal (Angular 19+) & Commercial Self-Service
- **Objective:** Build the modern, responsive enterprise web dashboard for business owners, accountants, support staff, and developers.
- **Dependencies:** Phases 1–6 (All backend REST APIs).
- **Deliverables:**
  - Angular 19+ application in `apps/web/` using Standalone Components and Signals.
  - Feature Modules:
    - Real-time Dashboard: Today's revenue, device health, incoming feed, reconciliation rates.
    - Dynamic Pricing & Subscription Portal: Catalog display, self-service upgrades, billing history.
    - Integration Management UI: One-click "Connect to Zapier" flow, webhook endpoint management, API keys.
    - Bulk Messaging Hub: Spreadsheet template download, campaign upload wizard, delivery analytics.
    - Device Management: QR code pairing modal, device battery/connectivity status, revocation.
    - Reconciliation & Accountant Review Queue: Manual matching matrix.
- **Tests:**
  - Component unit tests with Jasmine/Karma.
  - End-to-end Cypress/Playwright suites covering login, device pairing, manual reconciliation, and Zapier connection.
- **Security Gate:** Strict Content Security Policy (CSP), anti-clickjacking headers, and XSS sanitization across all data rendering.
- **Acceptance Criteria:** Fast, responsive UI with sub-second page transitions, full mobile responsiveness, and clean accessibility.

---

### Phase 8: Security Hardening, Penetration Testing & Production Launch
- **Objective:** Final production readiness, external security audit, disaster recovery validation, and commercial launch.
- **Dependencies:** All previous phases.
- **Deliverables:**
  - Cloudflare Edge WAF rules, DDoS mitigation, and SSL pinning configuration.
  - Production database replication (Multi-AZ) and Point-in-Time Recovery (PITR) testing.
  - Comprehensive end-to-end load testing (simulating 1,000 requests/sec across API and workers).
  - Independent penetration test covering API endpoints, Android client, and tenant isolation.
  - Final legal registration on Tanzania PDPC RCMIS portal.
- **Tests:**
  - Disaster recovery drill: Failover database to replica with zero lost committed transactions.
  - Penetration testing remediations confirmed.
- **Security Gate:** Formal sign-off on Threat Model, PDPA compliance, and zero critical/high vulnerabilities.
- **Acceptance Criteria:** Production launch readiness with 99.95% availability SLA.

