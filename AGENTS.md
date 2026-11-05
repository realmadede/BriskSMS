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

## 2. Universal Karpathy Invariants (The Skarp Framework)

All AI agents (Google Antigravity, Claude Code, Cursor, Copilot, etc.) and contributors operating in BriskSMS must adhere strictly to the Skarp behavioral guidelines derived from Andrej Karpathy's observations on LLM coding pitfalls. 

**Tradeoff:** These guidelines intentionally bias toward **caution over speed**. For non-trivial tasks, adhere strictly to these principles.

### 2.1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**
- **State assumptions explicitly**: If any requirement, financial rule, or architectural detail is uncertain, ask the user rather than guessing.
- **Surface multiple interpretations**: If a request can be reasonably interpreted in multiple ways, present the options and tradeoffs instead of silently picking one.
- **Push back when warranted**: If a requested change is overengineered or if a significantly simpler, safer path exists, explain why and recommend the alternative.
- **Stop when confused**: If context is missing, behavior is contradictory, or requirements are unclear, halt immediately. Clearly name what is missing or confusing and ask.

### 2.2. Simplicity First
**Write the minimum code that solves the problem. Nothing speculative.**
- **No speculative features**: Implement only what was requested. Do not add unasked-for "flexibility", "configurability", or future-proofing.
- **No single-use abstractions**: Write concrete, inline code before reaching for abstract patterns, helper classes, or generic wrappers that are only used in one place.
- **No defensive bloat**: Do not write complex error handling or fallback cascades for scenarios that are physically or logically impossible within the system.
- **Conciseness matters**: If 200 lines could be written cleanly in 50 lines, rewrite it.
- **The Senior Engineer Smell Test**: Ask yourself: *"Would a senior engineer review this and say it is overcomplicated?"* If the answer is yes, simplify before presenting the result.

### 2.3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**
- **Zero orthogonal edits**: Do not "improve", reformat, or restyle adjacent code, comments, imports, or whitespace that are unrelated to the current task.
- **Respect working code**: Do not refactor components, functions, or systems that are not broken or directly in scope.
- **Match existing style**: Follow the project's established conventions, naming patterns, indentation, and idioms.
- **Preserve existing dead code**: If you notice pre-existing unused variables or comments, mention them in your summary—do not delete them unless explicitly instructed.
- **Clean up your own orphans**: If YOUR changes render imports, variables, or functions obsolete, remove them cleanly.
- **The Diff Test**: Every single line in your diff must trace directly and demonstrably to the user's request.

### 2.4. Goal-Driven Execution
**Define success criteria upfront. Loop until verified.**
- Transform vague imperative instructions into declarative, verifiable outcomes.
- For any multi-step task, formulate a concise, verifiable plan:
  ```text
  1. [Step 1 description] → verify: [command / test / check]
  2. [Step 2 description] → verify: [command / test / check]
  3. [Step 3 description] → verify: [command / test / check]
  ```
- Run test suites (`npm test` / `bun test`), linters, or manual verification commands in your execution environment after each change. Do not declare a task complete until verification criteria pass.

### 2.5. Summary of Working Behavior
These guidelines are functioning correctly when:
- **Diffs are minimal and focused**: Only requested changes appear in git diffs.
- **No rewrite cycles**: Code is simple, idiomatic, and correct on the first attempt.
- **Clarification precedes implementation**: Questions are asked before making mistakes, not during cleanup.
- **Tests and checks verify completion**: Changes are accompanied by concrete verification evidence.
- **Reference:** [https://github.com/realmadede/Skarp](https://github.com/realmadede/Skarp)

---

## 3. Monorepo Architecture & Directory Layout

The repository is structured as a modular TypeScript/Kotlin monorepo:

```
BriskSMS/
├── AGENTS.md                          # Universal agent instructions and repository governance
├── README.md                          # Repository overview and developer onboarding
├── LICENSE                            # Proprietary license (BriskSMS Team)
├── package.json                       # Root workspace configuration
├── docker-compose.yml                 # Local development PostgreSQL and Redis
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
    ├── ui/                            # Liquid Glass design system & optical refraction (Glisse)
    ├── db/                            # Prisma schema, migrations, seeders, and client
    └── config/                        # Shared ESLint, Prettier, and TypeScript configs
```

---

## 4. Financial Invariants & Rules

When implementing or modifying financial, invoice, or ledger logic:

1. **Raw Evidence Immutability:** Raw incoming notification payloads and device metadata must be persisted immutably in an append-only log (`raw_payment_evidence`). Never update or delete raw evidence.
2. **Deterministic Deduplication:** Deduplication keys must be cryptographically hashed: `hash(org_id + provider + provider_reference + amount + timestamp)`. A duplicate must never trigger double settlement or fulfillment.
3. **Transactional Mutations:** Invoice balance updates and payment reconciliations must execute within ACID transactions with row-level locks (`SELECT ... FOR UPDATE`).
4. **Idempotent Automation:** All downstream workflow actions (e.g., MikroTik user activation, WHMCS invoice marking, webhooks) must use unique idempotency keys and support safe retries.
5. **Ledger Isolation:** Payment reconciliation billing (SaaS subscription) and bulk messaging billing (prepaid credit ledger) must have completely distinct database models and financial ledgers.

---

## 5. Coding & Security Rules

1. **Tenant Isolation:** Every database table representing tenant data must include `organizationId`. All queries must filter by `organizationId`. Multi-tenant leaks are critical security vulnerabilities.
2. **Secrets Management:** Never commit secrets, API keys, private keys, or credentials to version control. Use `.env.example` templates and load configuration via validated environment schemas (Zod / `@nestjs/config`).
3. **Commit Signing:** All Git commits must be signed using the developer's registered SSH key (`realmadede`).
4. **Testing Standards:**
   - Parser tests must run against real, anonymized provider SMS samples.
   - Financial state transitions must be covered by integration tests checking all edge cases (underpayment, overpayment, duplicate replay, network failure).
5. **Small, Atomic Changes:** Implement features in isolated, logical increments. Never mix infrastructure changes with business logic or large refactors.

---

## 6. Agent Workflow Guidelines

When an AI agent operates in this repository:
1. Consult this `AGENTS.md` and the relevant documents in `docs/` before making architectural or code decisions.
2. Do not introduce new third-party dependencies without demonstrating a clear engineering need and verifying licensing/maintenance.
3. Keep documentation in `docs/` synchronised with actual code changes.
4. Report concrete file changes, executed commands, and test verification results in every turn.
