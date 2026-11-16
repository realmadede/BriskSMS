# Deliverable D: Technical Architecture & System Design

**Document Version:** 2.0.0  
**Last Synced:** 2026-11-16  
**Status:** Synced Architectural Blueprint (Reflects Verified Current Monorepo)  
**System Type:** Commercial SaaS Multi-Tenant Platform  
**Target Environment:** Linux / Docker / Cloudflare / PostgreSQL 16+ / Redis 7+ / Android  

---

## 1. High-Level System Architecture

BriskSMS is engineered as an **event-driven TypeScript modular monolith** running on Bun/Node.js alongside a background worker runtime and a Kotlin/Jetpack Compose Android companion.

The architecture decouples high-throughput payment evidence ingestion and HTTP/messaging dispatch from background webhook delivery, retry sweeps, and maintenance housekeeping via PostgreSQL ACID transactions, an append-only transactional outbox, and Redis-backed queues.

```
+---------------------------------------------------------------------------------------------------+
|                                            CLIENT LAYER                                           |
+---------------------------------------------------------------------------------------------------+
|  [Android Companion App]    [Web Management Portal]       [External Merchant Integrations]        |
|  - Kotlin 1.9.23 + Compose  - apps/web (Glisse HTML/JS)   - Signed HMAC Webhooks / Zapier App     |
|  - Room DB + AES-256-GCM    - server.ts Static Host       - External MikroTik / WHMCS / ERP       |
|  - Keystore EC P-256 PoP    - Future Angular SPA Planned                                          |
+---------------------------------------------------------------------------------------------------+
                                                  | TLS 1.3 (Reverse Proxy / Cloudflare)
                                                  v
+---------------------------------------------------------------------------------------------------+
|                                    BACKEND MODULAR MONOLITH                                       |
|                              (Custom TypeScript HTTP Router - apps/api)                           |
+---------------------------------------------------------------------------------------------------+
|  +---------------------+   +---------------------+   +---------------------+                      |
|  |     auth module     |   | organization module |   |    device module    |                      |
|  | - Scrypt / HS256 JWT|   | - Multi-tenancy     |   | - 5m QR Pairing     |                      |
|  | - 30d Refresh Fam.  |   | - RBAC & Quotas     |   | - EC P-256 PoP      |                      |
|  | - Google/Resend SSO |   | - OWNER Protection  |   | - Durable Commands  |                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  |  ingestion module   |   |reconciliation module|   |   stk-push module   |                      |
|  | - /v1/ingestion/... |   | - Invoicing Engine  |   | - Fail-Closed MNO   |                      |
|  | - Raw Evidence Log  |   | - Global Claim Lock |   | - Callback Verifier |                      |
|  | - Parser Delegation |   | - REVIEW_REQUIRED   |   | - MNP Routing Spec  |                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
|  |  messaging module   |   | subscription module |   | developer / oauth   |                      |
|  | - SMSGate + Outbound|   | - Dynamic Catalog   |   | - bsk_live_ API Keys|                      |
|  |   Android Jobs      |   | - Paid Ref Gate     |   | - AES-GCM Webhooks  |                      |
|  | - Credit Ledger     |   | - Platform Admin    |   | - RFC 7636 PKCE S256|                      |
|  +---------------------+   +---------------------+   +---------------------+                      |
+---------------------------------------------------------------------------------------------------+
           |                                                      ^
           | (Transactional Outbox + Redis Enqueue)               | (ACID Row Locks / FOR UPDATE)
           v                                                      |
+------------------------------------+             +------------------------------------+
|       ASYNC QUEUE BROKER           |             |       PERSISTENCE LAYER            |
|   (Redis 7+ Custom RESP Client)    |             |   (PostgreSQL 16+ via Bun.SQL)     |
+------------------------------------+             +------------------------------------+
| Queues (`QUEUE_NAMES`):            |             | Schema (`53` Models / `15` Migs):  |
| - `webhook-delivery`               |             | - `organizations`, `users`         |
| - `payment-processing`             |             | - `devices`, `device_commands`     |
| - `sms-campaign`                   |             | - `raw_payment_evidence` (Append)  |
| - `sms-delivery-retry`             |             | - `payment_reference_claims`       |
| - `maintenance-cleanup`            |             | - `normalized_payments`, `invoices`|
+------------------------------------+             | - `outbound_sms_jobs`, `outbox_...`|
           |                                       +------------------------------------+
           v
+------------------------------------+
|     BACKGROUND WORKER RUNTIME      |
|   (apps/worker/src/workers.ts)     |
+------------------------------------+
| - OutboxDispatcher (SKIP LOCKED)   |
| - DispatchRecoveryRunner (SMSGate) |
| - OutboundSmsJob Lease Sweeper     |
| - MaintenanceRunner (Token Purge)  |
| - Queue Processors + Worker Health |
+------------------------------------+
```

