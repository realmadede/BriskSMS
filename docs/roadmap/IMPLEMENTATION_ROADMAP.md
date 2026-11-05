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
Phase 0: Foundation & Monorepo Scaffolding
   |
   v
Phase 1: Multi-Tenancy, Identity & Cryptographic Device Management
   |
   v
Phase 2: Android Ingestion Relay & Keystore Client
   |
   v
Phase 3: Payment Parsing Engine, Deduplication & Normalization
   |
   v
Phase 4: Financial Ledger, Invoicing & Multi-Tier Reconciliation
   |
   v
Phase 5: Business Automation Engine (MikroTik RouterOS, WHMCS, Webhooks)
   |
   v
Phase 6: Bulk Messaging Engine, Sender IDs & Prepaid Ledger (Product B)
   |
   v
Phase 7: Enterprise Web Portal (Angular 19+)
   |
   v
Phase 8: Commercial Billing, Quota Enforcement & Self-Serve Subscriptions
   |
   v
Phase 9: Security Hardening, Penetration Testing & Production Launch
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

### Phase 1: Multi-Tenancy, Identity & Cryptographic Device Management
- **Objective:** Build the core tenant isolation layer, authentication, role-based access control (RBAC), and asymmetric Android device pairing.
- **Dependencies:** Phase 0.
- **Deliverables:**
  - `apps/api/src/modules/auth/`: Registration, JWT issuance, HTTP-only refresh tokens, Argon2id password hashing, 2FA TOTP support.
  - `apps/api/src/modules/organization/`: Organization creation, membership management, RBAC guards (`Owner`, `Admin`, `Finance`, `Support`, `Developer`).
  - `apps/api/src/modules/device/`: QR code pairing endpoint, single-use enrollment token verification, device public key registration, heartbeat endpoint, device revocation.
  - Prisma migrations for `users`, `organizations`, `memberships`, `devices`, and `audit_logs`.
- **Tests:**
  - Unit tests for JWT expiration, refresh token rotation, and RBAC permission evaluation.
  - Integration tests verifying cross-tenant isolation (Tenant A cannot view or mutate Tenant B resources).
  - Device revocation test: Token becomes invalid within 100ms of revocation.
- **Security Gate:** Static analysis check against OWASP Top 10; verification that all tenant queries enforce `organizationId`.
- **Acceptance Criteria:** Complete end-to-end user signup, organization provisioning, and secure device pairing flow via REST API.

---

### Phase 2: Android Ingestion Relay & Keystore Client
- **Objective:** Develop the native Android relay application with hardware-backed security, local offline queuing, and resilient background synchronization.
- **Dependencies:** Phase 1 (Device API endpoints).
- **Deliverables:**
  - Android application in `apps/android/` using Kotlin and Jetpack Compose.
  - Android Keystore integration for asymmetric keypair generation and request signing.
  - Room SQLite database for persistent offline message queuing (`raw_notifications`).
  - Mode 1: `NotificationListenerService` with strict package filtering and user disclosure flow.
  - Mode 2: Optional `BroadcastReceiver` for direct carrier SMS reception on dedicated business devices.
  - Foreground Service with persistent status notification and battery optimization exemption onboarding.
  - WorkManager / Coroutine HTTP client with exponential backoff and network reconnection listeners.
- **Tests:**
  - Instrumentation tests for Android Keystore signing and verification.
  - Offline resilience test: Inject 50 notifications while in Airplane Mode, reconnect, verify 100% synced without duplicates.
- **Security Gate:** Verification that personal messages (non-financial) are discarded on-device before persistence or transmission.
- **Acceptance Criteria:** Android device successfully pairs via QR code, captures simulated M-Pesa notifications, and delivers signed payloads to the backend API.

---

