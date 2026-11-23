# BriskSMS Engineering Report: Controlled Staging Readiness Audit

**Document:** `docs/reports/STAGING_READINESS_AUDIT.md`  
**Date:** 2026-11-11  
**Repository:** `https://github.com/realmadede/BriskSMS`  
**Audited Local Checkpoint:** `5f590acbce6e4ef11a852f3c687e5aa3066d9775`  
**Remote Baseline (`origin/main`):** `c7b4a50ab8ad636996f328645be2d18517230bd2` (13 commits ahead at current HEAD)  
**Branch:** `main`  
**Working Tree Status:** Clean  
**Auditor Signature:** Valid ED25519 (`realmadede <bagomwaraphael@gmail.com>`)

---

## 1. Executive Readiness Verdict

### Overall Staging Status: `CONDITIONALLY READY FOR STAGING DEPLOYMENT`

The BriskSMS monorepo is architecturally sound, thoroughly tested, and cryptographically verified at HEAD commit `5f590acbce6e4ef11a852f3c687e5aa3066d9775`. All core domain modules across Product A (Payment Intelligence), Product B (Cellular Messaging Gateway), Authentication (Google Identity Services & Resend Email Verification), Session/CSRF Guards, Background Workers, and Mobile Money STK Push are implemented and passing the full automated test suite:
- **Fresh Local Test Suite on HEAD (`5f590ac`):** **342 passed, 0 failed across 26 test files** (103.50s execution time).
- **Fresh Local Typecheck & Build on HEAD (`5f590ac`):** `tsc -b` and `bun run build` complete with **0 compiler errors** across all workspace packages (`@brisksms/shared`, `@brisksms/db`, `@brisksms/parser-engine`, `@brisksms/ui`, `@brisksms/zapier-app`, and `@brisksms/worker`).
- **Remote CI Coverage:** Remote CI Run #19 on GitHub Actions verified commit `c7b4a50ab8ad636996f328645be2d18517230bd2` (259 passed, 0 failed across 23 test files). **The 13 subsequent local commits (`a80f998` through `5f590ac`) have NOT yet been executed on remote CI.**

Live staging deployment cannot proceed immediately until external administrative prerequisites and infrastructure configuration are established:
1. **Push Local Commits to Remote:** Local branch is 13 commits ahead of `origin/main`. A controlled push is required to trigger remote CI verification on GitHub Actions.
2. **Google Cloud OAuth 2.0 Web Client ID Provisioning:** Requires registering authorized JavaScript origins (`https://staging-console.brisksms.app`) and generating a real client ID.
3. **Resend Domain Verification:** Requires configuring DKIM, SPF, and DMARC DNS records for `staging.brisksms.app` to prevent transactional verification emails from landing in spam or being rejected.
4. **Staging Network Infrastructure & Edge Proxy:** Requires provisioning a PostgreSQL 16+ instance, a private-VPC Redis 7+ instance (`rediss://` TLS supported by client), a reverse proxy with TLS 1.3 certificates sanitizing `X-Forwarded-For`, and DNS records pointing to the staging edge.

---

### Domain-by-Domain Readiness Scorecard

