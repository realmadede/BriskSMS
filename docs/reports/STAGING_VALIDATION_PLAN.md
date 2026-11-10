# BriskSMS Engineering Plan: Staging Validation & Integration Strategy

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Branch:** `main`  
**Checkpoint:** `a80f99846b0d9e7ad3c5e886982e05244ad2d363` (origin/main: `c7b4a50ab8ad636996f328645be2d18517230bd2`)  
**Status:** **Proposed Execution Plan (Pending staging cloud infrastructure provisioning and physical cellular hardware deployment)**  
**Target Environment:** Isolated Staging Environment (Cloud Modular Monolith + Physical Android Test Devices + Tanzanian SIM Matrix)  
**Scope:** End-to-End Multi-Service Topology, Workstream Test Matrices, Durable Idempotency & Lease Recovery, Cellular SIM Routing, Web Console Session Security, Developer Extensibility, and Operational Rollback Runbooks.

> [!IMPORTANT]
> **Staging Validation Status:** Staging is **NOT** labeled as validated prior to actual deployment and live test execution on staging infrastructure. This document defines the protocol, test matrix, and verification gates that will be executed once staging infrastructure and physical test hardware are provisioned.

---

## 1. Executive Summary & Objectives

The purpose of this staging validation plan is to transition BriskSMS from isolated unit and continuous integration testing into an end-to-end operational staging environment. 

In this environment, real mobile money payment notifications, cellular SMS gateways, background queue consumers, web consoles, and developer APIs will interact under production-like conditions without risking customer funds, commercial messaging credits, or live merchant operations.

### Core Objectives:
1. **Validate Multi-Service Orchestration:** Verify seamless coordination between the API modular monolith (`apps/api`), the asynchronous BullMQ queue worker (`apps/worker`), PostgreSQL 16+, and Redis 7+.
2. **Execute Full Workstream Testing:** Test all five commercial workstreams:
   - Workstream 1: Identity & Session Security (`apps/api`, `apps/web`)
   - Workstream 2: Product A — Payment Intelligence & Companion Ingestion (`apps/android`, `apps/api`)
   - Workstream 3: Product B — Cellular SMSGate Gateway, Durable Idempotency & Automated Lease Recovery (`apps/api`, `apps/worker`)
   - Workstream 4: Developer Platform, Scoped API Keys, OAuth 2.0 PKCE & Outbound Webhooks (`apps/api`, `packages/zapier-app`)
   - Workstream 5: Merchant Web Console Experience (`apps/web`)
3. **Verify Cellular & Hardware Boundary Integrations:** Validate physical Android companion relay, dual-SIM cellular routing across Tanzanian mobile networks, and foreground service persistence.
4. **Conduct External Security Penetration Testing:** Verify OWASP Top 10 API security compliance, cross-tenant isolation, CSRF protections, SSRF defenses, and cryptographic key boundaries.
5. **Establish Operational Runbooks:** Validate database migration recovery, emergency signing-key rotation, dispatch lease recovery, and cellular gateway failover procedures before authorizing production deployment.

---

## 2. Staging Infrastructure & Topology

The staging environment mirrors production while maintaining strict network, database, and credential isolation:

