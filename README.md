# BriskSMS

**Commercial Payment Intelligence, Reconciliation, Business Automation, and Messaging Platform**  
*Focused on Tanzania with an expandable architecture for international markets.*

---

## Overview

BriskSMS is an enterprise-grade SaaS platform built to solve the fragmentation and friction of mobile-money payment verification, invoice reconciliation, business automation, and bulk customer communications for Tanzanian businesses.

The platform provides two logically and commercially independent products under a single tenant management interface:

1. **Product A: Payment Intelligence & Business Automation (Core Product)**
   - Connects authorized Android devices running the BriskSMS Companion (`NotificationListenerService`) to capture incoming mobile-money (Vodacom M-Pesa, Mixx by Yas, Airtel Money, HaloPesa) and bank (CRDB) payment notifications.
   - Normalizes raw unstructured messages into canonical, immutable financial records.
   - Eliminates duplicate payment fraud and replay attacks across tenants via a unified global payment-reference claim boundary (`payment_reference_claims`).
   - Matches payments deterministically against open invoices and customer accounts, routing ambiguous or partial amounts to manual accountant review (`REVIEW_REQUIRED`).
   - Triggers downstream operational webhooks and Zapier REST hooks (enabling external MikroTik RouterOS, WHMCS, WooCommerce, and ERP workflows).
   - **Crucial Rule:** Payment reconciliation operates independently and **never** requires messaging credits.

2. **Product B: Bulk Messaging (Optional Product)**
   - High-throughput commercial bulk SMS platform for customer engagement, transactional alerts, and campaigns.
   - Dual outbound delivery: SMSGate cellular gateway (Cloud / Private VPS) and durable PostgreSQL-backed Model B Android companion job acquisition (`outbound_sms_jobs`).
   - RFC-4180 CSV & SpreadsheetML XML recipient ingestion, personalized templates, TCRA anti-spam curfew controls, and delivery reporting.
   - Dedicated append-only prepaid messaging credit ledger with ACID row locks.

---

## Current Project Status & Key Technical Specifications

- **Current Milestone State:** Core Backend API, Background Workers, Shared/DB/Parser/UI/Zapier Packages, Android Companion, and Static Glisse Web Portal are **implemented and locally verified** (`532/532` workspace tests across `39` files; `11` Android JUnit test classes / `52` `@Test` methods + `assembleDebug`). Live external carrier STK transports, Google Cloud OAuth credentials, Resend DNS/API keys, and physical Android SIM field trials remain gated behind external onboarding. See [`IMPLEMENTATION_ROADMAP.md`](./docs/roadmap/IMPLEMENTATION_ROADMAP.md) and [`FULL_REPOSITORY_HARD_AUDIT.md`](./docs/audit/FULL_REPOSITORY_HARD_AUDIT.md).

| Domain | Technology / Actual Implementation |
|---|---|
| **Package Manager & Runtime** | Bun `1.4.2` (`bun.lock`, workspaces across `apps/*` and `packages/*`) + Node.js `20+` / `24` compatible TypeScript bundles |
| **Backend API (`apps/api`)** | Custom Node/Bun HTTP `Router` Modular Monolith (10 domain modules, zero framework runtime bloat) |
| **Background Processing (`apps/worker`)** | PostgreSQL Transactional Outbox + Redis 7+ Queue Workers (`webhook-delivery`, `payment-processing`, `sms-campaign`, `sms-delivery-retry`, `maintenance-cleanup`) & Dispatch Recovery |
| **Web Frontend (`apps/web`)** | Lightweight Node/Bun static server (`server.ts`) serving Glisse editorial HTML/CSS/JS portal (`index.html`, `console.html`, `developers.html`); future Angular 19+ SPA migration deferred to Phase 7+ |
| **Mobile Companion (`apps/android`)** | Android Native (Kotlin `1.9.23`, AGP `8.3.1`, Gradle `8.14.3`, Jetpack Compose, Room SQLite, WorkManager, Keystore EC P-256 & AES-256-GCM) |
| **Database (`packages/db`)** | PostgreSQL 16+ via `Bun.SQL` parameterized client, Prisma schema (`schema.prisma`, **53 models**), and custom forward-only migration runner (**15 SQL migrations**) |
| **Security & Auth** | Scrypt password hashing, HMAC-SHA256 JWT + opaque 30-day rotating refresh families, Double-Submit CSRF, EC P-256 Device Pairing PoP, OAuth 2.0 PKCE (`S256`), AES-256-GCM encrypted secrets, HMAC webhook signatures |
| **Target Market** | Tanzania (M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, TTCL Pesa, CRDB, NMB) |

---

## Repository Governance & Documentation Index