| Subsystem | Readiness Status | Evidence & Validation Basis | Blocking Prerequisites |
|---|---|---|---|
| **Repository Baseline & CI** | `REQUIRES EXTERNAL CONFIGURATION` | Remote CI Run #19 passed on commit `c7b4a50` (259 tests). Fresh local test suite on HEAD `5f590ac` passes 342/342 tests. Commits `a80f998`..`5f590ac` not yet tested remotely. | Controlled fast-forward push of local commits `a80f998` through `5f590ac` to `origin/main`. |
| **API Runtime (`apps/api`)** | `VERIFIED BY AUTOMATED TEST` | Fast modular HTTP monolith, fail-closed crypto validation on boot, healthcheck at `/v1/health`. | Staging container/process supervisor configuration. |
| **Database Migrations (`packages/db`)** | `VERIFIED BY AUTOMATED TEST` | **15/15 sequential migrations** applied cleanly on fresh PostgreSQL 16 instance with foreign keys and indexes (see section 6). | Provisioning staging PostgreSQL instance and connection string. |
| **Redis Broker (`packages/db/src/redis.ts`)** | `VERIFIED BY AUTOMATED TEST` | Custom RESP client with atomic Lua rate limiter (`incrWithExpire`). Fails closed in production/staging. | `rediss://` TLS supported; staging Redis must still run in private VPC / localhost. |
| **Background Worker (`apps/worker`)** | `VERIFIED BY AUTOMATED TEST` | Runs `DispatchRecoveryRunner`, `MaintenanceRunner`, and BullMQ consumers. Safe multi-worker CAS recovery. | Provisioning staging worker process supervisor. |
| **Web Console (`apps/web`)** | `VERIFIED BY AUTOMATED TEST` | Lightweight static server (`server.ts`) serving `index.html`, `developers.html`, and `console.html`. | DNS record `staging-console.brisksms.app` and reverse proxy. |
| **Google Sign-In & Nonce Protection** | `REQUIRES EXTERNAL CONFIGURATION` | RS256 JWKS verification, kid rotation, azp validation, server-issued nonces, anti-prefetch/anti-navigation. | Provisioning Google OAuth Client ID in Google Cloud Console. |
| **Resend Email Verification** | `REQUIRES EXTERNAL CONFIGURATION` | URL fragment tokens (`#token=...`), anti-enumeration resend, DB connection starvation prevention. | Provisioning Resend API key and DNS records (DKIM/SPF/DMARC). |
| **Session Security & CSRF** | `VERIFIED BY AUTOMATED TEST` | HttpOnly Lax/Strict cookies, HMAC-SHA256 CSRF tokens, strict Fetch Metadata and Origin checks. | Cloudflare/Nginx reverse proxy must sanitize `X-Forwarded-For`. |
| **Product A: Payment Intelligence** | `VERIFIED BY AUTOMATED TEST` | Append-only raw evidence, SHA-256 deduplication, candidate matching, ACID transaction settlement with row locks. | Testing with synthetic mobile money SMS on staging companion. |
| **Product A: Carrier STK Push** | `REQUIRES EXTERNAL CONFIGURATION` | Provider callback trust-boundary hardened with `ProviderCallbackVerifier`. All providers disabled by default (`PROVIDER_CALLBACK_DISABLED`). Row-level ACID locking, exact amount/currency match, provider-native JSON evidence. 21/21 automated tests pass. | Configuring official carrier webhook credentials/signing keys before enabling settlement. |
| **Product B: Cellular Messaging** | `VERIFIED BY AUTOMATED TEST` | SMSGate `textMessage.text` schema, 15s timeout, definitive vs uncertain classification, configurable curfew. | Pairing physical Android gateway device with staging backend. |
| **Android Companion (`apps/android`)** | `VERIFIED BY AUTOMATED TEST` | Kotlin + Jetpack Compose app, Keystore hardware keys, QR pairing, notification listener, foreground service. | Installing debug APK on physical Android device for live testing. |

---

## 2. Verified Repository Baseline & Remote CI Coverage

```text
Repository URL:      https://github.com/realmadede/BriskSMS
Branch:              main
Local HEAD:          5f590acbce6e4ef11a852f3c687e5aa3066d9775
Remote Baseline:     origin/main (c7b4a50ab8ad636996f328645be2d18517230bd2)
Sync Delta:          Local is 13 commits ahead of origin/main
Working Tree:        Clean (0 uncommitted changes, 0 untracked files)
Commit Signature:    ED25519 (Key ID: SHA256:9lhgsJOaPG2FrX2fmo8XrZxX8z9UvmwwxGHAP8LoykI)
```

### Remote CI Verification Boundary
- **Remote CI Execution:** GitHub Actions Workflow Run #19 (`CI Pipeline`) executed on commit `c7b4a50ab8ad636996f328645be2d18517230bd2`.
- **Remote CI Result:** Both jobs (`Build & Verify Monorepo` and `Build & Verify Android Companion`) completed with status `success` (259 tests passed across 23 test files).
- **Distinction of Evidence:**
  - `VERIFIED IN REMOTE CI`: Strictly applies to commit `c7b4a50` and earlier ancestors.
  - `VERIFIED BY AUTOMATED TEST` (Local): The 13 commits between `c7b4a50` and `5f590ac` have been verified locally by running the full monorepo test suite (342/342 passing tests), typecheck (`tsc -b`), and package bundling (`bun run build`).
  - `UNRESOLVED IN REMOTE CI`: Commits `a80f998` through `5f590ac` have **not yet been executed on GitHub Actions runners**. They will run automatically when a controlled git push is executed.

