# BriskSMS Engineering Plan: Staging Validation & Integration Strategy

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Branch:** `main`  
**Baseline Checkpoint:** `081bf25a11c838f13275486389069070f923f865`  
**Status:** **Proposed Execution Plan (Pending remote CI approval and staging infrastructure provisioning)**  
**Target Environment:** Isolated Staging Environment (Cloud Infrastructure + Physical Cellular Test Gateway)  
**Scope:** Architecture Topology, Infrastructure Provisioning, Staging Test Matrix, Security Audit Protocols, and Incident Rollback Runbooks.

> [!IMPORTANT]
> **Staging Validation Status:** Staging is **NOT** labeled as validated prior to actual deployment and live test execution on staging infrastructure. This document defines the protocol, test matrix, and verification gates that will be executed once remote CI passes.

---

## 1. Executive Summary & Objectives

The purpose of this staging validation plan is to transition BriskSMS from isolated unit and continuous integration testing into an end-to-end operational staging environment. 

In this environment, real mobile money payment notifications, cellular SMS gateways, background queue consumers, web consoles, and developer APIs will interact under production-like conditions without risking customer funds, commercial messaging credits, or live merchant operations.

### Core Objectives:
1. **Validate Multi-Service Orchestration:** Verify seamless coordination between the API modular monolith (`apps/api`), the asynchronous BullMQ queue worker (`apps/worker`), PostgreSQL 16+, and Redis 7+.
2. **Execute Full Workstream Testing:** Test all five commercial workstreams (Identity & Session Security, Product A Payment Intelligence, Product B Cellular Messaging, Developer Platform, and Merchant Web Console) using realistic merchant workflows.
3. **Conduct External Security Penetration Testing:** Verify OWASP Top 10 API security compliance, cross-tenant isolation, CSRF protections, SSRF defenses, and cryptographic key boundaries.
4. **Establish Operational Runbooks:** Validate database migration recovery, emergency signing-key rotation, and cellular gateway failover procedures before authorizing production deployment.

---

## 2. Staging Infrastructure & Topology

The staging environment mirrors production while maintaining strict network, database, and credential isolation:

```mermaid
flowchart TD
    subgraph Public_Internet["Public Internet & Merchant Clients"]
        MerchantBrowser["Merchant Web Console (apps/web)"]
        DevClient["Developer API Clients / Zapier"]
        AndroidIngest["Product A: Android Payment Companion"]
        AndroidGateway["Product B: SMSGate Cellular Gateway Relay"]
    end

    subgraph Edge_Security["Edge & Reverse Proxy Layer (Cloudflare Staging)"]
        CF["Cloudflare Staging Proxy / WAF<br/>(TLS 1.3, HSTS, DDoS Protection, Origin Verification)"]
    end

    subgraph Staging_Compute["Isolated Staging Compute Cluster"]
        API["BriskSMS API Modular Monolith (apps/api)<br/>Bun / Node.js 24<br/>Port: 3000"]
        Worker["BriskSMS Async Queue Worker (apps/worker)<br/>BullMQ Queue Consumer<br/>Concurrency: 4"]
    end

    subgraph Staging_Persistence["Staging Data & State Tier"]
        PG[("Managed PostgreSQL 16+<br/>(Database: brisksms_staging)<br/>Row-Level Locks, ACID Transactions")]
        Redis[("Managed Redis 7+<br/>(Namespace: staging:bullmq)<br/>Auth / TLS Enabled")]
    end

    subgraph External_Simulators["External Integration Test Sinks"]
        WebhookSink["Outbound Webhook Echo Service<br/>(e.g., ngrok / webhook.site)"]
        CarrierTower["Tanzanian Cellular Networks<br/>(Vodacom, Tigo, Airtel, Halotel)"]
    end

    MerchantBrowser -->|HTTPS / WSS| CF
    DevClient -->|HTTPS Bearer/API Key| CF
    AndroidIngest -->|HTTPS Device HMAC| CF
    AndroidGateway -->|HTTPS Webhook HMAC| CF

    CF -->|Host: staging-api.brisksms.com| API
    
    API -->|DATABASE_URL (SSL)| PG
    API -->|REDIS_URL (TLS)| Redis
    
    Worker -->|DATABASE_URL (SSL)| PG
    Worker -->|REDIS_URL (TLS)| Redis
    Worker -->|Outbound Webhooks| WebhookSink
    Worker -->|SMS Dispatch| AndroidGateway

    AndroidGateway -->|Cellular Radio| CarrierTower
```