### Architecture, Product & Audits
- [**Full Repository Hard Audit & Remediation Report**](./docs/audit/FULL_REPOSITORY_HARD_AUDIT.md): Comprehensive 17-area audit, remediated vulnerabilities (`AUD-01`..`AUD-17`), and post-edit verification evidence.
- [**Commercial Implementation Roadmap**](./docs/roadmap/IMPLEMENTATION_ROADMAP.md): Phased execution roadmap reflecting completed P0–P2 hardening, Phases 1–7 current status, and remaining Phase 8 launch prerequisites.
- [**Technical Architecture**](./docs/architecture/ARCHITECTURE.md): System architecture, monorepo layout, module boundaries, queues, and PostgreSQL schema overview.
- [**Android Integration Specification**](./docs/android/ANDROID_INTEGRATION.md): Keystore EC P-256 PoP pairing, AES-256-GCM Room storage, `BriskNotificationListenerService`, and SMSGate relay contracts.
- [**Android Companion & Cellular Relay Topology**](./docs/architecture/ANDROID_COMPANION_AND_RELAY_TOPOLOGY.md): Dual-channel ingestion, SIM failover, durable fleet commands, and Model B outbound SMS jobs.
- [**Carrier STK Integration Readiness**](./docs/architecture/CARRIER_STK_INTEGRATION_READINESS.md): Fail-closed adapter/verifier boundary and MNO onboarding prerequisites.
- [**Product Requirements Document (PRD)**](./docs/prd/PRD.md): Original product scope, personas, roles, and functional requirements.
- [**Competitive Analysis**](./docs/competitive/COMPETITIVE_ANALYSIS.md): Comparative analysis against SMSGate, SakuraPay, Suki, and Tanzanian aggregators.
- [**Technical Feasibility & Compliance**](./docs/compliance/COMPLIANCE_AND_FEASIBILITY.md): Android SMS policies, Play Store compliance, Tanzania PDPA/PDPC, BoT/NPSA, and TCRA curfew rules.
- [**Day-Zero Repository Audit (Historical)**](./docs/audit/REPOSITORY_AUDIT.md): Initial Nov 5 repository baseline audit (superseded by `FULL_REPOSITORY_HARD_AUDIT.md`).

### Financial, Security, Staging & Standards
- [**Financial Integrity Specification**](./docs/financial/FINANCIAL_INTEGRITY.md): Transaction lifecycle state machine, deduplication math, ledger invariants, and crash recovery.
- [**Financial State Machine & Ledger Design**](./docs/financial/STATE_MACHINE_AND_LEDGER_DESIGN.md): Multi-tier reconciliation waterfall, ACID locking, and audit trail design.
- [**Security Architecture & Operations Policy**](./docs/security/SECURITY.md): Threat model, cryptographic boundaries, device PoP, session cookies, and key rotation.
- [**Staging Readiness Audit**](./docs/reports/STAGING_READINESS_AUDIT.md) | [**Staging Security Checklist**](./docs/reports/STAGING_SECURITY_CHECKLIST.md) | [**Staging Deployment Runbook**](./docs/reports/STAGING_DEPLOYMENT_RUNBOOK.md) | [**Staging Validation Plan**](./docs/reports/STAGING_VALIDATION_PLAN.md)
- [**Environment Variable Inventory**](./docs/reports/ENVIRONMENT_VARIABLE_INVENTORY.md) & [**Staging Environment Configuration**](./docs/reports/STAGING_ENVIRONMENT_CONFIGURATION.md)
- [**API Conventions**](./docs/standards/API_CONVENTIONS.md) | [**Database Conventions**](./docs/standards/DATABASE_CONVENTIONS.md) | [**Coding Standards**](./docs/standards/CODING_STANDARDS.md) | [**Testing Standards**](./docs/standards/TESTING_STANDARDS.md) | [**Contributing**](./docs/CONTRIBUTING.md)
- [**Deployment Guide**](./docs/deployment/DEPLOYMENT.md): Infrastructure provisioning, environment variables, and GitHub Actions CI workflows.

---

## Database, Build & Verification Quickstart

BriskSMS uses **PostgreSQL 16+** as the sole authoritative persistence store (**53 relational tables**, **15 versioned migrations**) and **Redis 7+** for background queues, rate limiting, and session revocation sync. The platform never falls back to in-memory persistence when PostgreSQL is unavailable.

```bash
# 1. Install dependencies (Bun 1.4.2) and start PostgreSQL + Redis
bun install --frozen-lockfile
docker compose up -d postgres redis

# 2. Apply version-controlled SQL migrations, seed commercial catalog, and verify status
bun run db:migrate
bun run db:seed
bun run db:status

# 3. Typecheck and build workspace packages
bun run typecheck
bun run build

# 4. Run the full workspace test suite (requires live PostgreSQL & Redis)
bun run test

# 5. Verify Android companion (requires JDK 17 + Android SDK)
cd apps/android
JAVA_HOME=/home/madede/.jdks/temurin-17 ./gradlew testDebugUnitTest compileDebugKotlin assembleDebug --offline --no-daemon

# Optional: start the background worker runtime
bun run worker:start
```

---

## Operating Invariants

1. **Non-Custodial Architecture:** BriskSMS is purely an informational and software automation platform. We do not hold, pool, transmit, or escrow customer funds.
2. **Deterministic Financial Logic:** Financial state transitions must be mathematically verifiable and auditable. AI models are strictly prohibited from making authoritative payment confirmation decisions.
3. **Data Minimization:** Only authorized payment notifications from supported provider channels are processed. Personal SMS data is filtered out on-device and never transmitted to our servers.

---

## License

Copyright (c) 2026 BriskSMS Team. All rights reserved. Proprietary and confidential.  
See [LICENSE](./LICENSE) for terms and conditions. Unauthorized copying, distribution, or reproduction of this repository and its contents is strictly prohibited.