---

## 2. Monorepo Structure

The monorepo is managed by **Bun `1.4.2`** (`bun.lock`, workspaces across `apps/*` and `packages/*`). Dependency direction is strict: `apps` may import from `packages`, while `packages` never import from `apps`.

```
BriskSMS/
├── package.json                         # Root scripts (typecheck, build, test, db:*, worker:start)
├── bun.lock                             # Authoritative Bun dependency lockfile
├── docker-compose.yml                   # Local development environment (Postgres 16, Redis 7)
├── AGENTS.md                            # Engineering governance and invariants
├── README.md                            # Project overview & quickstart
│
├── apps/
│   ├── api/                             # Backend REST API (Custom TypeScript HTTP Router)
│   │   ├── src/
│   │   │   ├── main.ts                  # Boot validation (`validateProductionEncryptionConfig`) & HTTP server
│   │   │   ├── app.ts                   # Health probes (/v1/health*) & route module registration
│   │   │   ├── core/                    # Router, cookies/CSRF, crypto, auth/device guards, store
│   │   │   └── modules/                 # auth, developer, device, ingestion, messaging, oauth,
│   │   │                                # organization, reconciliation, stk-push, subscription
│   │   └── test/                        # Live PostgreSQL + Redis API integration test suites
│   │
│   ├── worker/                          # Standalone worker runtime & outbox/recovery runners
│   │   ├── src/
│   │   │   ├── index.ts                 # Public worker handler exports
│   │   │   ├── main.ts                  # `BriskWorkerRuntime` CLI entrypoint
│   │   │   └── workers.ts               # Queue workers, outbox poller, recovery & maintenance
│   │   └── test/                        # Worker security & concurrency integration tests
│   │
│   ├── web/                             # Merchant Web Console, Developer Docs & Landing Portal
│   │   ├── server.ts                    # Hardened static HTTP server (path traversal & header guards)
│   │   ├── src/
│   │   │   ├── index.html               # Editorial Stitch/Glisse marketing landing page (#privacy/#terms)
│   │   │   ├── console.html             # Live Merchant Console connected to /v1/* endpoints
│   │   │   └── developers.html          # REST API & Webhook developer portal
│   │   └── test/                        # Web server security & portal integrity tests
│   │
│   └── android/                         # Mobile Companion & SMSGate Relay (Kotlin 1.9.23 + Compose)
│       ├── app/src/main/java/tz/co/brisksms/
│       │   ├── core/                    # BriskApiClient (OkHttp/Gson), KeystoreSecureStorage
│       │   ├── data/local/              # Room SQLite DB (`BriskDatabase`, `EvidenceDao`, entities)
│       │   ├── security/                # KeystoreManager (EC P-256), DevicePairingCoordinator/Protocol
│       │   ├── service/                 # BriskNotificationListenerService (Mode 1 Play-compliant)
│       │   ├── payment/                 # ProviderNotificationParser, EvidenceEncryptor, provider whitelist
│       │   ├── messaging/               # SmsDispatcher, SimManager, SmsGateRelayService, OutboundSmsJobCoordinator
│       │   ├── ui/                      # Jetpack Compose screens + Glisse theme tokens
│       │   └── worker/                  # WorkManager upload/telemetry workers, DeviceCommandProcessor, BootCompletedReceiver
│       └── app/src/test/                # 11 JVM unit test suites (52 @Test methods)
│
└── packages/
    ├── shared/                          # DTOs, enums (UserRole, TransactionState, ApiKeyScope),
    │                                    # domain errors, BigInt currency, E.164 TZ phone, AES-GCM & SSRF utils
    ├── parser-engine/                   # Payment parser adapters (M-Pesa, Mixx, Airtel, HaloPesa, CRDB)
    ├── db/                              # Prisma schema (53 models), 15 SQL migrations, Bun.SQL client,
    │                                    # migrate/seed CLI, structured redacting logger, RESP Redis client & queues
    ├── ui/                              # Glisse Liquid Glass optical refraction & CSS token system
    ├── zapier-app/                      # Official Zapier Platform integration (@brisksms/zapier-app)
    └── config/                          # Shared TypeScript & formatting presets
```