---

## 3. Pre-Deployment Staging Checklist & Secret Provisioning

Prior to deploying staging containers or running migrations, the staging environment must be provisioned with high-entropy, independent cryptographic secrets:

### 3.1 Cryptographic Key Provisioning Protocol
Every key must be generated using cryptographically secure pseudorandom number generators (`crypto.randomBytes`) and strictly separated:

```bash
# 1. AES-256-GCM Master Encryption Key (64 hex characters = 32 bytes)
export ENCRYPTION_MASTER_KEY=$(openssl rand -hex 32)

# 2. JWT Access Token Signing Secret (64 hex characters)
export JWT_ACCESS_SECRET=$(openssl rand -hex 32)

# 3. HMAC-SHA256 CSRF Token Secret (64 hex characters - MUST NOT match JWT secret)
export CSRF_SECRET=$(openssl rand -hex 32)

# 4. PostgreSQL Connection String (Dedicated staging role & database)
export DATABASE_URL="postgresql://staging_user:StagingPassword2026!@postgres-staging.internal:5432/brisksms_staging?sslmode=require"

# 5. Redis Connection String (Password protected with TLS)
export REDIS_URL="rediss://:StagingRedisPassword2026!@redis-staging.internal:6379"

# 6. Base & Frontend URLs
export API_BASE_URL="https://staging-api.brisksms.com"
export FRONTEND_URL="https://staging-console.brisksms.com"
export ALLOWED_ORIGINS="https://staging-console.brisksms.com"

# 7. Production Node Environment
export NODE_ENV="production"
```

### 3.2 Pre-Flight Validation Steps
1. **Production Guard Execution:**
   - Execute `validateProductionEncryptionConfig()` on application boot.
   - Verify that any weak or CI default keys trigger immediate fatal shutdown (`FATAL: Insecure or test ENCRYPTION_MASTER_KEY detected`).
2. **Independent Key Assertion:**
   - Ensure `CSRF_SECRET !== JWT_ACCESS_SECRET` and `CSRF_SECRET !== ENCRYPTION_MASTER_KEY`.
3. **Database Migration Deployment:**
   - Run `bun run db:migrate` against the pristine staging database.
   - Verify migration records in `_prisma_migrations` (`20261107000000_init_foundation`, `20261107010000_smsgate_keys_and_webhook_events`).
4. **Commercial Catalog Seeding:**
   - Run `bun run db:seed` (`seedCommercialCatalog()`) ensuring feature definitions (device limits, webhook access, member quotas) and default plans (Starter, Growth, Enterprise) exist.

---

## 4. Staging Test Matrix & Verification Protocols

The staging verification process is structured into five distinct workstreams, executed sequentially:

### Workstream 1: Identity, Authentication & Web Console Session Security
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-AUTH-01** | Merchant Registration & Initial Session | `POST /v1/auth/register` | Emits `bsk_session` (HttpOnly, Secure, SameSite=Lax), `bsk_refresh` (HttpOnly, Secure, SameSite=Strict, Path=/v1/auth), and `bsk_csrf` (Secure, SameSite=Lax). User and Organization records created. |
| **STG-AUTH-02** | Cross-Site Origin & Fetch Metadata Defense | `POST /v1/auth/login` from unauthorized origin | Terminated with `403 CSRF_ORIGIN_MISMATCH`. Request with `Sec-Fetch-Site: cross-site` rejected with `403 CSRF_CROSS_SITE_FORBIDDEN`. |
| **STG-AUTH-03** | HMAC-Signed Double-Submit CSRF Verification | State-mutating `POST` without `X-CSRF-Token` | Blocked with `403 CSRF_TOKEN_MISSING`. Valid matching cookie + header allowed. |
| **STG-AUTH-04** | Atomic Refresh Token Rotation & Concurrency Lock | `POST /v1/auth/refresh` using cookie | Issues new access token & rotates refresh token. Old refresh token immediately invalidated in `refresh_tokens`. Concurrent reuse blocked via `SELECT ... FOR UPDATE`. |
| **STG-AUTH-05** | Complete Logout & Session Invalidation | `POST /v1/auth/logout` | Emits `Max-Age=0` clearing cookies. Invalids JTI in `revoked_sessions` and revokes DB refresh token. Subsequent calls with old cookie return `401`. |