```mermaid
flowchart TD
    subgraph Public_Internet["Public Internet & Merchant Clients"]
        MerchantBrowser["Merchant Web Console (apps/web)<br/>Port: 4200 (Static Assets)"]
        DevClient["Developer API Clients / Zapier"]
        AndroidIngest["Product A: Android Payment Companion<br/>(API 26+ Physical Phone)"]
        AndroidGateway["Product B: SMSGate Cellular Gateway<br/>(Physical Multi-SIM Android Device)"]
    end

    subgraph Edge_Security["Edge & Reverse Proxy Layer (Cloudflare Staging)"]
        CF["Cloudflare Staging Proxy / WAF<br/>(TLS 1.3, HSTS, DDoS Protection, Origin Verification)"]
    end

    subgraph Staging_Compute["Isolated Staging Compute Cluster (Single VM or VPC Group)"]
        API["BriskSMS API Modular Monolith (apps/api)<br/>Node.js 24 / Bun<br/>Port: 3000"]
        Worker["BriskSMS Async Queue Worker (apps/worker)<br/>BullMQ Queue Consumer & Dispatch Recovery Runner<br/>Concurrency: 4"]
    end

    subgraph Staging_Persistence["Staging Data & State Tier"]
        PG[("Managed PostgreSQL 16+<br/>(Database: brisksms_staging)<br/>Row-Level Locks, ACID Transactions, sslmode=require")]
        Redis[("Managed Redis 7+<br/>(Namespace: staging:bullmq)<br/>Auth & TLS Enabled")]
    end

    subgraph External_Simulators["External Integration Test Sinks"]
        WebhookSink["Outbound Webhook Echo Service<br/>(e.g., ngrok / webhook.site)"]
        CarrierTower["Tanzanian Cellular Networks<br/>(Vodacom, Mixx/Tigo, Airtel, Halotel)"]
    end

    MerchantBrowser -->|HTTPS / WSS| CF
    DevClient -->|HTTPS Bearer/API Key| CF
    AndroidIngest -->|HTTPS Device HMAC| CF
    AndroidGateway -->|HTTPS Webhook HMAC| CF

    CF -->|Host: staging-api.brisksms.com| API
    CF -->|Host: staging-console.brisksms.com| MerchantBrowser
    
    API -->|DATABASE_URL (SSL)| PG
    API -->|REDIS_URL (TLS)| Redis
    
    Worker -->|DATABASE_URL (SSL)| PG
    Worker -->|REDIS_URL (TLS)| Redis
    Worker -->|Outbound Webhooks| WebhookSink
    Worker -->|SMS Dispatch (HTTP)| AndroidGateway

    AndroidGateway -->|Cellular Radio| CarrierTower
```

---

## 3. Physical SIM & Android Hardware Test Matrix

The following matrix defines the physical hardware, carrier network requirements, and operational boundaries necessary for live staging validation:

| Carrier / Provider | Network Code | Test Number Prefix | Supported Ingestion (Product A) | Outbound Dispatch (Product B) | Physical SIM Slot |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Vodacom Tanzania** | 640-04 | `+255 74x`, `+255 75x`, `+255 76x` | M-Pesa push/SMS notifications (`MPESA`) | SMSGate SIM 1 routing via cellular radio | Slot 1 |
| **Mixx by Yas (Tigo)** | 640-02 | `+255 65x`, `+255 67x`, `+255 71x` | Tigo Pesa payment notifications (`TIGO_PESA`) | SMSGate SIM 2 routing via cellular radio | Slot 2 |
| **Airtel Tanzania** | 640-05 | `+255 68x`, `+255 69x`, `+255 78x` | Airtel Money notifications (`AIRTEL_MONEY`) | Carrier routing / fallback | Secondary Test Device |
| **Halotel Tanzania** | 640-09 | `+255 62x` | HaloPesa notifications (`HALOPESA`) | Carrier routing / fallback | Secondary Test Device |
| **CRDB Bank** | N/A | Alpha sender `CRDB` | Bank push alerts & payment receipts | N/A (Inbound evidence only) | Notification Ingestion |

### Android Companion & Gateway Hardware Profile:
- **Product A Companion Phone:** Dedicated physical Android handset running Android 8.0+ (API 26 to API 35).
  - *Permissions Required:* `BIND_NOTIFICATION_LISTENER_SERVICE`, `POST_NOTIFICATIONS`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
  - *OEM Battery Optimization:* White-listed from aggressive background process termination (Samsung Auto-optimization disabled, Xiaomi MIUI battery saver set to "No restrictions", Transsion/Tecno autostart enabled).
- **Product B SMSGate Gateway Device:** Dedicated physical dual-SIM Android handset running the SMSGate relay application.
  - *Network Configuration:* Direct HTTPS connectivity to `staging-api.brisksms.com`.
  - *Webhook Signing:* Configured with staging HMAC-SHA256 device signing secret.

---

## 4. Staging Test Matrix & Verification Protocols

The staging verification process is structured into five distinct workstreams, executed sequentially:

### Workstream 1: Identity, Authentication & Web Console Session Security
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-AUTH-01** | Merchant Registration & Initial Session | `POST /v1/auth/register` | Emits `bsk_session` (HttpOnly, Secure, SameSite=Lax), `bsk_refresh` (HttpOnly, Secure, SameSite=Strict, Path=/v1/auth), and `bsk_csrf` (Secure, SameSite=Lax). User and Organization records created in DB. |
| **STG-AUTH-02** | Cross-Site Origin & Fetch Metadata Defense | `POST /v1/auth/login` from unauthorized origin | Terminated with `403 CSRF_ORIGIN_MISMATCH`. Request with `Sec-Fetch-Site: cross-site` rejected with `403 CSRF_CROSS_SITE_FORBIDDEN`. |
| **STG-AUTH-03** | HMAC-Signed Double-Submit CSRF Verification | State-mutating `POST` without `X-CSRF-Token` | Blocked with `403 CSRF_TOKEN_MISSING`. Valid matching cookie + header allowed. |
| **STG-AUTH-04** | Atomic Refresh Token Rotation & Concurrency Lock | `POST /v1/auth/refresh` using cookie | Issues new access token & rotates refresh token. Old refresh token immediately invalidated in `refresh_tokens`. Concurrent reuse blocked via `SELECT ... FOR UPDATE`. |
| **STG-AUTH-05** | Complete Logout & Session Invalidation | `POST /v1/auth/logout` | Emits `Max-Age=0` clearing cookies. Invalids JTI in `revoked_sessions` and revokes DB refresh token. Subsequent calls with old cookie return `401`. |

### Workstream 2: Product A — Payment Intelligence & Automation
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-PAY-01** | Android Device Pairing Workflow | `POST /v1/devices/pair` | Issues 6-digit numeric pairing code with 10-minute expiry. Companion app completes pairing, receives device-scoped auth token stored in Android Keystore. |
| **STG-PAY-02** | Multi-Provider Notification Ingestion | Send live/fixture SMS via Companion App | Raw payload stored immutably in `raw_payment_evidence`. Normalizes Vodacom M-Pesa, Tigo Pesa, Airtel Money, Halotel, and CRDB Bank alerts. |
| **STG-PAY-03** | Cryptographic Deduplication Verification | Re-send identical notification 5 times | Exactly 1 payment record created. 4 duplicate attempts detected via `hash(org_id + provider + ref + amount + timestamp)` and return idempotency confirmation without re-reconciling. |
| **STG-PAY-04** | Offline Evidence Queue & Synchronization | Ingest payments in airplane mode, reconnect | Room database queues evidence locally; synchronizes in FIFO order upon network restoration without data loss. |
| **STG-PAY-05** | Deterministic Invoice Matching | Payment matching outstanding invoice | Exact match: invoice transitions `PENDING` -> `PAID`. Overpayment creates `OVERPAID` invoice record. Underpayment marks `PARTIAL_PAYMENT`. Ambiguous match routes to `REVIEW_REQUIRED`. |
| **STG-PAY-06** | Downstream Automation Dispatch | Reconciled payment with webhook configured | Outbox enqueues webhook event `payment.matched`. Background worker delivers payload with valid HMAC-SHA256 signature. |

### Workstream 3: Product B — Cellular Gateway, Durable Idempotency & Lease Recovery
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-MSG-01** | Organization-Scoped Durable Idempotency | `POST /v1/messages/send` with `Idempotency-Key: k1` | Exactly one message operation and one credit deduction. Repeated calls with identical key return original cached response. Different organization using `k1` is isolated. |
| **STG-MSG-02** | Prepaid Messaging Credit Enforcement | Dispatch message with zero organization credit | Immediate rejection with `402 INSUFFICIENT_CREDITS`. Top-up credits via ledger updates balance atomically. |
| **STG-MSG-03** | Crash Window Recovery Sweep (`PENDING`) | Simulate API crash after DB reservation commit | Operation remains `PENDING`. `DispatchRecoveryRunner` sweeps it after `DISPATCH_PENDING_GRACE_SECONDS` (60s), claims lease via atomic CAS, and dispatches to SMSGate. Exactly 1 gateway call. |
| **STG-MSG-04** | Crash After Claim Window (`DISPATCHING`) | Simulate API crash while waiting for SMSGate | Lease expires after lease window. Recovery runner detects expired claim with unknowable outcome and marks status `UNCERTAIN`. **NO re-dispatch, NO refund.** Routed for operator review. |
| **STG-MSG-05** | Definitive Rejection vs Terminal Failure Refund | Gateway returns 400 Bad Request or 422 Invalid | Classifies as definitive failure. Credit is refunded atomically to organization ledger once. Duplicate retries/webhooks never duplicate refund. |
| **STG-MSG-06** | Gateway HTTP 409 Conflict Handling | Gateway responds with HTTP 409 Conflict | Operation classified strictly as `UNCERTAIN`. **Never blindly refunded, never re-dispatched.** Preserved in database for reconciliation audit. |
| **STG-MSG-07** | Dual-Key Gateway Webhook Verification | Gateway sends delivery receipt | Verifies `X-Signature` HMAC-SHA256 against `currentKey` or `previousKey`. Skew > 300s rejected. Replay within 300s rejected. |
| **STG-MSG-08** | TCRA Promotional Curfew Compliance | Dispatch promotional SMS outside 07:00-20:00 EAT | Queued with `SCHEDULED` status until 07:00 EAT next morning. Transactional OTPs bypass curfew and dispatch immediately. |