---

## 3. Backend Module Boundaries (`apps/api/src/modules/`)

The API monolith avoids circular coupling by organizing route controllers (`*.controller.ts`) and transactional services (`*.service.ts`) behind shared core infrastructure (`apps/api/src/core/`):

1. **`auth`**: User registration, scrypt email/password login, HMAC-SHA256 `15m` JWT access tokens, opaque SHA-256 hashed **30-day** rotating refresh token families (`refresh_tokens.family_id`), distributed `revoked_sessions` lookup, Double-Submit CSRF + Origin/Fetch Metadata checks, Google OpenID Connect RS256 + `bsk_g_nonce` validation, and Resend email verification (`bsk_ev_...`). *(Schema holds `two_factor_secret`; TOTP login challenge enforcement is planned.)*
2. **`organization`**: Multi-tenant organization CRUD, member invitations (unset `passwordHash` until activation), and RBAC enforcement (`UserRole`: `OWNER`, `ADMIN`, `FINANCE`, `CASHIER`, `DEVELOPER`) with `OWNER` demotion protection.
3. **`device`**: 5-minute single-use QR pairing (`pairing_tokens`, `bsk_pair_...`), two-step EC P-256 Proof-of-Possession enrollment (`device_pairing_challenges` + `BRISKSMS-DEVICE-PAIRING-POP-V1`), unique SPKI `public_key_fingerprint` enforcement, silent key-replacement prevention (`DEVICE_KEY_REPLACEMENT_FORBIDDEN`), heartbeat telemetry, durable fleet commands (`device_commands` via `FOR UPDATE SKIP LOCKED`, bounded leases, idempotency keys, and device ACKs), and revocation (`bsk_dev_...` invalidated with `403 DEVICE_REVOKED`).
4. **`ingestion`**: Raw notification ingestion (`POST /v1/ingestion/evidence`), append-only `raw_payment_evidence` persistence, parser delegation, SHA-256 `deduplication_hash`, canonical `(provider, provider_reference)` normalization, and global `PROVISIONAL` (`CLIENT_REPORTED`) claim acquisition via `PaymentReferenceClaimService`. Correlates same-tenant supplementary evidence cleanly and never auto-settles invoices from `ANDROID_NOTIFICATION_RELAY`.
5. **`reconciliation` & `stk-push`**: Invoice CRUD, deterministic matching, partial/overpayment `REVIEW_REQUIRED` routing, `PaymentReferenceClaimService` global claim coordinator, manual verification (`MANUAL_FINANCE_APPROVAL` / `BANK_STATEMENT_RECONCILIATION` / `INDEPENDENT_PROVIDER_QUERY` / `MANUAL_REJECTION` with separation-of-duties enforcement), explicit `provider` override on `POST /v1/payments/stk-push` (`routingResolution: 'EXPLICIT' | 'PREFIX_HEURISTIC'`), fail-closed `StkAdapterRegistry`, and fail-closed `CallbackVerifierRegistry` (`DisabledProviderCallbackVerifier`). See [`CARRIER_STK_INTEGRATION_READINESS.md`](./CARRIER_STK_INTEGRATION_READINESS.md).
6. **`subscription`**: Dynamic catalog (`CommercialProduct`, `SubscriptionPlan`, `PlanVersion`, `PlanPrice`, `PlanEntitlement`), fail-closed paid checkout requiring matching verified `stk_push_transactions` or `normalized_payments` (`402 PAYMENT_VERIFICATION_REQUIRED`), period/trial-bounded `EntitlementService`, and `PLATFORM_ADMIN_SECRET`-gated catalog administration (`/v1/admin/catalog/*`).
7. **`messaging`**: Product B engine integrating strictly via SMSGate (`MANAGED_GATEWAY` / `EXTERNAL_RELAY`) and durable Android companion jobs (`outbound_sms_jobs` via `/v1/messaging/device-jobs/*`). Enforces AES-256-GCM gateway credentials (`messaging_accounts`), dual-key 24h SMSGate inbound webhook rotation (`POST /v1/messaging/webhooks/smsgate`), durable `message_idempotency_records` with `HTTP 429 -> UNCERTAIN` protection, TCRA curfew (`20:00–07:00 EAT` default), E.164 TZ normalization, and append-only `messaging_credit_ledger` accounting.
8. **`developer` & `oauth`**: Scoped developer API keys (`bsk_live_...`), AES-256-GCM encrypted webhook endpoint HMAC secrets (`20261116010000_encrypt_webhook_endpoint_secrets`), transactional `outbox_events`, SSRF-safe webhook delivery, and RFC 7636 OAuth 2.0 authorization (`/v1/oauth/clients`, `/v1/oauth/authorize`, `/v1/oauth/token`, `/v1/oauth/revoke`) requiring `S256` PKCE, confidential client secret checks, and `bsk_at_` Bearer authentication (`authenticate()`).

