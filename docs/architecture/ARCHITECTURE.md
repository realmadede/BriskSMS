# Deliverable D: Technical Architecture & System Design

**Document Version:** 1.0.0  
**Status:** Approved Architectural Blueprint  
**System Type:** Commercial SaaS Multi-Tenant Platform  
**Target Environment:** Linux / Docker / Cloudflare / PostgreSQL / Android  

---

## 1. High-Level System Architecture

BriskSMS is engineered as a **distributed, event-driven modular monolith**. 

The architecture decouples high-throughput ingest operations from complex financial reconciliation and external third-party automations via persistent queues. This guarantees that bursty payment notifications or slow external APIs (e.g., MikroTik routers over cellular links or telco aggregators) never degrade ingestion throughput or cause data loss.

```
+---------------------------------------------------------------------------------------------------+
|                                            CLIENT LAYER                                           |
+---------------------------------------------------------------------------------------------------+
|  [Android Relay App]        [Web Management Portal]       [External Merchant Webhooks]            |
|  - Kotlin + Jetpack Compose - Angular 19+ (Standalone)    - WHMCS / MikroTik / Custom ERP         |
|  - Room DB (Offline Queue)  - Signals + NgRx/Component    - Signed HMAC Payloads                  |
|  - Keystore Asymmetric Auth - Responsive Enterprise UI                                            |
+---------------------------------------------------------------------------------------------------+
                                                  | TLS 1.3
                                                  v
+---------------------------------------------------------------------------------------------------+
|                                      EDGE & SECURITY GATEWAY                                      |
+---------------------------------------------------------------------------------------------------+
|  Cloudflare Edge Network:                                                                         |
|  - WAF & DDoS Shielding                                                                           |
|  - Rate Limiting (Token Bucket per IP / API Key)                                                  |
|  - TLS Termination & SSL Pinning                                                                  |
|  - Static Asset Delivery (Web App SPA)                                                            |
+---------------------------------------------------------------------------------------------------+
                                                  |
                                                  v
+---------------------------------------------------------------------------------------------------+
|                                    BACKEND MODULAR MONOLITH                                       |
|                                    (NestJS / TypeScript API)                                      |
+---------------------------------------------------------------------------------------------------+
|  +---------------------+   +---------------------+   +---------------------+                      |
|  |     AuthModule      |   |  OrganizationModule |   |    DeviceModule     |                      |
|  | - JWT / Refresh     |   | - Multi-tenancy     |   | - QR Pairing Flow   |                      |
|  | - RBAC Guards       |   | - Plan Quotas       |   | - Keystore Auth     |                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  |    PaymentModule    |   |ReconciliationModule |   |  AutomationModule   |                      |
|  | - Fast Ingestion    |   | - Invoicing Engine  |   | - Rule Engine       |                      |
|  | - Raw Persistence   |   | - Matching Matrix   |   | - Idempotency Keys  |                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  |   MessagingModule   |   |    BillingModule    |   |  DeveloperModule    |                      |
|  | - Bulk SMS Engine   |   | - Product A (SaaS)  |   | - API Keys / Tokens |                      |
|  | - Credit Ledger     |   | - Product B (SMS)   |   | - Webhook Dispatch  |                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
+---------------------------------------------------------------------------------------------------+
           |                                                      ^
           | (Fast Enqueue)                                       | (Transactional State Updates)
           v                                                      |
+------------------------------------+             +------------------------------------+
|       ASYNC QUEUE BROKER           |             |       PERSISTENCE LAYER            |
|       (Redis 7+ / BullMQ)          |             |       (PostgreSQL 16+)             |
+------------------------------------+             +------------------------------------+
| Queues:                            |             | Core Tables:                       |
| - `ingest.parse`                   |             | - `organizations`, `users`         |
| - `reconcile.match`                |             | - `devices`, `device_telemetry`    |
| - `automation.execute`             |             | - `raw_payment_evidence` (Append)  |
| - `webhook.deliver`                |             | - `normalized_payments`            |
| - `sms.dispatch`                   |             | - `invoices`, `invoice_payments`   |
+------------------------------------+             | - `messaging_credit_ledger`        |
           |                                       | - `audit_logs` (Immutable)         |
           v                                       +------------------------------------+
+------------------------------------+
|     BACKGROUND WORKER NODES        |
|     (NestJS Worker Runners)        |
+------------------------------------+
| - Worker 1: Parser & Deduplication |
| - Worker 2: Reconciliation Matcher |
| - Worker 3: MikroTik / WHMCS Engine|
| - Worker 4: Bulk SMS Gateway Hub   |
| - Worker 5: Webhook Retries (Backoff)
+------------------------------------+
```

