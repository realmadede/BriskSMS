# AGENTS.md — Engineering Governance & Agent Operating Guidelines

Welcome to the **BriskSMS** engineering repository. This document defines the operational invariants, behavioral standards, technical rules, and architecture governance that all automated agents and human contributors must follow when working in this codebase.

---

## 1. Primary Operating Principles

1. **Production-First & Security-First:**
   - BriskSMS is a commercial financial reconciliation and messaging SaaS platform. Every line of code must be designed for reliability, strict tenant isolation, idempotency, and financial correctness.
   - We do not build prototypes, hackathon code, or MVP shortcuts. All modules must include error handling, audit logging, input validation, and automated tests.

2. **Zero Hallucination & Evidence-Based Progress:**
   - Never fabricate completed work, test results, or integration claims.
   - Never use mock data to represent real payment verification in production paths.
   - Differentiate strictly between verified facts, assumptions, and recommendations.

3. **Product Boundaries (Non-Negotiable):**
   - **Android & Web Only:** Android client for notification ingestion; Angular web application for administration. No iOS/Swift development.
   - **Product Separation:** Product A (Payment Intelligence) and Product B (Bulk Messaging) are independently monetized and logically separate. Payment reconciliation must **never** require bulk messaging credits.
   - **Non-Custodial:** BriskSMS never holds customer funds, operates an escrow, or acts as a payment clearing house.
   - **No Automated Guesswork:** Financial decisions require deterministic rule matching. Uncertain matches must be routed to `REVIEW_REQUIRED` (human review). AI must never make authoritative payment settlement decisions.
   - **Scoped SMS Processing:** Only authorized payment notifications from supported providers/banks may be processed. Personal messages must never be ingested or persisted.

---

## 2. Monorepo Architecture & Directory Layout

The repository is structured as a modular TypeScript/Kotlin monorepo:

```
BriskSMS/
├── AGENTS.md                          # Agent instructions and repository governance
├── README.md                          # Repository overview and developer onboarding
├── package.json                       # Root workspace configuration
├── docs/                              # System specifications and documentation
│   ├── prd/                           # Product Requirements Documents
│   ├── architecture/                  # System architecture, monorepo, & module boundaries
│   ├── competitive/                   # Market research and competitive analyses
│   ├── financial/                     # Financial state machine, invariants, ledger design
│   ├── security/                      # Threat modeling, encryption, isolation, key management
│   ├── compliance/                    # Legal, PDPA/PDPC, BoT, TCRA, Play Store compliance
│   ├── roadmap/                       # Phased commercial implementation roadmap
│   ├── standards/                     # API, Database, Coding, and Testing conventions
│   ├── deployment/                    # Cloudflare, Docker, CI/CD, and infrastructure ops
│   └── CONTRIBUTING.md                # Contribution workflow and pull request rules
├── apps/
│   ├── api/                           # NestJS backend API (modular monolith)
│   ├── worker/                        # Background queue consumer (BullMQ/Redis)
│   ├── web/                           # Angular enterprise web application
│   └── android/                       # Kotlin + Jetpack background relay application
└── packages/
    ├── shared/                        # Shared TypeScript DTOs, interfaces, and constants
    ├── parser-engine/                 # Provider parsing, normalization, and hashing engine
    ├── db/                            # Prisma schema, migrations, seeders, and client
    └── config/                        # Shared ESLint, Prettier, and TypeScript configs
```

---

## 3. Financial Invariants & Rules

When implementing or modifying financial, invoice, or ledger logic:

1. **Raw Evidence Immutability:** Raw incoming notification payloads and device metadata must be persisted immutably in an append-only log (`raw_payment_evidence`). Never update or delete raw evidence.
2. **Deterministic Deduplication:** Deduplication keys must be cryptographically hashed: `hash(org_id + provider + provider_reference + amount + timestamp)`. A duplicate must never trigger double settlement or fulfillment.
3. **Transactional Mutations:** Invoice balance updates and payment reconciliations must execute within ACID transactions with row-level locks (`SELECT ... FOR UPDATE`).
4. **Idempotent Automation:** All downstream workflow actions (e.g., MikroTik user activation, WHMCS invoice marking, webhooks) must use unique idempotency keys and support safe retries.
5. **Ledger Isolation:** Payment reconciliation billing (SaaS subscription) and bulk messaging billing (prepaid credit ledger) must have completely distinct database models and financial ledgers.

---

## 4. Coding & Security Rules

1. **Tenant Isolation:** Every database table representing tenant data must include `organizationId`. All queries must filter by `organizationId`. Multi-tenant leaks are critical security vulnerabilities.
2. **Secrets Management:** Never commit secrets, API keys, private keys, or credentials to version control. Use `.env.example` templates and load configuration via validated environment schemas (Zod / `@nestjs/config`).
3. **Commit Signing:** All Git commits must be signed using the developer's registered SSH key (`realmadede`).
4. **Testing Standards:**
   - Parser tests must run against real, anonymized provider SMS samples.
   - Financial state transitions must be covered by integration tests checking all edge cases (underpayment, overpayment, duplicate replay, network failure).
5. **Small, Atomic Changes:** Implement features in isolated, logical increments. Never mix infrastructure changes with business logic or large refactors.

---

## 5. Agent Workflow Guidelines

When an AI agent operates in this repository:
1. Consult this `AGENTS.md` and the relevant documents in `docs/` before making architectural or code decisions.
2. Do not introduce new third-party dependencies without demonstrating a clear engineering need and verifying licensing/maintenance.
3. Keep documentation in `docs/` synchronised with actual code changes.
4. Report concrete file changes, executed commands, and test verification results in every turn.