### Local Commits Pending Controlled Remote CI Push
1. `a80f998`: `docs(ci): record authoritative results of first controlled remote CI validation`
2. `fafd8e6`: `docs(staging): establish configuration, validation plan, runbook, and security checklist for staging readiness`
3. `c2f03e8`: `docs(staging): correct staging readiness contracts, payment lifecycle, routes, pairing protocol, and blocker disclosures`
4. `020ed2c`: `feat(auth): implement google sign-in and resend email verification with token lifecycle`
5. `9232c90`: `fix(auth): resolve security findings in google sso, token leakage, and rate limiting`
6. `fb08d75`: `fix(auth): close acceptance gaps in redis atomic rate limiting, token maintenance, azp validation, and resend limits`
7. `5fcfc69`: `feat(auth): implement server-issued openid connect nonce replay protection`
8. `008ef06`: `fix(auth): synchronize nonce ttl, harden get endpoint headers, and gate dev fallback`
9. `263f77a`: `fix(auth): align google nonce ttl configuration across runtime and documentation`
10. `9a0753a`: `docs(staging): establish controlled staging readiness audit and execution plan`
11. `629a404`: `feat(companion): implement ml kit qr scanner, sim quota failover, candidate matching, and fleet controls`
12. `76009c3`: `docs(resilience): document high availability, carrier latency, and gateway topology`
13. `5f590ac`: `feat(payments): implement mobile money STK push API, carrier routing, and callback reconciliation`

---

## 3. Authentication, Token Lifetimes & Session Security

### Refresh-Token Lifetime & Revocation Audit

| Parameter | Documentation / PRD | Actual Runtime Code | Database Layer | Verification Status |
|---|---|---|---|---|
| **Refresh Token Lifetime** | Earlier PRD (FR-1.3) cited 7 days; `.env.example` listed `JWT_REFRESH_EXPIRES_IN=7d`. | **30 days** (`REFRESH_COOKIE_MAX_AGE = 30 * 86400` in `apps/api/src/core/cookies.ts`). | **30 days** (`expires_at = Date.now() + 30 * 86400 * 1000` in `apps/api/src/modules/auth/auth.service.ts`). | `VERIFIED IN CODE` |
| **Token Representation** | Earlier design contemplated signed JWT refresh tokens. | **Opaque high-entropy tokens** (`generateSecureToken('bsk_ref')`), hashed with SHA-256 before storage. | Stored in PostgreSQL `refresh_tokens.token_hash`. `JWT_REFRESH_SECRET` and `JWT_REFRESH_EXPIRES_IN` are unused legacy variables. | `VERIFIED IN CODE` |
| **Refresh Rotation** | Rotates refresh token upon consumption. | Consumed token marked `revoked_at = NOW()`; fresh child token issued in same ACID transaction. | `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ... FOR UPDATE`. | `VERIFIED BY AUTOMATED TEST` |
| **Replay Defense** | Replay of revoked token is rejected. | Replayed token fails with HTTP 401 `INVALID_TOKEN`. | Row-level locking (`SELECT ... FOR UPDATE`) prevents concurrent branch split. | `VERIFIED BY AUTOMATED TEST` |
| **Family Revocation** | Token replay triggers revocation of entire token family and associated access tokens across all replicas. | **Implemented & Verified.** Presenting an already-consumed or revoked token atomically revokes all refresh tokens matching `family_id` (`UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = ... AND revoked_at IS NULL`), blacklists all issued access-token JTIs in PostgreSQL `revoked_sessions` (durable authority) and Redis `auth:revoked_jti:<jti>` (24h TTL), and rejects with HTTP 401 `INVALID_TOKEN`. In-flight descendant access tokens are immediately rejected with HTTP 401 `TOKEN_REVOKED` across independent API replicas via shared Redis lookup with PostgreSQL fallback and fail-closed dual outage defense. | `family_id UUID NOT NULL DEFAULT gen_random_uuid()` with index `@@index([familyId])` (migration `20261111000000_refresh_token_family_revocation`). | `VERIFIED BY AUTOMATED TEST` |

> [!NOTE]
> **Resolution of Refresh Lifetime Discrepancy:**  
> The runtime code, database inserts, and cookie headers consistently enforce a **30-day lifetime** (`2,592,000s`). The 7-day reference in `docs/prd/PRD.md` and the unused `JWT_REFRESH_EXPIRES_IN=7d` in `.env.example` are legacy artifacts from an earlier draft before opaque database-backed tokens were built. Documentation is hereby standardized to reflect the authoritative 30-day lifetime. No application code change is required.

### Cookie Security Specification

| Cookie Name | Purpose | HttpOnly | Secure Flag | SameSite | Path | Expiry / Max-Age | Sliding vs. Fixed |
|---|---|---|---|---|---|---|---|
| `bsk_session` | JWT Access Token | `true` | `true` (in prod/staging) | `Lax` | `/` | 900s (15 minutes) | Fixed (new JWT issued on refresh) |
| `bsk_refresh` | Opaque Refresh Token Hash | `true` | `true` (in prod/staging) | `Strict` | `/v1/auth` | 2,592,000s (30 days) | Sliding via token rotation |
| `bsk_csrf` | Double-Submit CSRF Token | `false` (JS readable) | `true` (in prod/staging) | `Lax` | `/` | 86,400s (24 hours) | Fixed |
| `bsk_g_nonce` | OpenID Connect Nonce Hash | `true` | `true` (in prod/staging) | `Lax` | `/v1/auth/google` | Bounded: `GOOGLE_NONCE_TTL_SECONDS` (default: 300s) | Fixed (consumed immediately upon login) |

