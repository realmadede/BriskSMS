# BriskSMS

**Commercial Payment Intelligence, Reconciliation, Business Automation, and Messaging Platform**  
*Focused on Tanzania with an expandable architecture for international markets.*

---

## Overview

BriskSMS is an enterprise-grade SaaS platform built to solve the fragmentation and friction of mobile-money payment verification, invoice reconciliation, business automation, and bulk customer communications for Tanzanian businesses.

The platform provides two logically and commercially independent products under a single tenant management interface:

1. **Product A: Payment Intelligence & Business Automation (Core Product)**
   - Connects authorized Android devices running the BriskSMS Relay service to capture incoming mobile-money (Vodacom M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, TTCL Pesa) and bank payment notifications.
   - Normalizes raw unstructured messages into canonical, immutable financial records.
   - Eliminates duplicate payment fraud and replay attacks.
   - Automatically matches payments against customer accounts, open invoices, and orders.
   - Triggers downstream operational workflows (e.g., MikroTik RouterOS PPPoE/Hotspot activation, WHMCS invoice settlement, ERP sync, and signed webhooks).
   - **Crucial Rule:** Payment reconciliation operates independently and **never** requires messaging credits.

2. **Product B: Bulk Messaging (Optional Product)**
   - High-throughput commercial bulk SMS platform for customer engagement, transactional alerts, and campaigns.
   - Complete contact management, group segmentation, scheduled campaigns, personalized templates, and delivery reporting.
   - Dedicated prepaid messaging credit ledger and sender ID verification workflows.

---

## Key Technical Specifications

| Domain | Technology / Approach |
|---|---|
| **Repository Structure** | Modular Monorepo (`apps/`, `packages/`) |
| **Backend API** | NestJS (TypeScript), Modular Monolith |
| **Background Processing** | Queue-based Worker Architecture (Redis / BullMQ) |
| **Web Frontend** | Angular 19+ (TypeScript, Standalone Components, Signals) |
| **Mobile Relay** | Android Native (Kotlin, Jetpack Compose, WorkManager, Coroutines) |
| **Database** | PostgreSQL 16+ via Prisma ORM |
| **Edge & CDN** | Cloudflare (DNS, SSL, WAF, Edge Caching) |
| **Security & Auth** | Token-based Auth (JWT + Refresh), Role-Based Access Control (RBAC), HMAC Webhook Signatures |
| **Target Market** | Tanzania (M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, TTCL Pesa, CRDB, NMB) |

---

## Repository Governance & Documentation Index

Comprehensive engineering specifications, standards, and architecture decisions are documented in the [`docs/`](./docs) directory:

- [**Repository Audit**](./docs/audit/REPOSITORY_AUDIT.md): Baseline repository and host environment discovery.
- [**Product Requirements Document (PRD)**](./docs/prd/PRD.md): Detailed product scope, persona definitions, and module requirements.
- [**Competitive Analysis**](./docs/competitive/COMPETITIVE_ANALYSIS.md): Rigorous comparative analysis against SMSGate, SakuraPay, Suki, and Tanzanian SMS aggregators.
- [**Technical Architecture**](./docs/architecture/ARCHITECTURE.md): System architecture, monorepo layout, module boundaries, and queue design.
- [**Financial Integrity Specification**](./docs/financial/FINANCIAL_INTEGRITY.md): Transaction lifecycle state machine, deduplication math, ledger invariants, and failure recovery.
- [**Security Specification**](./docs/security/SECURITY.md): Threat modeling, tenant isolation, device pairing cryptography, and data protection.
- [**Technical Feasibility & Compliance**](./docs/compliance/COMPLIANCE_AND_FEASIBILITY.md): Android SMS policies, Play Store compliance, Tanzania PDPA/PDPC, BoT/NPSA boundaries, and infrastructure costs.
- [**Commercial Implementation Roadmap**](./docs/roadmap/IMPLEMENTATION_ROADMAP.md): Ordered, dependency-aware phased roadmap with test criteria and security gates.
- [**API Conventions**](./docs/standards/API_CONVENTIONS.md): REST guidelines, error formats, pagination, idempotency headers, and versioning.
- [**Database Conventions**](./docs/standards/DATABASE_CONVENTIONS.md): Schema design, indexing, foreign keys, naming standards, and migrations.
- [**Coding Standards**](./docs/standards/CODING_STANDARDS.md): TypeScript, Kotlin, ESLint, error handling, and clean architecture rules.
- [**Testing Standards**](./docs/standards/TESTING_STANDARDS.md): Unit, integration, parser verification, and financial regression testing.
- [**Deployment Guide**](./docs/deployment/DEPLOYMENT.md): Infrastructure provisioning, Docker builds, environment configuration, and CI/CD pipelines.

---

## Database, Migrations & Background Worker Quickstart

BriskSMS uses **PostgreSQL** as the sole authoritative persistence store (36 relational tables across 8 domains) and **Redis** for durable background job queues and worker heartbeats. The platform never silently falls back to in-memory storage when PostgreSQL is unavailable.

```bash
# 1. Start PostgreSQL and Redis via Docker Compose
docker compose up -d postgres redis

# 2. Apply version-controlled SQL migrations and seed the commercial catalog
npm run db:migrate
npm run db:seed
npm run db:status

# 3. Build workspace packages and run the background worker runtime
npm run build
npm run worker:start

# 4. Run the full verification & integration test suite (PostgreSQL + Redis)
npm test
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