### Workstream 4: Developer Platform & Extensibility
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-DEV-01** | Developer API Key Provisioning | Web Console creates API Key | Returns `bsk_live_...` plaintext once. Database stores only `SHA-256` hash. Keys scoped to specific permissions (`payments:read`, `messages:send`). |
| **STG-DEV-02** | Developer Rate Limiting | Fire 150 requests/min with API key | Rate limiter throttles excess requests with `429 TOO_MANY_REQUESTS` and standard `Retry-After` headers. |
| **STG-DEV-03** | OAuth 2.0 PKCE Authorization | Zapier OAuth authorization flow | Validates code challenge and verifier. Issues scoped token. Enforces tenant boundaries. |
| **STG-DEV-04** | Outbound Webhook Retries & Backoff | Webhook endpoint responds with 500 error | BullMQ worker retries with exponential backoff (1s, 5s, 30s, 5m). Final failure logged in `webhook_deliveries` with error trace. |

### Workstream 5: Merchant Web Console Experience
| Test ID | Test Scenario | Execution Method | Expected Verifiable Result |
| :--- | :--- | :--- | :--- |
| **STG-WEB-01** | Static Asset Serving & Security | Access `https://staging-console.brisksms.com` | `apps/web/server.ts` serves static Stitch assets (`index.html`, `console.html`, `developers.html`) with strict security headers. |
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

| Dependency Layer | Prerequisites | Validation Strategy in Staging |
| :--- | :--- | :--- |
| **Database & Queues** | PostgreSQL 16+ & Redis 7+ | Provisioned via managed cloud instances with SSL and password authentication. |
| **Android Companion Hardware** | Physical Android phone (API 26+) | Merchant staff installs debug APK, grants `NotificationListenerService` permission, and disables battery optimization. |
| **Tanzanian SIM Cards** | Vodacom, Mixx/Tigo, Airtel, Halotel | Real cellular test accounts loaded with small balances to test live payment and SMS transmission. |
| **SMSGate Cellular Bridge** | Dedicated gateway Android device | Device running SMSGate relay paired to staging API with private HMAC signing key. |
| **Regulatory & Legal Review** | TCRA & Bank of Tanzania guidelines | Aggregator registration and compliance review with TCRA for bulk messaging; BoT non-custodial reconciliation audit. |

---

## 7. Incident Management & Rollback Runbook Summary

Detailed operational steps are documented in `docs/reports/STAGING_DEPLOYMENT_RUNBOOK.md`. Summary:
1. **Migration Rollback:** PostgreSQL transactions ensure clean rollback of failed migration files.
2. **Worker Recovery:** BullMQ job stalling auto-reclaims locks after 30 seconds; `DispatchRecoveryRunner` reclaims crashed PENDING dispatches after 60 seconds.
3. **Emergency Key Rotation:** `smsgate_keys` table supports dual-key transition window (`currentKey` and `previousKey`) with zero downtime.
4. **Cellular Hardware Disconnect:** Heartbeat monitor detects offline gateway after 120s; dispatches pause safely in queue without data loss.

---

## 8. Conclusion

This plan provides the structured test matrices, security verification gates, and hardware routing protocols necessary to execute staging testing once staging cloud infrastructure and physical Android test devices are provisioned. Staging remains pending until live cloud infrastructure and physical test devices are provisioned.