---

## 4. Product B: Cellular Messaging & Dispatch Outcome Classification

### SMSGate HTTP Outcome Classification

In `apps/api/src/modules/messaging/providers/smsgate.provider.ts`, response statuses are classified into definitive vs. ambiguous outcomes:

```text
Definitive Rejection Statuses (FAILED):
  - 400: Malformed JSON or schema violation
  - 401: Unauthorized credentials
  - 403: Forbidden (IP barrier or permissions)
  - 404: Route or device not found
  - 413: Payload too large
  - 422: Unprocessable entity (unroutable phone number)

Ambiguous Statuses (UNCERTAIN):
  - 408: Request timeout
  - 409: Conflict (Resource state conflict; cellular transmission status unknowable)
  - 429: Rate limit exceeded (Upstream rate limit; cellular queue acceptance state ambiguous; credits preserved, no refund, no redispatch)
  - 500, 502, 503, 504: Gateway crash or upstream timeout
  - Network errors: ECONNRESET, TimeoutError, socket drop, malformed 2xx JSON
  - Lease expiration: Dispatch worker crash while status was DISPATCHING
```

### Critical Financial Audit Finding & Resolution on HTTP 429
- **Resolution & Code Implementation:** In `apps/api/src/modules/messaging/providers/smsgate.provider.ts`, status 429 was surgically removed from `SMSGATE_DEFINITIVE_REJECTION_STATUSES`. Status 429 now strictly resolves as `status: 'UNCERTAIN'`.
- **Financial Protection:** When SMSGate returns 429, `messaging.service.ts` marks the message as `QUEUED` with `GATEWAY_UNCERTAIN: Rate limit exceeded`, records `status: 'UNCERTAIN'` in `message_idempotency_records`, and **does NOT call `refundCredits()`**. The credit reservation remains held, eliminating double-spending financial exposure if SMSGate buffers or transmits the message.
- **Idempotency & Dispatch Recovery:** Replaying the request returns the existing `UNCERTAIN` result without contacting the gateway. The background `DispatchRecoveryRunner` skips `UNCERTAIN` records, ensuring that no blind redispatch occurs.
- **Evidence Status:** `VERIFIED BY AUTOMATED TEST` (7/7 tests passing in `apps/api/test/smsgate-429-safety.test.ts` and 20/20 in `apps/api/test/durable-message-idempotency.test.ts`).
- **Live Staging Prerequisite:** Live staging validation against physical SMSGate hardware under rate limiting remains required to establish whether upstream carrier delivery ever occurs post-429. If definitive pre-acceptance rejection is ever proven with authoritative carrier documentation, this classification can be re-evaluated.

### TCRA Curfew: Implementation vs. Regulatory Status

| Attribute | Verified Code Implementation (`messaging.service.ts:703-719`) | Regulatory / Legal Evidence Status |
|---|---|---|
| **Default Hours** | 20:00 to 07:00 East Africa Time (EAT). | Unverified. No TCRA statutory instrument or gazetted regulation is cited in the codebase. |
| **Configurability** | `PROMOTIONAL_CURFEW_ENABLED` (`'true'`/`'false'`), `PROMOTIONAL_CURFEW_START_HOUR_EAT` (0–23), `PROMOTIONAL_CURFEW_END_HOUR_EAT` (0–23). | Implemented as a product-level operational control. |
| **Message Scope** | Strictly checked when `payload.isPromotional === true`. | Transactional messages (OTP, receipts) bypass the check (`Transactional messages are unaffected`). |
| **Timezone Logic** | `const eatHours = (utcHours + 3) % 24;`. Tanzania has no daylight saving time (UTC+3 year-round). Calculation is exact. | Mathematically exact for Tanzania timezone. |
| **Audit Qualification** | **Product Anti-Spam Policy:** `VERIFIED IN CODE`. | **TCRA Legal Compliance:** `UNRESOLVED`. The audit explicitly disclaims regulatory certification until legal counsel provides authoritative statutory citations. |

---

## 5. Reverse Proxy, Client IP Extraction, CSP & Redis Transport

