# BriskSMS

**Payment checking, invoice matching, business automation, and bulk SMS for Tanzanian businesses.**

BriskSMS reads mobile-money payment alerts on an Android phone, turns them into clean records, and matches them to invoices. It also sends bulk SMS. Built for Tanzania, ready to grow to other markets.

> **Status:** Backend, workers, shared packages, Android app, and web portal are built and tested locally (544 workspace tests, 41 Android tests). Live carrier connections, Google OAuth, Resend email, and real SIM-card trials still need outside approval. See the [roadmap](./docs/roadmap/IMPLEMENTATION_ROADMAP.md) and the [audit](./docs/audit/FULL_REPOSITORY_HARD_AUDIT.md).

## Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Project layout](#project-layout)
- [Core rules](#core-rules)
- [Documentation](#documentation)
- [License](#license)

---

## What it does

BriskSMS has two separate products in one dashboard.

### Product A: Payment Intelligence (core)

- An Android app (BriskSMS Companion) reads payment alerts from **M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, and CRDB**.
- Raw messages become clean, permanent payment records.
- Duplicate and replayed payments are blocked across all customers.
- Payments are matched to open invoices automatically. Unclear or partial payments go to an accountant for review (`REVIEW_REQUIRED`).
- Webhooks and Zapier hooks connect to MikroTik RouterOS, WHMCS, WooCommerce, and ERP tools.
- **Works without messaging credits.**

### Product B: Bulk Messaging (optional)

- Send campaigns, alerts, and customer messages at scale.
- Two ways to send: the SMSGate cellular gateway (cloud or private server), or the Android companion picking up jobs from the database.
- Import recipients from CSV or Excel XML, with personalized templates.
- Follows Tanzanian anti-spam curfew rules (TCRA), with delivery reports.
- Prepaid credits are tracked in a safe, append-only ledger.

---

## Tech stack

| Area | What is used |
|---|---|
| Runtime and packages | Bun `1.4.2` workspaces (`apps/*`, `packages/*`), Node.js 20+ compatible |
| API (`apps/api`) | Custom TypeScript HTTP router, 10 domain modules, no heavy framework |
| Background jobs (`apps/worker`) | PostgreSQL outbox + Redis 7+ queues: webhook delivery, payment processing, SMS campaigns, SMS retry, cleanup |
| Web (`apps/web`) | Light static server for the portal (`index.html`, `console.html`, `developers.html`). Angular 19+ app planned for Phase 7+ |
| Android (`apps/android`) | Kotlin 1.9.23, Jetpack Compose, Room, WorkManager, Android Keystore encryption |
| Database (`packages/db`) | PostgreSQL 16+, Prisma schema (53 models), 15 forward-only SQL migrations |
| Security | Scrypt passwords, JWT with rotating refresh tokens, CSRF protection, device pairing with EC P-256, OAuth 2.0 PKCE, AES-256-GCM secrets, signed webhooks |
| Target market | Tanzania: M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, TTCL Pesa, CRDB, NMB |

PostgreSQL is the only source of truth. The platform never falls back to in-memory storage if the database is down.

---

## Quick start

**You need:** [Bun](https://bun.sh) 1.4.2, Docker, and (for Android) JDK 17 with the Android SDK.

```bash
# 1. Install dependencies and start PostgreSQL + Redis
bun install --frozen-lockfile
cp .env.example .env        # then fill in your values
docker compose up -d postgres redis

# 2. Set up the database
bun run db:migrate
bun run db:seed
bun run db:status

# 3. Check types and build
bun run typecheck
bun run build

# 4. Run all tests (needs PostgreSQL and Redis running)
bun run test

# 5. Start the background worker (optional)
bun run worker:start
```

**Android companion** (set `JAVA_HOME` to your JDK 17 folder first):

```bash
cd apps/android
./gradlew testDebugUnitTest compileDebugKotlin assembleDebug --offline --no-daemon
```

---

## Project layout

```
apps/
  api/        Backend API
  worker/     Background job workers
  web/        Web portal
  android/    Android companion app
packages/
  db/             Database schema and migrations
  shared/         Shared code
  parser-engine/  Reads payment SMS messages
  ui/             UI components
  zapier-app/     Zapier integration
  config/         Shared lint and TypeScript settings
docs/             Architecture, security, finance, audits, standards
```

---

## Core rules

1. **We never hold money.** BriskSMS is software and information only. It does not hold, pool, send, or escrow customer funds.
2. **Payment logic is exact and checkable.** AI is never allowed to make the final decision that a payment is confirmed.
3. **Only payment alerts are used.** Personal SMS messages are filtered out on the phone and never sent to our servers.

---

## Documentation

**Product and design**
- [Product Requirements (PRD)](./docs/prd/PRD.md)
- [Architecture](./docs/architecture/ARCHITECTURE.md)
- [Android Integration](./docs/android/ANDROID_INTEGRATION.md)
- [Android Companion and Relay Topology](./docs/architecture/ANDROID_COMPANION_AND_RELAY_TOPOLOGY.md)
- [Carrier STK Integration Readiness](./docs/architecture/CARRIER_STK_INTEGRATION_READINESS.md)
- [Roadmap](./docs/roadmap/IMPLEMENTATION_ROADMAP.md)
- [Competitive Analysis](./docs/competitive/COMPETITIVE_ANALYSIS.md)
- [Compliance and Feasibility](./docs/compliance/COMPLIANCE_AND_FEASIBILITY.md) (Play Store, PDPA, BoT/NPSA, TCRA)

**Finance and security**
- [Financial Integrity](./docs/financial/FINANCIAL_INTEGRITY.md)
- [State Machine and Ledger Design](./docs/financial/STATE_MACHINE_AND_LEDGER_DESIGN.md)
- [Security Policy](./docs/security/SECURITY.md)

**Audits**
- [Full Repository Hard Audit](./docs/audit/FULL_REPOSITORY_HARD_AUDIT.md)
- [Day-Zero Audit](./docs/audit/REPOSITORY_AUDIT.md) (historical, replaced by the hard audit)

**Deployment and staging**
- [Deployment Guide](./docs/deployment/DEPLOYMENT.md)
- [Staging Readiness Audit](./docs/reports/STAGING_READINESS_AUDIT.md), [Security Checklist](./docs/reports/STAGING_SECURITY_CHECKLIST.md), [Deployment Runbook](./docs/reports/STAGING_DEPLOYMENT_RUNBOOK.md), [Validation Plan](./docs/reports/STAGING_VALIDATION_PLAN.md)
- [Environment Variable Inventory](./docs/reports/ENVIRONMENT_VARIABLE_INVENTORY.md), [Staging Environment Configuration](./docs/reports/STAGING_ENVIRONMENT_CONFIGURATION.md)

**For contributors**
- [Contributing](./docs/CONTRIBUTING.md), [Coding Standards](./docs/standards/CODING_STANDARDS.md), [API Conventions](./docs/standards/API_CONVENTIONS.md), [Database Conventions](./docs/standards/DATABASE_CONVENTIONS.md), [Testing Standards](./docs/standards/TESTING_STANDARDS.md)

---

## License

Copyright (c) 2026 BriskSMS Team. All rights reserved. Proprietary and confidential.
See [LICENSE](./LICENSE). Copying, sharing, or reproducing this repository without permission is prohibited.