---

## 2. Monorepo Structure

The monorepo uses npm/pnpm workspaces. It strictly enforces dependency direction: `apps` may import from `packages`, but `packages` never import from `apps`.

```
BriskSMS/
├── package.json                         # Workspace root definition
├── package-lock.json                    # Deterministic dependency lockfile
├── .gitignore                           # Git exclusion rules
├── .editorconfig                        # Universal formatting standard
├── AGENTS.md                            # Governance and agent rules
├── README.md                            # Project overview
├── docker-compose.yml                   # Local development environment (Postgres, Redis)
│
├── apps/
│   ├── api/                             # Backend REST API (NestJS)
│   │   ├── src/
│   │   │   ├── main.ts                  # Application bootstrap & validation pipes
│   │   │   ├── app.module.ts            # Root module registering feature domains
│   │   │   └── modules/                 # Strict domain-driven modules
│   │   ├── test/                        # E2E test suites
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── worker/                          # Background processing service (NestJS/BullMQ)
│   │   ├── src/
│   │   │   ├── main.ts                  # Worker bootstrap
│   │   │   ├── processors/              # Queue processors (ingest, match, auto, sms)
│   │   │   └── adapters/                # External protocol clients (MikroTik, WHMCS)
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── web/                             # Web Frontend (Angular 19+)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── core/                # Auth guards, HTTP interceptors, state services
│   │   │   │   ├── features/            # Dashboard, Devices, Payments, Invoices, SMS
│   │   │   │   └── shared/              # Reusable UI components, pipes, directives
│   │   ├── angular.json
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── android/                         # Mobile Relay App (Kotlin + Jetpack)
│       ├── app/
│       │   ├── src/main/java/tz/co/brisksms/
│       │   │   ├── core/                # Security, Keystore, Room DB, Retrofit
│       │   │   ├── service/             # Ingestion service (NotificationListener / SMS)
│       │   │   ├── ui/                  # Jetpack Compose UI (Pairing, Telemetry, Logs)
│       │   │   └── worker/              # WorkManager offline sync worker
│       │   └── build.gradle.kts
│       └── build.gradle.kts
│
└── packages/
    ├── shared/                          # Universal types, interfaces, DTOs, and constants
    │   ├── src/
    │   │   ├── enums/                   # TransactionState, Role, ProviderType
    │   │   ├── dtos/                    # Request/Response data transfer objects
    │   │   └── utils/                   # Hash generators, date utilities, validators
    │   ├── tsconfig.json
    │   └── package.json
    │
    ├── parser-engine/                   # Payment parser adapters & normalizers
    │   ├── src/
    │   │   ├── providers/               # M-Pesa, Mixx, Airtel, HaloPesa, CRDB, NMB
    │   │   ├── normalizer.ts            # Canonical transaction builder
    │   │   └── deduplicator.ts          # Deterministic payload hashing
    │   ├── test/                        # Real-world anonymized SMS test fixtures
    │   ├── tsconfig.json
    │   └── package.json
    │
    ├── db/                              # Database schema & Prisma client
    │   ├── prisma/
    │   │   ├── schema.prisma            # Canonical relational schema
    │   │   ├── migrations/              # Versioned SQL migrations
    │   │   └── seeds/                   # Seed data for dev/test
    │   ├── src/
    │   │   ├── index.ts                 # Prisma client export with tenant extensions
    │   │   └── client.ts
    │   ├── tsconfig.json
    │   └── package.json
    │
    └── config/                          # Shared configurations
        ├── eslint-preset.js
        ├── prettier-preset.js
        └── tsconfig.base.json
```

---

## 3. Backend Module Boundaries (NestJS)

To maintain long-term maintainability and prevent circular dependencies, the backend follows strict modular boundaries:

```
                  +----------------------------------------------+
                  |                 AppModule                    |
                  +----------------------------------------------+
                                         |
     +-----------------+-----------------+-----------------+-----------------+
     |                 |                 |                 |                 |
     v                 v                 v                 v                 v
+----------+     +------------+    +-----------+     +-----------+     +------------+
|AuthModule|     | OrgModule  |    |DeviceMod  |     |PaymentMod |     |ReconcileMod|
+----------+     +------------+    +-----------+     +-----------+     +------------+
     ^                 ^                 ^                 ^                 ^
     |                 |                 |                 |                 |
     +-----------------+-----------------+-----------------+-----------------+
                                         |
                                         v
                         +-------------------------------+
                         |   Core Infrastructure Layer   |
                         | - PrismaModule (Tenant Scope) |
                         | - QueueModule (BullMQ/Redis)  |
                         | - TelemetryModule (Sentry)    |
                         | - CryptoModule (HMAC, AES)    |
                         +-------------------------------+
```