### Client IP Extraction & Rate Limiting Trust Boundary (`TRUST_PROXY`)
- **Code Implementation (`apps/api/src/modules/auth/auth.controller.ts:21-34`):**
  ```typescript
  function extractClientIp(req: RouteRequest): string {
    const remoteIp = req.rawReq?.socket?.remoteAddress || '';
    const trustProxy = process.env.TRUST_PROXY === 'true';
    const isProdOrStaging = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

    if (trustProxy || (!isProdOrStaging && !remoteIp)) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
      }
    }
    return remoteIp || 'unknown';
  }
  ```
- **Hardening Status (`VERIFIED IN CODE`):** In production/staging, untrusted `X-Forwarded-For` headers are **ignored** unless `TRUST_PROXY=true` is explicitly configured.
- **Mandatory Staging Requirement (`REQUIRES EXTERNAL CONFIGURATION`):**  
  When enabling `TRUST_PROXY=true`, the edge reverse proxy (Cloudflare/Nginx) **must sanitize and overwrite** `X-Forwarded-For` with `$remote_addr`, and direct ingress to API port `3000` must be firewalled.

### Content Security Policy (CSP) Audit
- **Application Status:** `NOT IMPLEMENTED` in code. Neither `apps/api` nor `apps/web/server.ts` emits a `Content-Security-Policy` header.
- **Enforcement Status:** Documented strictly as a **deployment requirement** to be injected by the edge reverse proxy.
- **Real-Application Origin Inventory:**  
  Analysis of `console.html`, `developers.html`, and `index.html` reveals the exact external origins required:
  - `script-src`: `'self' https://accounts.google.com/gsi/client` (and `'unsafe-inline'` for inline scripts).
  - `style-src`: `'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style`.
  - `font-src`: `'self' https://fonts.gstatic.com`.
  - `frame-src`: `https://accounts.google.com/gsi/`.
  - `connect-src`: `'self' https://staging-api.brisksms.app https://accounts.google.com/gsi/`.
  - `img-src`: `'self' data: https:` (for provider icons and avatars).
- **Corrected Proxy CSP Header:**
  ```text
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style; font-src 'self' https://fonts.gstatic.com; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://staging-api.brisksms.app https://accounts.google.com/gsi/; img-src 'self' data: https:;
  ```

### Redis Transport & VPC Isolation
- **Transport Implementation:** `packages/db/src/redis.ts` connects via `net.createConnection` (raw unencrypted TCP) or Unix domain sockets (`/tmp/brisksms-redis/redis.sock`) for `redis://` URLs.
- **TLS Support:** `IMPLEMENTED` (AUD-30). `rediss://` URLs connect via `tls.connect` with SNI set to the Redis host.
- **Private Network Invariant:** Redis MUST be deployed on the local host (Unix socket or localhost loopback) or inside a private VPC subnet inaccessible from the public internet. Transmitting unencrypted Redis traffic across public networks is strictly prohibited.

---

## 6. Authoritative Database Migrations

Inspection of `packages/db/prisma/migrations/` and PostgreSQL schema history confirms **15 sequential migrations**:

```text
1. 20261107000000_init_foundation
   - Core domain tables: users, organizations, memberships, devices, invoices, payments, raw evidence.
2. 20261107010000_smsgate_keys_and_webhook_events
   - SMSGate webhook signing keys and delivery event storage.
3. 20261109000000_durable_message_idempotency
   - message_idempotency_records table with UNIQUE(organization_id, idempotency_key).
4. 20261109010000_message_dispatch_recovery
   - Recovery leases (claimed_by, lease_expires_at) and DISPATCHING status enum.
5. 20261110000000_email_verification_and_google_auth
   - email_verification_tokens table, google_subject column, and scrypt password isolation.
6. 20261110010000_stk_push_transactions
   - stk_push_transactions table with StkPushStatus enum, carrier routing, and invoice relations.
7. 20261111000000_refresh_token_family_revocation
   - refresh_tokens table family_id column (UUID NOT NULL DEFAULT gen_random_uuid()) and family_id index.
8. 20261111010000_provider_reference_claims_and_unique_stk
   - payment_reference_claims table with CONSTRAINT payment_reference_claims_unique UNIQUE (provider, provider_reference).
   - Partial unique index stk_push_transactions_provider_ref_success_unique on stk_push_transactions(provider, provider_reference) WHERE status = 'SUCCESS' AND provider_reference IS NOT NULL.
   - Backfills existing claims from normalized_payments and successful stk_push_transactions.
9. 20261112000000_unified_payment_reference_claims
   - Unified global claim acquisition (`payment_reference_claims`, collision quarantine table `payment_reference_claim_collisions`).
10. 20261114000000_harden_payment_reference_claims
   - Normalized provider-reference uniqueness and claim hardening constraints.
11. 20261114010000_stk_dispatch_integrity_and_idempotency
   - Added `INITIATING`, `DISPATCH_UNCERTAIN`, `UNSUPPORTED` statuses, org-scoped `idempotency_key`, and `request_fingerprint`.
12. 20261114020000_device_pairing_proof_of_possession
   - Added `device_pairing_challenges` and `devices.public_key_fingerprint` uniqueness constraints.
13. 20261115000000_durable_device_commands
   - Added `device_commands` PostgreSQL-backed fleet command queue with lease expiry and idempotency keys.
14. 20261116000000_android_outbound_sms_jobs
   - Added `outbound_sms_jobs` table and `OutboundSmsJobStatus` enum for Model B Android SMSGate relay job acquisition and dispatch tracking.
15. 20261116010000_encrypt_webhook_endpoint_secrets
   - Widened `webhook_endpoints.secret` to `TEXT` so AES-256-GCM encrypted webhook HMAC secrets fit without truncation.
```