### Phase 3: Payment Parsing Engine, Deduplication & Normalization
- **Objective:** Implement the versioned parser engine for all Tanzanian mobile money providers and banks, along with deterministic cryptographic deduplication.
- **Dependencies:** Phase 2 (Raw payload ingestion).
- **Deliverables:**
  - `packages/parser-engine/`:
    - Vodacom M-Pesa parser adapter.
    - Mixx by Yas (Tigo Pesa) parser adapter.
    - Airtel Money parser adapter.
    - HaloPesa parser adapter.
    - TTCL Pesa parser adapter.
    - CRDB Bank and NMB Bank SMS alert parsers.
  - `apps/api/src/modules/payment/`: Fast ingestion endpoint (`POST /v1/ingest/notifications`), append-only `raw_payment_evidence` table.
  - Deduplication engine computing deterministic SHA-256 hash.
  - Worker parser consumer (`ingest.parse` queue in BullMQ).
- **Tests:**
  - Comprehensive unit test suite with 100+ anonymized real-world Tanzanian payment SMS samples across all providers.
  - Malformed SMS test: Graceful transition to `REJECTED` without unhandled exceptions.
  - Replay test: Submitting identical raw payload twice yields `DUPLICATE_REJECTED` on second attempt.
- **Security Gate:** Invariant verification that `raw_payment_evidence` records are immutable (no UPDATE/DELETE permissions).
- **Acceptance Criteria:** 100% pass rate on test corpus; parsing latency < 10ms per message.

---

### Phase 4: Financial Ledger, Invoicing & Multi-Tier Reconciliation
- **Objective:** Construct the invoice management module and multi-tier reconciliation engine with support for exact matches, partial payments, and manual accountant review.
- **Dependencies:** Phase 3.
- **Deliverables:**
  - `apps/api/src/modules/reconciliation/`: Invoices CRUD, invoice line items, tax calculation, customer accounts.
  - Matching engine waterfall: Tier 1 (Memo), Tier 2 (Customer/Phone), Tier 3 (Checkout window), Tier 4 (Unmatched).
  - Concurrency management using PostgreSQL row locks (`SELECT ... FOR UPDATE`).
  - Accountant Review Queue API for manual match approval and dispute resolution.
  - Immutable audit logging for every financial transition.
- **Tests:**
  - Concurrency test: 50 concurrent payments targeting the same invoice without race conditions or negative balances.
  - Edge case tests: Underpayment creates `PARTIALLY_PAID` status; overpayment creates `OVERPAID` status.
  - Audit log completeness test: Every reconciliation action logs actor ID, previous state, and new state.
- **Security Gate:** Financial invariant verification: All balance calculations computed in integer minor units (cents) to avoid floating-point errors.
- **Acceptance Criteria:** Deterministic settlement of matching invoices; ambiguous transactions safely held in `REVIEW_REQUIRED`.

---

### Phase 5: Business Automation Engine (MikroTik RouterOS, WHMCS, Webhooks)
- **Objective:** Build the external integration adapters and idempotent execution worker to automate business fulfillment upon verified payment.
- **Dependencies:** Phase 4.
- **Deliverables:**
  - `apps/worker/src/processors/automation.processor.ts`: Event listener for `payment.verified` and `invoice.settled`.
  - MikroTik RouterOS adapter (RouterOS v6 API and v7 REST/SSH) for PPPoE user reactivation and Hotspot voucher creation.
  - WHMCS adapter for automated `addInvoicePayment` settlement.
  - Webhook dispatcher with HMAC-SHA256 signatures (`X-BriskSMS-Signature`) and exponential backoff retry policy (5 attempts).
  - Idempotency key tracking in Redis/PostgreSQL to prevent duplicate external actions.
- **Tests:**
  - Mock MikroTik integration test verifying command generation and failure retry handling.
  - Mock WHMCS API test verifying idempotent payment logging.
  - Webhook delivery test with simulated merchant endpoint downtime and subsequent backoff recovery.
- **Security Gate:** RouterOS credentials and WHMCS API keys encrypted at rest using AES-256-GCM.
- **Acceptance Criteria:** Verified payment triggers MikroTik user profile update within 2 seconds; network timeouts enter `FULFILLMENT_FAILED` without altering payment verification status.

---