---

## 4. Database Architecture (PostgreSQL 16+ & Schema Invariants)

The canonical schema in [`packages/db/prisma/schema.prisma`](../../packages/db/prisma/schema.prisma) defines **53 relational models** across **15 sequential SQL migrations** (`20261107000000` through `20261116010000`), executed by `packages/db/src/migrate.ts` over `Bun.SQL`.

### Key Relational Domains:
- **Identity & Tenancy:** `organizations`, `users`, `email_verification_tokens`, `users_organizations`, `organization_invitations`, `refresh_tokens`, `revoked_sessions`.
- **Android Companion & Fleet Control:** `devices`, `pairing_tokens`, `device_pairing_challenges`, `device_telemetry`, `device_commands`.
- **Product A Payment Intelligence & Claims:** `raw_payment_evidence` (append-only), `normalized_payments`, `payment_verifications`, `customers`, `invoices`, `invoice_items`, `invoice_payments`, `stk_push_transactions`, `payment_reference_claims`, `payment_reference_claim_events`, `payment_reference_claim_collisions`, `automation_rules`, `automation_logs`.
- **Product A Subscriptions & Catalog:** `commercial_products`, `subscription_plans`, `plan_versions`, `plan_prices`, `feature_definitions`, `plan_entitlements`, `organization_subscriptions`, `subscription_history`, `subscription_billing_invoices`.
- **Product B Cellular Messaging:** `messaging_accounts`, `messaging_credit_ledger`, `sender_ids`, `sms_campaigns`, `sms_campaign_recipients`, `sms_messages`, `sms_delivery_attempts`, `message_idempotency_records`, `outbound_sms_jobs`, `smsgate_signing_keys`, `smsgate_webhook_events`.
- **Developer Platform, Outbox & Audit:** `api_keys`, `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens`, `webhook_endpoints`, `webhook_deliveries`, `outbox_events`, `audit_logs`.

### Core Schema Invariants:
1. **Strict Tenant Keying & `ON DELETE RESTRICT`:** All tenant resources carry `organization_id` and prevent cascading financial history loss.
2. **PostgreSQL Append-Only Triggers:** Database triggers (`prevent_immutable_record_mutation`, `trg_claim_events_immutable`, and `prevent_billing_invoice_snapshot_mutation`) block `UPDATE` and `DELETE` on `raw_payment_evidence`, `payment_verifications`, `messaging_credit_ledger`, `subscription_history`, `audit_logs`, `payment_reference_claim_events`, and historical `subscription_billing_invoices` price snapshots.
3. **Unified Global Payment Reference Claims & Lock Hierarchy (P0.2):** Ingestion, manual verification, and STK callbacks acquire locks strictly in ascending order: `Level 1` advisory lock (`pg_advisory_xact_lock`) $\rightarrow$ `Level 2` `payment_reference_claims` $\rightarrow$ `Level 3` `stk_push_transactions` $\rightarrow$ `Level 4` `normalized_payments` $\rightarrow$ `Level 5` `invoices` $\rightarrow$ `Level 6` `payment_reference_claim_collisions`.

---

## 5. Asynchronous Queue & Worker Architecture (`apps/worker`)