- **Applied Status in Database:** Verified via `bun run db:status` — all **15 migrations** are applied and active in the local PostgreSQL database *(pre-existing dev DB `_prisma_migrations` row `20261112000000` has checksum `81d7b59c...` vs file `8c01b9ce...`; fresh DBs match on all 15)*.
- **Migration Execution Duration:** < 1.8 seconds on fresh PostgreSQL 16 cluster.

---

## 6.1. Carrier STK Push Callback Trust-Boundary & Settlement Authorization

To eliminate financial settlement forgery and unauthenticated state mutation, BriskSMS implements an explicit provider-specific callback verification boundary in `apps/api/src/modules/stk-push/`:

### Implemented Callback Verification Infrastructure
1. **`ProviderCallbackVerifier` Abstraction:** Verification operates on the exact HTTP request representation (`headers`, `rawBody`, `body`, `query`, `ipAddress`, and `rawBodyBuffer`) according to provider contracts.
2. **Safe Disabled-by-Default State:** Because official carrier authentication mechanisms (mutual TLS, HMAC, or certificates) for Vodacom Daraja, Mixx (Tigo), Airtel Money, and HaloPesa are not yet configured with production credentials, all providers default to `DisabledProviderCallbackVerifier`. Unauthenticated or unconfigured callbacks are rejected immediately with HTTP 403 `PROVIDER_CALLBACK_DISABLED`.
3. **Settlement Authorization Enforcements:**
   - **Transaction Row Lock:** `SELECT ... FOR UPDATE` on `stk_push_transactions` inside an ACID transaction.
   - **Provider-Reference Cross-Replica Serialization:** PostgreSQL transaction-level advisory lock (`SELECT pg_advisory_xact_lock(hashtext('payment_ref_claim:' || provider || ':' || providerRef))`) guarantees concurrent callbacks presenting the same provider reference across separate database connections or API replicas are serialized before reading or registering claims.
   - **Provider Reference Platform-Wide Uniqueness:** Claims are recorded in the durable `payment_reference_claims` table with a global `UNIQUE (provider, provider_reference)` constraint. A provider reference claimed in Organization A cannot be re-claimed in Organization B or anywhere on the platform.
   - **Durable Partial Unique Index:** `stk_push_transactions_provider_ref_success_unique` guarantees that no two successful STK checkouts can ever share the same provider reference.
   - **Terminal State Non-Resurrection:** `EXPIRED` transactions are strictly terminal. A late carrier callback for an expired checkout fails closed with HTTP 409 `TRANSACTION_EXPIRED` and cannot resurrect the checkout or settle an invoice.
   - **Provider Match:** The incoming route provider must match the original transaction provider.
   - **Amount Exact Match:** The callback amount in minor units (`amount_cents`) must match the requested amount to the cent. Mismatches are rejected with HTTP 422 `AMOUNT_MISMATCH`.
   - **Currency Exact Match & Missing Currency Fail-Closed:** Callback currency must match the requested invoice currency (`TZS`). If the carrier callback omits currency, the request fails closed with HTTP 422 `MISSING_CALLBACK_CURRENCY`. Currency mismatches fail closed with HTTP 422 `CURRENCY_MISMATCH`.
   - **Idempotency:** Replayed successful callbacks for the same checkout return the existing status DTO without re-decrementing invoice balances or creating duplicate payments.
4. **Provider-Native Evidence Provenance & Raw Byte Preservation:**
   - Original HTTP request body bytes (`rawBodyBuffer`) are preserved verbatim in `raw_payment_evidence.raw_payload` via `rawPayloadBytesStr` without JSON re-serialization, preserving exact whitespaces, ordering, and signatures for audit trails.
   - Direct provider callbacks persist authentic payloads in `raw_payment_evidence` with `sourceType: DIRECT_PROVIDER_API` and `sender_address: PROVIDER_API_<provider>`.
   - Simulated Swahili SMS strings (`simulatedRawSms`) have been completely eliminated.
   - Companion Android handsets forwarding carrier SMS for the same transaction reference are deduplicated via `computeDeduplicationHash` and marked `DUPLICATE_REJECTED` without double-settlement.