### Module Responsibilities:
1. **`AuthModule`**: User registration, login, JWT issuance, refresh token rotation, 2FA validation, password hashing (Argon2id).
2. **`OrgModule`**: Multi-tenant organization CRUD, team member invitations, role assignments, subscription quota tracking.
3. **`DeviceModule`**: QR pairing token generation, Android device handshake, hardware public key verification, device heartbeat telemetry, device revocation.
4. **`PaymentModule`**: Raw payload ingestion endpoint (`POST /v1/ingest/notifications`), payload persistence, parser delegation, and deduplication.
5. **`ReconciliationModule`**: Invoice CRUD, automated matching matrix, partial/overpayment accounting, manual match approval queue.
6. **`AutomationModule`**: Event listener, rule engine, action dispatcher (MikroTik RouterOS API client, WHMCS REST client, webhook delivery).
7. **`MessagingModule`**: Product B engine: Sender ID registration, prepaid credit ledger management, single/bulk SMS dispatch, aggregator failover routing, and DLR ingestion.
8. **`BillingModule`**: Product A SaaS subscriptions, Product B SMS credit purchasing, invoice generation, integration with local checkout.
9. **`DeveloperModule`**: API key generation (hashed in DB), webhook endpoint registration, event log inspector.

---

## 4. Database Architecture (PostgreSQL & Prisma)

The database schema is organized around multi-tenancy, immutable financial evidence, and strict ledger separation.

### Key Database Entities & Relationships:

```
[organizations] 1 ----< N [users_organizations] >---- 1 [users]
       |
       +-----< N [devices]
       |
       +-----< N [raw_payment_evidence] (Immutable append-only)
       |              |
       |              v 1:1
       +-----< N [normalized_payments] (Canonical record)
       |              |
       |              v N:1
       +-----< N [invoices]
       |              |
       |              +-----< N [invoice_payments] (ACID settlement link)
       |
       +-----< N [automation_rules] ---> N [automation_logs]
       |
       +-----< 1 [messaging_accounts] (Product B)
                      |
                      +-----< N [messaging_credit_ledger] (Atomic credits/debits)
                      +-----< N [sms_campaigns] ---> N [sms_messages]
```

### Core Schema Invariants:
1. **Tenant Keying:** Every tenant table includes `organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT run-time enforcement`.
2. **Primary Keys:** `UUIDv7` or time-ordered UUIDs for distributed indexing performance and sequential B-tree ordering.
3. **Evidence Immutability:** `raw_payment_evidence` contains no `updated_at` column; it cannot be modified once written.
4. **Unique Deduplication Index:**
   ```sql
   CREATE UNIQUE INDEX idx_payments_dedup_hash 
   ON normalized_payments (organization_id, deduplication_hash);
   ```
5. **Ledger Concurrency:** Updates to `messaging_credit_ledger` or `invoices` balance execute using PostgreSQL row-level locks:
   ```sql
   SELECT balance FROM invoices WHERE id = :invoiceId FOR UPDATE;
   ```

---

## 5. Asynchronous Queue Architecture (BullMQ / Redis)

Ingestion must never block on downstream dependencies. The queue structure separates duties into distinct queues with dedicated concurrency and retry configurations:

| Queue Name | Producer | Consumer | Concurrency | Backoff Strategy | Dead Letter Queue |
|---|---|---|---|---|---|
| `ingest.parse` | `PaymentModule.ingest` | `Worker.ParseProcessor` | High (20) | Exponential: 3 retries (1s, 5s, 15s) | `ingest.parse.dlq` |
| `reconcile.match` | `ParseProcessor` | `Worker.MatchProcessor` | Medium (10) | Exponential: 5 retries (2s, 10s, 30s) | `reconcile.match.dlq` |
| `automation.execute`| `MatchProcessor` | `Worker.AutoProcessor` | Controlled (5) | Exponential: 5 retries (5s, 30s, 120s) | `automation.execute.dlq` |
| `webhook.deliver` | `AutoProcessor` | `Worker.WebhookProcessor` | High (25) | Exponential: 5 retries over 24h | `webhook.deliver.dlq` |
| `sms.dispatch` | `MessagingModule` | `Worker.SmsProcessor` | Aggregator limits (10) | Linear: 3 retries | `sms.dispatch.dlq` |