### Workstream 2: Product A — Payment Intelligence & Automation
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-PAY-01** | Android Device Pairing Workflow | `POST /v1/devices/pair` | Issues 6-digit numeric pairing code with 10-minute expiry. Companion app completes pairing, receives device-scoped auth token. |
| **STG-PAY-02** | Multi-Provider Notification Ingestion | Send live/fixture SMS via Companion App | Raw payload stored immutably in `raw_payment_evidence`. Normalizes Vodacom M-Pesa, Tigo Pesa, Airtel Money, and CRDB Bank alerts. |
| **STG-PAY-03** | Cryptographic Deduplication Verification | Re-send identical notification 5 times | Only 1 payment record created. 4 duplicate attempts detected via `hash(org_id + provider + ref + amount + timestamp)` and return idempotency confirmation without re-reconciling. |
| **STG-PAY-04** | Automated Invoice Reconciliation | Payment matching outstanding invoice | Invoice status transitions `PENDING` -> `PAID`. Overpayment creates `OVERPAID` invoice record and customer credit. Underpayment marks `PARTIAL_PAYMENT`. |
| **STG-PAY-05** | Downstream Automation Dispatch | Reconciled payment with webhook configured | Outbox enqueues webhook event `payment.matched`. Background worker delivers payload with valid HMAC-SHA256 signature. |

### Workstream 3: Product B — Cellular Gateway & Bulk Messaging
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-MSG-01** | Prepaid Messaging Credit Enforcement | Dispatch message with zero organization credit | Immediate rejection with `402 INSUFFICIENT_CREDITS`. Top-up credits via ledger updates balance atomically. |
| **STG-MSG-02** | TCRA Promotional Curfew Compliance | Dispatch promotional message outside 07:00-20:00 EAT | Queued with `SCHEDULED` status until 07:00 EAT next morning. Transactional OTPs bypass curfew and dispatch immediately. |
| **STG-MSG-03** | Transactional Outbox Pattern Verification | `POST /v1/messaging/send` | Atomic DB write into `messages` and `message_outbox`. BullMQ consumer picks up job, marks outbox `PROCESSED`. |
| **STG-MSG-04** | SMSGate Gateway Relay & Webhook Signature | Gateway sends `POST /v1/messaging/webhook/smsgate` | Verifies `X-Signature` HMAC-SHA256 of `rawBody + timestamp`. Skew outside 300s rejected. Replay within 300s rejected via atomic redis/db deduplication. |
| **STG-MSG-05** | Dual-Key Rotation Transition | Rotate gateway signing key | Webhook signed with `previousKey` succeeds during transition window. Once rotated, old key rejected. |

### Workstream 4: Developer Platform & Extensibility
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-DEV-01** | Developer API Key Provisioning | Web Console creates API Key | Returns `bsk_live_...` plaintext once. Database stores only `SHA-256` hash. Keys scoped to specific permissions (`payments:read`, `messages:send`). |
| **STG-DEV-02** | Developer Rate Limiting | Fire 150 requests/min with API key | Rate limiter throttles excess requests with `429 TOO_MANY_REQUESTS` and standard `Retry-After` headers. |
| **STG-DEV-03** | Outbound Webhook Retries & Backoff | Webhook endpoint responds with 500 error | BullMQ worker retries with exponential backoff (1s, 5s, 30s, 5m). Final failure logged in `webhook_deliveries` with error trace. |
| **STG-DEV-04** | Zapier Application Integration | Zapier Polling & Catch Hooks | Returns standardized JSON array formatted for Zapier schema with proper deduplication IDs. |

### Workstream 5: Merchant Web Console Experience
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-WEB-01** | Responsive Liquid Glass Layout | Access console on desktop (1920x1080) and mobile (390x844) | Refraction borders, blur filters, and warm typography render cleanly without layout overflow or performance degradation. |
| **STG-WEB-02** | Real-Time Dashboard Analytics | Refresh console after payments / messages | Dashboard KPI cards display exact live counts for processed volume, reconciliation rate, and gateway queue health. |

---

## 5. External Security Testing Protocol

Before production rollout, staging undergoes external penetration testing covering the OWASP Top 10 API Security Risks:

1. **BOLA / IDOR Isolation:**
   - Attempt to access Organization B's payment record using Organization A's API key or user session (`GET /v1/payments/:id`).
   - *Requirement:* Must return `404 NOT_FOUND` (or `403 FORBIDDEN`), never leaking evidence of existence.
2. **SSRF Defense on Outbound Webhooks & Gateway URLs:**
   - Attempt to register webhook URLs pointing to:
     - `http://127.0.0.1:5432` (Loopback)
     - `http://169.254.169.254/latest/meta-data/` (Cloud Metadata)
     - `http://10.0.0.1/` (Private Subnet)
   - *Requirement:* All rejected with `400 INVALID_ENDPOINT_URL` via SSRF filter.
3. **Cache-Control Verification on Sensitive Endpoints:**
   - Verify that all `/v1/auth/*` responses emit `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, and `Expires: 0`.

---

## 6. Testing Prerequisites & Hardware Boundaries

The following matrix clarifies dependencies that cannot be validated in CI alone and require physical hardware or third-party services:

| Dependency Layer | Prerequisites | Validation Strategy in Staging |
| :--- | :--- | :--- |
| **Database & Queues** | PostgreSQL 16+ & Redis 7+ | Provisioned via managed cloud instances with SSL and password authentication. |
| **Android Companion Hardware** | Physical Android phone (API 26+) | Merchant staff installs debug APK, grants `NotificationListenerService` permission, and disables battery optimization. |
| **Tanzanian SIM Cards** | Vodacom, Tigo, Airtel SIMs | Real cellular test accounts loaded with small balances to test live payment and SMS transmission. |
| **SMSGate Cellular Bridge** | Dedicated gateway Android device | Device running SMSGate relay paired to staging API with private HMAC signing key. |
| **Regulatory & Legal Review** | TCRA & Bank of Tanzania guidelines | Aggregator registration and compliance review with TCRA for bulk messaging; BoT non-custodial reconciliation audit. |

---

## 7. Failure Response, Incident Management & Rollback Runbook

### 7.1 Database Migration Failure Recovery
- **Trigger:** A migration fails midway during `bun run db:migrate`.
- **Mitigation:**
  - `packages/db/src/migrate.ts` executes each migration within an explicit database transaction (`withTransaction`).
  - If a statement errors, PostgreSQL rolls back all DDL/DML statements within that migration file.
  - The `_prisma_migrations` table records only completed migrations.
  - **Recovery Action:** Identify error log in migration runner output, repair SQL in `packages/db/prisma/migrations/<failed_migration>/migration.sql`, and re-execute `bun run db:migrate`.

### 7.2 Worker Queue Backpressure / Outbox Stall
- **Trigger:** Redis memory alerts exceed 80% or BullMQ queue depth exceeds 10,000 pending jobs.
- **Mitigation:**
  - Increase worker concurrency via `WORKER_CONCURRENCY=8` or deploy additional horizontal instances of `apps/worker`.
  - Stalled jobs are automatically reclaimed after 30 seconds via BullMQ lock renewal limits.

### 7.3 Emergency Signing-Key Compromise Runbook
- **Trigger:** An SMSGate device signing key or webhook secret is exposed.
- **Mitigation Protocol:**
  1. Generate new 32-byte secret.
  2. Call `setDeviceSigningKey(orgId, deviceId, newSecret)`.
  3. The service retains `previousKey` in `smsgate_keys` table for a configurable transition grace period (e.g., 2 hours).
  4. Webhook verification checks `currentKey` first, falling back to `previousKey`.
  5. Once all gateway devices are reconfigured with the new secret, execute `smsGateKeyService.revokePreviousKey(orgId, deviceId)` to permanently block the compromised key.

### 7.4 Cellular Gateway Hardware Disconnect
- **Trigger:** Android gateway device loses cellular connectivity or power.
- **Mitigation:**
  - Heartbeat monitor marks device `OFFLINE` if no heartbeat is received within 120 seconds.
  - Outbox pauses cellular dispatch to that device, queueing messages safely in PostgreSQL and Redis.
  - Automatic merchant alert dispatched via email/push notification.
  - Once device reconnects, outbox consumer resumes delivery in strict FIFO order without message loss.

---

## 8. Conclusion

This plan provides the structured test matrices, security verification gates, and operational runbooks necessary to execute staging testing once remote CI passes. Staging remains pending until live cloud infrastructure and physical test devices are provisioned.