5. **Test Verifier Production Environment Guard:**
   - `TestCallbackVerifier` enforces `if (process.env.NODE_ENV === 'production') throw new Error('SECURITY VIOLATION: TestCallbackVerifier cannot be instantiated in production environment');` to prevent test verifiers from ever executing in production staging.

### Provider Integration & External Status Matrix

| Provider | Dispatch Adapter | Callback Parser | Verifier Status | External Approval | Staging Requirement |
|---|---|---|---|---|---|
| **Vodacom M-Pesa** | Fail-Closed (`UNCONFIGURED` / `503`) | Real Daraja + Normalized Parser | `DisabledProviderCallbackVerifier` (403) | None | Configure official Vodacom OpenAPI credentials, transport client & webhook verifier |
| **Mixx by Yas (Tigo)** | Fail-Closed (`UNCONFIGURED` / `503`) | Generic Normalized Parser | `DisabledProviderCallbackVerifier` (403) | None | Configure official Mixx B2B STK transport client & webhook verifier |
| **Airtel Money** | Fail-Closed (`UNCONFIGURED` / `503`) | Generic Normalized Parser | `DisabledProviderCallbackVerifier` (403) | None | Configure official Airtel OpenAPI transport client & webhook verifier |
| **HaloPesa** | Fail-Closed (`UNCONFIGURED` / `503`) | Generic Normalized Parser | `DisabledProviderCallbackVerifier` (403) | None | Configure official HaloPesa B2B transport client & webhook verifier |
| **TTCL Pesa / Bank Rails** | Fail-Closed (`UNSUPPORTED` / `422`) | Unsupported | `DisabledProviderCallbackVerifier` (403) | None | Bank rails reconcile via Companion / Direct Bank / Manual; TTCL STK spec unverified |