Implemented in `packages/db/src/queue.ts` and `apps/worker/src/workers.ts` over Redis 7+ (`QUEUE_NAMES`):

| Queue Name (`QUEUE_NAMES`) | Producer | Worker Handler / Role | Reliability Controls |
|---|---|---|---|
| `webhook-delivery` | `OutboxDispatcher` (`outbox_events` poller) | `processWebhookDeliveryJob` | Decrypts AES-256-GCM `webhook_endpoints.secret`, re-validates SSRF via `validateOutboundHttpUrl` + `redirect: 'error'`, signs `X-BriskSMS-Signature` |
| `payment-processing` | API Ingestion / Outbox | `processPaymentJob` | Tenant-scoped payload validation (`assertTenantContext`) |
| `sms-campaign` | Campaign API / Outbox | `processSmsCampaignJob` | Dispatches via SMSGate with decrypted gateway auth & releases credits on definitive failure |
| `sms-delivery-retry` | SMS Retry Scheduler | `processSmsDeliveryRetryJob` | `SELECT ... FOR UPDATE` serialized terminal failure refunding |
| `maintenance-cleanup` | `MaintenanceRunner` (1h interval) | `runMaintenanceCleanup` | Purges expired `pairing_tokens`, expired `revoked_sessions`, and aged `email_verification_tokens` |

Additionally, `BriskWorkerRuntime` schedules `DispatchRecoveryRunner` to recover stale `PENDING` dispatches, timeout expired `DISPATCHING` leases safely to `UNCERTAIN`, and sweep expired `outbound_sms_jobs` leases (`expireDispatchLeases`).

---

## 6. Android Relay Architecture (`apps/android`)

Play-Store compliant **Mode 1** relay architecture (no `READ_SMS`/`RECEIVE_SMS` permissions in manifest):

```
[Android Notification Shade: Official M-Pesa / Mixx / Airtel / HaloPesa / CRDB / NMB Apps & SMS]
                     |
                     v  (BriskNotificationListenerService + PaymentProviderRegistry whitelist)
[ProviderNotificationParser & EvidenceEncryptor]
  - Discards non-financial personal notifications immediately
  - Encrypts raw payload with Keystore AES-256-GCM (`bsk_enc_v1:...`)
                     |
                     v
[Room SQLite Offline Queue (BriskDatabase / OfflineEvidenceEntity)]
                     |
                     v  (WorkManager: EvidenceUploadWorker + TelemetryWorker)
[BriskApiClient (OkHttp + Gson)]
  - Authenticated via `bsk_dev_...` after EC P-256 Proof-of-Possession pairing
  - Uploads to `POST /v1/ingestion/evidence` (observation only, never settlement)
  - Polls `POST /v1/devices/:id/telemetry` for durable `device_commands`
  - Executes Mode B SMS via `OutboundSmsJobCoordinator` (`/acquire` -> `/dispatching` -> `SmsManager` -> `/result`)
```

---

## 7. External Automation Boundary (MikroTik & WHMCS)

Downstream business automations (MikroTik RouterOS PPPoE/Hotspot activation, WHMCS invoice updates, custom ERPs) integrate externally via:
- Signed outbound webhooks (`payment.matched`, `payment.verified`, `invoice.paid`, `fulfillment.eligible`) dispatched by `OutboxDispatcher` and `processWebhookDeliveryJob` with `X-BriskSMS-Signature`, and
- The official `@brisksms/zapier-app` OAuth 2.0 PKCE triggers and actions.

Direct native RouterOS SSH/API and WHMCS PHP worker adapters inside `apps/worker` are deferred backlog items.

---

## 8. Deployment Topology & Redis Transport Boundary

```
                                [Cloudflare / TLS 1.3 Reverse Proxy]
                      (Sanitizes X-Forwarded-For, injects CSP & HSTS)
                                      |
                      +---------------+---------------+
                      |                               |
                      v                               v
             [api.brisksms.com]             [console.brisksms.com]
             (apps/api :3000)                 (apps/web :4200)
                      |
                      +---------------+---------------+
                                      |
                      v                               v
             [apps/worker]                 [Redis 7+ (Private VPC)]
                                           (No internal TLS in RESP client)
                                      |
                                      v
                        [Managed PostgreSQL 16+ (SSL/PITR)]
```