---

## 6. Android Relay Architecture

The Android app acts as a secure, low-power background gateway:

```
[Android OS Notification Shade] / [Incoming Carrier SMS]
                     |
                     v
  +------------------------------------------------------+
  |         BriskSMS Android Ingestion Service           |
  |                                                      |
  |  Mode A (Standard / Play Store):                     |
  |  - NotificationListenerService                       |
  |  - Filters by approved package names                 |
  |    (e.g., M-Pesa app, Bank apps, System Messages)   |
  |                                                      |
  |  Mode B (Direct Enterprise APK):                     |
  |  - BroadcastReceiver (android.provider.Telephony)    |
  |  - Filters by approved Sender shortcodes             |
  +------------------------------------------------------+
                     |
                     v
  +------------------------------------------------------+
  |            Local Security & Scrubbing                |
  |  - Discards personal messages immediately            |
  |  - Encrypts payload before local persistence         |
  +------------------------------------------------------+
                     |
                     v
  +------------------------------------------------------+
  |            Local Offline Queue (Room DB)             |
  |  - Durable local SQLite storage                      |
  |  - Tracks `PENDING_SYNC`, `SYNCED`, `FAILED`         |
  +------------------------------------------------------+
                     |
                     v (Network Available)
  +------------------------------------------------------+
  |            Ingestion Sync Engine                     |
  |  - WorkManager / Foreground Service                  |
  |  - Signs payload with Android Keystore Private Key   |
  |  - POST /v1/ingest/notifications                     |
  |  - Receives ACK, marks `SYNCED`                      |
  +------------------------------------------------------+
```

### Key Android Reliability Pillars:
- **Foreground Service:** Persistent notification with high priority ensures the Android Low Memory Killer (OOM) does not terminate the service.
- **Battery Optimization Exemption:** Guided user flow directs the merchant to disable aggressive OEM battery optimization (Samsung, Xiaomi, Transsion/Tecno/Infinix).
- **Keystore Signing:** Payloads are signed on-device; if an attacker intercepts the device token, they cannot forge payloads without the Keystore hardware key.

---

## 7. Business Automation Engine (MikroTik & WHMCS)

### 7.1. MikroTik RouterOS Adapter
- Supports both RouterOS v6 (legacy API port 8728/8729) and RouterOS v7 (modern REST API / SSH).
- Safe command execution:
  - PPPoE User Renewal:
    ```
    /ppp/secret/set [find name="user123"] profile="10Mbps_Plan" disabled=no
    /ppp/active/remove [find name="user123"]
    ```
  - Hotspot Voucher Generation:
    ```
    /ip/hotspot/user/add name="pin4821" profile="1Day_Unlimited" limit-uptime=24h
    ```
- All operations are verified by reading back state before marking the job `FULFILLED`.

### 7.2. WHMCS Adapter
- Communicates with WHMCS API using API Authentication (`identifier` + `secret`).
- Executes `addInvoicePayment`:
  ```json
  {
    "action": "AddInvoicePayment",
    "invoiceid": 10452,
    "transid": "QA12BC34DE",
    "gateway": "mpesa",
    "amount": "50000.00",
    "fees": "0.00",
    "date": "2026-11-05 14:32:00"
  }
  ```
- Ensures idempotency: Queries `getTransactions` with `transid` before applying payment to prevent duplicate credit in WHMCS.

---

## 8. Deployment Architecture & Cost Efficiency

BriskSMS is engineered for minimal infrastructure overhead during early commercial operation while scaling horizontally as volume expands:

```
                                [Cloudflare Edge]
                       (DNS, SSL, DDoS, CDN, Edge WAF)
                                      |
                      +---------------+---------------+
                      |                               |
                      v                               v
             [api.brisksms.co.tz]             [app.brisksms.co.tz]
             (Backend API Service)            (Angular SPA on Cloudflare Pages)
                      |
                      v
             [Application Server]
             (Dedicated VPS / Hetzner or AWS EC2)
             - Docker Compose / Kamal Deployment
             - Container 1: `api` (NestJS REST API)
             - Container 2: `worker` (Queue processor)
             - Container 3: `redis` (BullMQ broker & cache)
                      |
                      v
             [Managed PostgreSQL Database]
             (Primary DB with automated daily snapshots & PITR)
```

### Production Environment Isolation:
- `production`: High availability, automated WAL archiving, strict error logging.
- `staging`: Mirrors production configuration; used for CI validation and integration testing.
- `development`: Local Docker containers (`docker-compose.yml`) for instant offline development.