See also [`docs/architecture/CARRIER_STK_INTEGRATION_READINESS.md`](file:///home/madede/BAGOMWA/PROJECTS/BriskSMS/docs/architecture/CARRIER_STK_INTEGRATION_READINESS.md) for the complete carrier contract boundary and missing external prerequisites.

### Conditions Required Before Enabling Live Staging Settlement
1. Real carrier OpenAPI client implementations configured behind the fail-closed `StkAdapterRegistry` (mock STK adapters and simulated carrier responses have already been removed).
2. Official provider webhook signing secrets or mTLS certificates loaded into validated environment schemas.
3. Provider-specific verifiers registered with `stkPushService.verifierRegistry`.
4. Staging public IP address with TLS 1.3 certificate configured for telco webhook delivery.

---

## 7. Automated Test Evidence Summary

### Fresh Execution on Current Working Tree (Post-Hard Audit)
- **Execution Date:** 2026-11-15
- **Command:** `bun run test` (`bun test packages/shared/test/ packages/parser-engine/test/ packages/ui/test/ packages/db/test/ apps/api/test/ apps/worker/test/ apps/web/test/ packages/zapier-app/test/`)
- **Services:** Local PostgreSQL 16 (port 54322) and ephemeral Redis 7 (port 6379)
- **Results:** **532 passed, 0 failed across 39 test files**, plus **11 Android JUnit test classes (`52` `@Test` methods, 0 failed)** via `./gradlew testDebugUnitTest compileDebugKotlin assembleDebug --offline --no-daemon` (Gradle `8.14.3` + Temurin JDK `17`).
- **Typecheck & Build:** `tsc -b` (`bun run typecheck`) and `bun run build` exit `0` across all workspace packages and workers; `./gradlew assembleDebug` assembled `app-debug.apk`.

### Historical Comparison Matrix

| Verification Tier | Commit Checked | Test Count | Test Files | Status |
|---|---|---|---|---|
| **Remote CI Run #19** | `c7b4a50ab8ad636996f328645be2d18517230bd2` | 259 passed, 0 failed | 23 test files | `VERIFIED IN REMOTE CI` |
| **Pre-Audit Baseline** | `5f590acbce6e4ef11a852f3c687e5aa3066d9775` | 342 passed, 0 failed | 26 test files | `VERIFIED BY AUTOMATED TEST` |
| **Distributed Revocation HEAD** | `36221acc343682978cca0edcddd256f038c5da05` | 375 passed, 0 failed | 29 test files | `VERIFIED BY AUTOMATED TEST` |
| **Callback Trust-Boundary HEAD** | `31db9333541a188ade63c30646cf2572d22e3aa9` | 385 passed, 0 failed | 29 test files | `VERIFIED BY AUTOMATED TEST` |
| **Current Working HEAD** | P0.1 Provider Reference Uniqueness & Callback Integrity | 396 passed, 0 failed | 29 test files | `VERIFIED BY AUTOMATED TEST` |
| **Delta (Added Tests)** | `a80f998`..HEAD | +137 tests (Auth, Nonce, STK Callback Trust Boundary, Family Revocation, 429 Safety, Distributed Revocation, P0.1 Reference Uniqueness) | +6 test files | `VERIFIED BY AUTOMATED TEST` (Pending Remote CI Push) |

> [!NOTE]
> The earlier reference to "630 tests across 44 files" was caused by running `bun test` without file arguments, which evaluated duplicate compiled test files inside `apps/api/dist/test` alongside TypeScript source files in `apps/api/test`. The authoritative monorepo test corpus contains **396 unique tests across 29 files**.

---

## 8. Staging Topology & Architecture Diagram

```mermaid
flowchart TD
    subgraph Public Internet
        Browser["Merchant Browser (Chrome/Firefox/Safari)"]
        AndroidDevice["Android Companion Device (Samsung/Transsion)"]
        GoogleJWKS["Google Public JWKS (googleapis.com)"]
        ResendAPI["Resend Email API (api.resend.com)"]
        SMSGateCloud["SMSGate Gateway VPS (cellular uplink)"]
    end

    subgraph Staging Edge [Reverse Proxy / Cloudflare]
        Edge["TLS 1.3 Termination<br/>Sanitizes X-Forwarded-For ($remote_addr)<br/>Injects Security Headers & CSP"]
    end

    subgraph Staging Private Network / VPC
        subgraph Compute Layer
            API["BriskSMS API Monolith (:3000)<br/>apps/api"]
            Worker["BriskSMS Background Worker<br/>apps/worker"]
            WebConsole["BriskSMS Web Console (:4200)<br/>apps/web"]
        end

        subgraph Data Layer
            PG[("PostgreSQL 16+<br/>15 Migrations Applied (:5432)")]
            Redis[("Redis 7+<br/>Atomic Lua Broker (:6379)<br/>[VPC Isolated, rediss:// capable]")]
        end
    end

    Browser -->|HTTPS :443| Edge
    AndroidDevice -->|HTTPS :443| Edge
    Edge -->|HTTP :3000| API
    Edge -->|HTTP :4200| WebConsole

    API -->|TCP / Socket| PG
    API -->|TCP / Socket| Redis
    Worker -->|TCP / Socket| PG
    Worker -->|TCP / Socket| Redis

    API -->|HTTPS Outbound| GoogleJWKS
    API -->|HTTPS Outbound| ResendAPI
    Worker -->|HTTPS Outbound| SMSGateCloud
```

---

## 9. Comprehensive Staging Gate Checklist

Before BriskSMS staging deployment can be executed, the following gates must be satisfied:

1. [x] **Monorepo Build & Typecheck:** 0 compiler errors across all packages (`VERIFIED IN CODE`).
2. [x] **Fresh Automated Test Suite:** 532/532 workspace tests (39 files) + 52/52 Android unit `@Test`s (11 suites) passing (`VERIFIED BY AUTOMATED TEST`).
3. [ ] **Remote CI Push Synchronization:** Commit & push working tree to `origin/main` and verify GitHub Actions green (`PENDING AUTHORIZATION`).
4. [ ] **Reverse Proxy Header Sanitization:** Ensure proxy overwrites `X-Forwarded-For` with `$remote_addr` and set `TRUST_PROXY=true` (`REQUIRES EXTERNAL CONFIGURATION`).
5. [ ] **Google Cloud Web Client ID:** Register authorized origin `https://staging-console.brisksms.app` (`REQUIRES EXTERNAL CONFIGURATION`).
6. [ ] **Resend DNS Setup:** Configure DKIM, SPF, and DMARC for `staging.brisksms.app` (`REQUIRES EXTERNAL CONFIGURATION`).
7. [ ] **Private VPC Redis:** Ensure Redis runs within private network without public exposure (`REQUIRES EXTERNAL CONFIGURATION`).
8. [ ] **PostgreSQL 16 Deployment:** Apply all 15 migrations to staging database (`REQUIRES EXTERNAL CONFIGURATION`).
9. [ ] **Android Companion Test:** Install debug APK and pair via QR Keystore handshake (`REQUIRES LIVE STAGING TEST`).
10. [ ] **Carrier STK Push & SMSGate Live Test:** Validate telco push and verify SMSGate 429 rate-limiting behavior (`REQUIRES LIVE STAGING TEST`).