### Phase 6: Bulk Messaging Engine, Sender IDs & Prepaid Ledger (Product B)
- **Objective:** Deliver the independent commercial bulk messaging module with sender ID management, prepaid credit ledger, and multi-aggregator routing.
- **Dependencies:** Phase 1 (Organizations & RBAC). Note: Independent of Phase 4/5.
- **Deliverables:**
  - `apps/api/src/modules/messaging/`: Sender ID verification workflow, contact management, contact groups, CSV campaign scheduler.
  - Double-entry prepaid credit ledger (`messaging_credit_ledger`) with atomic credit deductions and delivery-failure refunds.
  - Aggregator gateway adapter interface:
    - Beem Africa adapter.
    - DARSMS adapter.
    - eHUB / FastHub adapter.
  - Real-time Delivery Report (DLR) webhook ingestion endpoint.
  - TCRA curfew enforcement: Promotional SMS restricted between 20:00 and 07:00 EAT.
- **Tests:**
  - Credit ledger concurrency test: High-volume message dispatch cannot overdraw credit balance below zero.
  - DLR refund test: Simulated failed message delivery successfully refunds credit to organization ledger.
  - Anti-spam curfew test: Campaign scheduled for 22:00 automatically queued until 07:01 next morning.
- **Security Gate:** Verification that Product B credit ledger is completely isolated from Product A subscription billing.
- **Acceptance Criteria:** Single and bulk SMS dispatch functioning with delivery receipts and automatic credit balance tracking.

---

### Phase 7: Enterprise Web Portal (Angular 19+)
- **Objective:** Build the modern, responsive enterprise web dashboard for business owners, accountants, support staff, and developers.
- **Dependencies:** Phases 1–6 (All backend REST APIs).
- **Deliverables:**
  - Angular 19+ application in `apps/web/` using Standalone Components and Signals.
  - Feature Modules:
    - Real-time Dashboard: Today's revenue, device health, incoming feed, reconciliation rates.
    - Device Management: QR code pairing modal, device battery/connectivity status, revocation.
    - Payments & Reconciliation: Live payment feed, filter by provider/state, Accountant Review Queue.
    - Invoices & Customers: Invoice creation, CSV import, customer balance overview.
    - Business Automations: Rule builder for MikroTik, WHMCS, and custom Webhooks.
    - Bulk Messaging (Product B): Sender ID application, campaign builder, contact groups, credit ledger.
    - Developer Center: API key management, webhook registration, event log inspector.
- **Tests:**
  - Component unit tests with Karma/Jasmine or modern Jest/Vitest.
  - End-to-end Cypress/Playwright suites covering login, device pairing, manual reconciliation, and SMS campaign launch.
- **Security Gate:** Strict Content Security Policy (CSP), anti-clickjacking headers, and XSS sanitization across all data rendering.
- **Acceptance Criteria:** Fast, responsive UI with sub-second page transitions, full mobile responsiveness, and clean accessibility.

---

### Phase 8: Commercial Billing, Quota Enforcement & Self-Serve Subscriptions
- **Objective:** Implement tenant subscription plans, self-serve upgrades, mobile money checkout for subscriptions, and quota enforcement.
- **Dependencies:** Phase 7.
- **Deliverables:**
  - Product A subscription engine (Starter, Growth, Enterprise).
  - Quota enforcement middleware (tracking active devices, monthly reconciled volume, automation rules).
  - Checkout integration: Pay subscription fees using Lipa Kwa M-Pesa / Tigo Pesa push USSD.
  - Product B credit purchase portal with instant wallet top-ups.
  - Automated tax invoice generation for all B2B payments.
- **Tests:**
  - Quota limit test: Organization at quota ceiling receives upgrade notification; payment ingestion continues safely without data loss.
  - Top-up test: Purchasing SMS credits immediately credits `messaging_credit_ledger`.
- **Security Gate:** Tamper-proof webhook handling for subscription payment gateways.
- **Acceptance Criteria:** End-to-end self-serve subscription renewal and instant messaging credit top-up operational.

---

### Phase 9: Hardening, Penetration Testing & Production Launch
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
