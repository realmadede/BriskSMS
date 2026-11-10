# BriskSMS Engineering Report: Controlled Staging Readiness Audit

**Document:** `docs/reports/STAGING_READINESS_AUDIT.md`  
**Date:** 2026-11-10  
**Repository:** `https://github.com/realmadede/BriskSMS`  
**Audited Local Checkpoint:** `263f77a6d41dd656c4f441b352208710d14be90b`  
**Remote Baseline (`origin/main`):** `c7b4a50ab8ad636996f328645be2d18517230bd2` (9 commits ahead at audited checkpoint `263f77a`)  
**Branch:** `main`  
**Working Tree Status:** Clean  
**Auditor Signature:** Valid ED25519 (`realmadede <bagomwaraphael@gmail.com>`)

---

## 1. Executive Readiness Verdict

### Overall Staging Status: `CONDITIONALLY READY FOR STAGING DEPLOYMENT`

The BriskSMS monorepo is architecturally sound, thoroughly tested, and cryptographically verified at checkpoint `263f77a6d41dd656c4f441b352208710d14be90b`. All core domain modules across Product A (Payment Intelligence), Product B (Cellular Messaging Gateway), Authentication (Google Identity Services & Resend Email Verification), Session/CSRF Guards, and Background Workers are fully implemented and passing all automated test suites (630/630 unit, integration, and E2E tests passing across 44 test files).

However, live staging deployment cannot proceed immediately because the platform requires **external administrative and infrastructure provisioning** that cannot be verified by local automated tests:
1. **Google Cloud OAuth 2.0 Client ID Provisioning:** Requires registering authorized JavaScript origins (`https://staging-console.brisksms.com`) and generating a real client ID.
2. **Resend Domain Verification:** Requires configuring DKIM, SPF, and DMARC DNS records for `staging.brisksms.com` to prevent transactional emails from landing in spam or being rejected by downstream mail relays.
3. **Staging Network Infrastructure:** Requires provisioning a PostgreSQL 16+ instance, an isolated Redis 7+ instance on a private VPC/network, a reverse proxy with TLS 1.3 certificates, and DNS records pointing to the staging cluster.

### Domain-by-Domain Readiness Scorecard

| Subsystem | Readiness Status | Evidence & Validation Basis | Blocking Prerequisites |
|---|---|---|---|
| **Repository Baseline & CI** | `VERIFIED IN REMOTE CI` | Remote CI run 19 passed on commit `c7b4a50`. Local monorepo builds and typechecks cleanly with zero errors. | Pushing local commits `85ce006` through `263f77a` to `origin/main`. |
| **API Runtime (`apps/api`)** | `VERIFIED BY AUTOMATED TEST` | Fast modular HTTP monolith, fail-closed crypto validation on boot, healthcheck at `/v1/health`. | Staging container/process supervisor configuration. |
| **Database Migrations (`packages/db`)** | `VERIFIED BY AUTOMATED TEST` | 5/5 sequential migrations applied cleanly on fresh PostgreSQL 16 instance with foreign keys and indexes. | Provisioning staging PostgreSQL instance and connection string. |
| **Redis Broker (`packages/db/src/redis.ts`)** | `VERIFIED BY AUTOMATED TEST` | Custom RESP client with atomic Lua rate limiter (`incrWithExpire`). Fails closed in production/staging. | **No in-transit TLS.** Staging Redis must run in private VPC / localhost. |
| **Background Worker (`apps/worker`)** | `VERIFIED BY AUTOMATED TEST` | Runs `DispatchRecoveryRunner`, `MaintenanceRunner`, and BullMQ consumers. Safe multi-worker CAS recovery. | Provisioning staging worker process supervisor. |
| **Web Console (`apps/web`)** | `VERIFIED BY AUTOMATED TEST` | Lightweight static server (`server.ts`) serving `index.html`, `developers.html`, and `console.html`. | DNS record `staging-console.brisksms.com` and reverse proxy. |
| **Google Sign-In & Nonce Protection** | `REQUIRES EXTERNAL CONFIGURATION` | RS256 JWKS verification, kid rotation, azp validation, server-issued nonces, anti-prefetch/anti-navigation. | Provisioning Google OAuth Client ID in Google Cloud Console. |
| **Resend Email Verification** | `REQUIRES EXTERNAL CONFIGURATION` | URL fragment tokens (`#token=...`), anti-enumeration resend, DB connection starvation prevention. | Provisioning Resend API key and DNS records (DKIM/SPF/DMARC). |
| **Session Security & CSRF** | `VERIFIED BY AUTOMATED TEST` | HttpOnly Lax/Strict cookies, HMAC-SHA256 CSRF tokens, strict Fetch Metadata and Origin checks. | Cloudflare/Nginx reverse proxy must sanitize `X-Forwarded-For`. |
| **Product A: Payment Intelligence** | `VERIFIED BY AUTOMATED TEST` | Append-only raw evidence, SHA-256 deduplication, candidate matching, ACID transaction settlement with row locks. | Testing with synthetic mobile money SMS on staging companion. |
| **Product B: Cellular Messaging** | `VERIFIED BY AUTOMATED TEST` | SMSGate `textMessage.text` schema, 15s timeout, definitive vs uncertain classification, TCRA curfew. | Pairing physical Android gateway device with staging backend. |
| **Android Companion (`apps/android`)** | `VERIFIED BY AUTOMATED TEST` | Kotlin + Jetpack Compose app, Keystore hardware keys, QR pairing, notification listener, foreground service. | Installing debug APK on physical Android device for live testing. |

---

## 2. Verified Repository Baseline

```text
Repository URL:      https://github.com/realmadede/BriskSMS
Branch:              main
Local HEAD:          263f77a6d41dd656c4f441b352208710d14be90b
Remote Tracking:     origin/main (c7b4a50ab8ad636996f328645be2d18517230bd2)
Sync Delta:          Local is 9 commits ahead of origin/main
Working Tree:        Clean (0 uncommitted changes, 0 untracked files)
Commit Signature:    ED25519 (Key ID: SHA256:9lhgsJOaPG2FrX2fmo8XrZxX8z9UvmwwxGHAP8LoykI)
```

### Local Commits Pending Controlled Push
1. `85ce006`: `docs: verify first remote ci execution and establish staging baseline`
2. `fafd8e6`: `docs(staging): establish staging readiness architecture and configuration`
3. `a9fe788`: `docs(staging): enforce payment lifecycle invariants and correct product boundaries`
4. `020ed2c`: `feat(auth): implement google sign-in and resend email verification`
5. `9232c90`: `fix(auth): resolve security findings in google sso, token leakage, and rate limiting`
6. `fb08d75`: `fix(auth): close acceptance gaps in redis atomic rate limiting, token maintenance, azp validation, and resend limits`
7. `5fcfc69`: `feat(auth): implement server-issued openid connect nonce replay protection`
8. `008ef06`: `fix(auth): synchronize nonce ttl, harden get endpoint headers, and gate dev fallback`
9. `263f77a`: `fix(auth): align google nonce ttl configuration across runtime and documentation`

---

## 3. Staging Infrastructure Topology

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
        Edge["TLS 1.3 Termination & Header Sanitization"]
    end

    subgraph Staging Private Network / VPC
        subgraph Compute Layer
            API["BriskSMS API Monolith (:3000)<br/>apps/api"]
            Worker["BriskSMS Background Worker<br/>apps/worker"]
            WebConsole["BriskSMS Web Console (:4200)<br/>apps/web"]
        end

        subgraph Data Layer
            PG[("PostgreSQL 16+<br/>ACID Database (:5432)")]
            Redis[("Redis 7+<br/>Atomic Lua Broker (:6379)<br/>[No TLS: VPC Isolated]")]
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

### Topology Component Classification

#### Required Infrastructure
1. **Reverse Proxy (Nginx / Caddy / Cloudflare):**
   - Terminates TLS 1.3 with valid certificates for `staging-api.brisksms.com` and `staging-console.brisksms.com`.
   - **Critical Security Duty:** Must strip and sanitize incoming client `X-Forwarded-For` headers, replacing them with the trusted upstream client IP (`$remote_addr`) to prevent rate-limit bypasses.
   - Injects security headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`).
2. **Compute Nodes (Node.js 24 / Bun 1.4.2):**
   - `apps/api`: Listens on port 3000. Serves all REST API, authentication, ingestion, and webhook routes.
   - `apps/worker`: Background process running `OutboxDispatcher`, `DispatchRecoveryRunner`, `MaintenanceRunner`, and BullMQ queues.
   - `apps/web`: Serves web console HTML, CSS, assets, and client JavaScript on port 4200.
3. **PostgreSQL 16+ Database:**
   - Durable ACID store with append-only evidence and ledger tables.
   - Connection pool size: 20–50 connections.
4. **Redis 7+ Cache & Queue Broker:**
   - In-memory store for BullMQ queues, ephemeral nonce hashes, and distributed rate limiting.
   - Persistence configured with RDB snapshots and AOF (append-only file).
5. **Physical Android Device:**
   - Android 10+ smartphone with active Tanzania SIM cards (Vodacom, Airtel, or Tigo).
   - Runs `apps/android` debug APK with notification listener permission enabled.

#### Optional Infrastructure
- **Redis Standalone vs Cluster:** Standalone Redis 7+ instance is sufficient for staging. Cluster mode is not required for staging traffic volumes.
- **API Multi-Replica:** Single API process is sufficient for staging validation. Multi-replica testing is optional for verifying concurrent lock contention.

#### Recommended Production Improvements
1. **Redis TLS Sidecar (Stunnel):** Because `packages/db/src/redis.ts` uses raw `net.Socket` without native TLS, production multi-datacenter deployments should use a local stunnel sidecar for transport encryption.
2. **Reverse Proxy Trusted CIDR Whitelist:** Middleware validation in `apps/api/src/core/http.ts` to reject `X-Forwarded-For` if the immediate TCP socket connection is not from an approved internal proxy IP.
3. **Application-Level Content Security Policy:** Injecting a formal `Content-Security-Policy` header directly in `http.ts` and `server.ts`.

#### Known Single Points of Failure (SPOFs) in Staging
1. **Unreplicated PostgreSQL:** A crash or disk corruption in the staging PostgreSQL instance halts all API and worker operations.
2. **Unreplicated Redis:** A crash in Redis causes API authentication and rate-limiting endpoints to fail closed with HTTP 503 `REDIS_UNAVAILABLE`.
3. **Physical Android Device Battery/Network Drop:** If the Android companion phone loses Wi-Fi, battery, or cellular connectivity, mobile money evidence ingestion stops until the device reconnects.

---

## 4. Complete Environment Variable & Secret Matrix

Static analysis of the BriskSMS codebase reveals **34 server-side environment variables** consumed by backend services and CLI tools, plus **2 documentation tokens**.

| Variable Name | Required in Staging? | Consuming Service(s) | Operational Purpose | Staging Value Source / Recommended Configuration | Validation & Fail-Closed Rules |
|---|---|---|---|---|---|
| `NODE_ENV` | **Required** | All Packages | Governs runtime environment, cookie security attributes, and security guards. | Set explicitly to `staging` (or `production`). | Setting `production` or `staging` activates fail-closed encryption checks, strict origin checks, and Redis rate-limiting enforcement. |
| `PORT` | Optional | `apps/api` | HTTP listening port for backend API monolith. | `3000` | Defaults to `3000` if omitted. Positive integer 1–65535. |
| `DATABASE_URL` | **Required** | `apps/api`, `apps/worker`, `packages/db` | Authoritative PostgreSQL connection string. | `postgresql://brisksms:[PASS]@staging-pg:5432/brisksms_staging?sslmode=prefer` | **Fatal startup error** if missing or unreachable. Redact password in logs. |
| `PGHOST` | Optional | `packages/db` | Host override or Unix socket path for PostgreSQL. | `staging-pg` or `/var/run/postgresql` | Falls back to host parsed from `DATABASE_URL`. |
| `PGUSER` | Optional | `packages/db` | PostgreSQL username override. | `brisksms` | Falls back to user in `DATABASE_URL`. |
| `PGPASSWORD` | Optional | `packages/db` | PostgreSQL password override. | `[REDACTED_SECRET]` | Falls back to password in `DATABASE_URL`. |
| `FORCE_TCP_POSTGRES` | Optional | `packages/db` | Forces TCP network connection, bypassing local socket resolution. | `true` (in Docker / Kubernetes) | Boolean string: `'true'` or `'false'`. |
| `ALLOW_PRODUCTION_DB_RESET` | **PROHIBITED** | `packages/db` | Safety guard preventing destructive schema drop / database reset. | **Must be omitted or `'false'`** | **Fatal security violation** if `'true'` when `NODE_ENV=production`. |
| `REDIS_URL` | **Required** | `apps/api`, `apps/worker`, `packages/db` | Redis connection URI for queues, rate limiting, and nonces. | `redis://:staging_redis_secret@staging-redis:6379/0` | **Fails closed** with HTTP 503 `REDIS_UNAVAILABLE` in staging/production if unreachable. |
| `REDIS_SOCKET_PATH` | Optional | `packages/db` | Filesystem path to local Redis Unix domain socket. | `/tmp/brisksms-redis/redis.sock` (if co-located) | Falls back to TCP `REDIS_URL` if omitted. |
| `FORCE_TCP_REDIS` | Optional | `packages/db` | Forces TCP connection to Redis, skipping Unix domain socket probing. | `true` (in containerized environments) | Boolean string: `'true'` or `'false'`. |
| `ENCRYPTION_MASTER_KEY` | **Required** | `apps/api`, `apps/worker`, `packages/db` | 32-byte (64 hex char) AES-256-GCM key used to encrypt device tokens and gateway secrets at rest. | Generated: `openssl rand -hex 32` | **Fatal boot termination** if missing, < 32 chars, or matching known insecure default keys. |
| `JWT_ACCESS_SECRET` | **Required** | `apps/api` | HMAC-SHA256 signing secret for merchant JWT access tokens (15-min expiry). | Generated: `openssl rand -hex 32` | **Fatal error on boot** if missing or matching `ENCRYPTION_MASTER_KEY` / `CSRF_SECRET`. |
| `CSRF_SECRET` | **Required** | `apps/api` | HMAC-SHA256 signing secret for double-submit CSRF cookie tokens. | Generated: `openssl rand -hex 32` | **Fatal error on boot** if missing or matching `JWT_ACCESS_SECRET` / `ENCRYPTION_MASTER_KEY`. |
| `ALLOWED_ORIGINS` | **Required** | `apps/api` | Comma-separated list of authorized browser origins for CORS & CSRF. | `https://staging-console.brisksms.com` | In staging/prod, rejects requests from unlisted origins with 403 `CSRF_ORIGIN_MISMATCH`. Wildcard `*` prohibited. |
| `CORS_ORIGIN` | Optional | `apps/api` | Supplementary allowed origin for developer portals. | `https://staging-developers.brisksms.com` | Merged into `ALLOWED_ORIGINS` set. |
| `FRONTEND_URL` | **Required** | `apps/api` | Canonical base URL of web console for verification email links. | `https://staging-console.brisksms.com` | Merged into allowed origins. Used to generate `/verify-email#token=...` links. |
| `API_BASE_URL` | **Required** | `apps/api`, `apps/worker` | Public canonical base URL of the BriskSMS backend API. | `https://staging-api.brisksms.com` | Embedded in Android QR pairing payloads and webhook callbacks. |
| `ALLOW_PRIVATE_GATEWAY_NETWORKS` | **PROHIBITED** | `apps/api` | SSRF filter toggle. Controls loopback / private IP filtering. | **Must be omitted or `'false'`** | When `'false'`, strictly blocks loopback (127.0.0.1, ::1) and private subnets (10.x, 192.168.x). |
| `PROMOTIONAL_CURFEW_ENABLED` | Optional | `apps/api`, `apps/worker` | TCRA curfew toggle for commercial bulk SMS campaigns. | `true` | Defaults to `true`. When active, holds promotional SMS between 20:00 and 07:00 EAT. |
| `PROMOTIONAL_CURFEW_START_HOUR_EAT` | Optional | `apps/api`, `apps/worker` | Curfew start hour in East Africa Time (UTC+3). | `20` (8:00 PM) | Integer between 0 and 23. Defaults to 20. |
| `PROMOTIONAL_CURFEW_END_HOUR_EAT` | Optional | `apps/api`, `apps/worker` | Curfew end hour in East Africa Time (UTC+3). | `7` (7:00 AM) | Integer between 0 and 23. Defaults to 7. |
| `DISPATCH_PENDING_GRACE_SECONDS` | Optional | `apps/worker` | Grace period before unleased PENDING message is swept by recovery. | `60` | Positive integer in seconds. Defaults to 60. |
| `DISPATCH_RECOVERY_INTERVAL_MS` | Optional | `apps/worker` | Polling interval for `DispatchRecoveryRunner` stale sweep. | `30000` (30 seconds) | Positive integer in milliseconds. Defaults to 30000. |
| `MAINTENANCE_INTERVAL_MS` | Optional | `apps/worker` | Periodic execution interval for `MaintenanceRunner` token sweep. | `3600000` (1 hour) | Positive integer in milliseconds. Defaults to 3600000. |
| `MAINTENANCE_RETENTION_DAYS` | Optional | `apps/worker` | Retention window for expired/consumed verification tokens before purge. | `30` (30 days) | Positive integer in days. Defaults to 30. Active unexpired tokens are never purged. |
| `CLIENT_ID` | Optional | `packages/zapier-app` | OAuth 2.0 client ID for BriskSMS Zapier platform integration. | `brisksms_zapier_staging` | Defaults to `brisksms_zapier_client`. |
| `BRISKSMS_SILENT_LOGS` | Optional | `packages/db`, Tests | Suppresses error logging on stdout/stderr. | `false` | Must remain `false` in staging to ensure error observability. |
| `GOOGLE_CLIENT_ID` | **Required** | `apps/api` | Google Cloud OAuth 2.0 Web Application Client ID. | `[STAGING_ID].apps.googleusercontent.com` | When unset, Google ID token verification is rejected with 401 `INVALID_GOOGLE_TOKEN`. |
| `GOOGLE_CLIENT_SECRET` | Optional | Documentation | Client secret for Google OAuth authorization code grant. | Not required in staging | **Unused by backend ID token verification.** Documented as optional. |
| `GOOGLE_NONCE_TTL_SECONDS` | Optional | `apps/api` | Lifespan of server-issued Google OpenID Connect nonces before expiration. | `300` (5 minutes) | Positive integer between 30 and 900 seconds. Out-of-bounds/invalid values safely fall back to 300s. |
| `RESEND_API_KEY` | **Required** | `apps/api` | Bearer API token for transactional email delivery via Resend REST API. | `re_[STAGING_KEY]` | When unset, email verification dispatch logs warning and fails safely. Masked in error logs. |
| `RESEND_FROM_EMAIL` | Optional | `apps/api` | RFC 5322 sender address for transactional verification emails. | `BriskSMS Staging <verify@staging.brisksms.com>` | Defaults to `BriskSMS <verify@brisksms.com>`. Requires verified sender domain. |
| `EMAIL_VERIFICATION_EXPIRY_HOURS` | Optional | `apps/api` | Expiration window for email verification tokens. | `24` (24 hours) | Positive integer in hours. Defaults to 24. |
| `BRISKSMS_API_KEY` | Client Mock | Documentation | Code snippet placeholder in `developers.html`. | `bsk_live_demo12345` | Not consumed by backend services. |
| `BRISKSMS_DEVICE_TOKEN` | Client Mock | Documentation | Code snippet placeholder in companion SDK documentation. | `bsk_dev_demo67890` | Not consumed by backend services. |

---

## 5. Google Sign-In Staging Readiness

### Google Cloud Console Configuration Specification
To enable Google Sign-In on the staging web console, the following external configuration must be established in the Google Cloud Console:

1. **OAuth 2.0 Client Type:** **"Web application"**
2. **Authorized JavaScript Origins:**
   - `https://staging-console.brisksms.com`
   - `http://localhost:4200` (for local staging reproduction)
3. **Authorized Redirect URIs:**
   - BriskSMS uses Google Identity Services (GIS) One Tap / Pop-up rendering. The ID token (JWT) is returned directly to the in-page JavaScript callback function. **No server-side redirect URI is invoked.**
   - If the Google Cloud Console requires entering at least one redirect URI, enter `https://staging-console.brisksms.com`.
4. **Target Scopes:** `openid`, `email`, `profile`. (No sensitive or restricted Google API scopes required).
5. **Publishing Status:** Set to "Testing" with authorized staging test users added to the test user roster, or "In Production" (internal/public).

### Verification Architecture in Code
- **Algorithm Enforcement:** Strictly `RS256`. Tokens using `none`, `HS256`, or other asymmetric algorithms are rejected with 401.
- **Key Rotation Resiliency:** Fetches Google public keys from `https://www.googleapis.com/oauth2/v3/certs`. Cached for 1 hour. If an incoming token arrives with an unknown `kid`, the cache is automatically invalidated and re-fetched immediately to handle Google key rotation seamlessly.
- **Audience & Authorized Party Validation:** Validates that `aud` matches `GOOGLE_CLIENT_ID`. If `aud` is an array, enforces that `azp` is present and matches `GOOGLE_CLIENT_ID`.
- **Clock Skew Tolerance:** Enforces 300-second clock skew tolerance on `iat`, `nbf`, and `exp`.
- **Nonce Binding & Consumption:** `POST /v1/auth/google/nonce` issues a high-entropy 256-bit token (`bsk_gn_...`). The SHA-256 hash is bound to the browser attempt via an `HttpOnly`, `SameSite=Lax`, `Path=/v1/auth/google` cookie (`bsk_g_nonce`). When `/v1/auth/google` receives the credential, it compares `hash(token.nonce)` against `bsk_g_nonce` using constant-time `timingSafeEqual`, atomically deletes the nonce from Redis via `DEL`, and clears the cookie.

### 10-Step Real-Browser Staging Test Sequence

| Test ID | Test Scenario | Execution Action | Expected Result |
|---|---|---|---|
| **GIS-STG-01** | First-Time Google Sign-In | New merchant clicks "Sign in with Google", authenticates via Google pop-up. | Backend creates user record (`authProvider: 'GOOGLE'`), marks `isEmailVerified: true`, provisions default workspace, returns session cookies. |
| **GIS-STG-02** | Existing Account Sign-In | Previously registered Google merchant signs in again. | Issues new session and refresh cookies. Does not create duplicate user or duplicate organization. |
| **GIS-STG-03** | Safe Account Linking | User registered with email/password signs in with verified Google account sharing identical email. | Links `googleSubject` to existing user, preserves existing scrypt password hash, marks email verified, logs in. |
| **GIS-STG-04** | Account Hijack Conflict | Attempt to link existing account to a Google account with a different `sub` than previously linked. | Strictly rejected with HTTP 409 `GOOGLE_ACCOUNT_CONFLICT`. Existing account credentials untouched. |
| **GIS-STG-05** | Missing Nonce Defense | Post a valid Google ID token to `/v1/auth/google` with missing `bsk_g_nonce` cookie or missing token nonce. | Rejected with HTTP 401 `INVALID_GOOGLE_NONCE`. |
| **GIS-STG-06** | Replayed Nonce Defense | Capture a previously successful Google authentication payload and post it to `/v1/auth/google` a second time. | Rejected with HTTP 401 `INVALID_GOOGLE_NONCE` (nonce already consumed from Redis on first attempt). |
| **GIS-STG-07** | Expired Nonce Defense | Request nonce, wait beyond `GOOGLE_NONCE_TTL_SECONDS` (or set custom short TTL), complete Google sign-in. | Rejected with HTTP 401 `INVALID_GOOGLE_NONCE` (nonce key expired in Redis and cookie expired). |
| **GIS-STG-08** | Audience Mismatch Defense | Post an authentic Google ID token minted for a different Google Client ID. | Rejected with HTTP 401 `INVALID_GOOGLE_TOKEN` ("Google token audience mismatch"). |
| **GIS-STG-09** | Unverified Google Email | Authenticate using a Google Workspace account whose email is not verified (`email_verified: false`). | Rejected with HTTP 400 `GOOGLE_EMAIL_NOT_VERIFIED`. |
| **GIS-STG-10** | Google JWKS Outage / Offline | Disconnect outbound internet or block `googleapis.com` while presenting an un-cached `kid`. | Rejects safely with HTTP 401 `INVALID_GOOGLE_TOKEN` without crashing process. |

---

## 6. Resend Email Staging Readiness

### External Resend Configuration Specification
1. **Domain Registration:** Register `staging.brisksms.com` (or root `brisksms.com`) in the Resend dashboard.
2. **DNS Records to Configure:**
   - **DKIM:** TXT record `resend._domainkey.staging.brisksms.com` with value provided by Resend.
   - **SPF:** MX record `bounces.staging.brisksms.com` pointing to `feedback-smtp.resend.com` (Priority 10) and TXT record `v=spf1 include:amazonses.com ~all`.
   - **DMARC:** TXT record `_dmarc.staging.brisksms.com` with value `v=DMARC1; p=none;`.
3. **API Key Generation:** Generate an API Key with "Sending access" restricted to `staging.brisksms.com`.
4. **Sender Configuration:** Set `RESEND_FROM_EMAIL=BriskSMS Staging <verify@staging.brisksms.com>`.

### Architecture & Safety Verification
- **Connection Starvation Prevention:** In `apps/api/src/modules/auth/auth.service.ts` (lines 288–299 and 648–654), `emailService.sendVerificationEmail()` is executed **strictly after** the database transaction has committed. Slow external HTTP calls to Resend never hold open PostgreSQL transaction locks.
- **URL Fragment Privacy (RFC 3986):** Links are generated as `${FRONTEND_URL}/verify-email#token=${rawToken}`. The single-use verification token is placed in the URL hash fragment rather than query parameters, preventing tokens from leaking in web server access logs, reverse proxy headers, or browser Referer headers.
- **Anti-Enumeration Rate Limiting:** `POST /v1/auth/resend-verification` enforces dual limits:
  - 5 requests per 15 minutes per IP.
  - 3 requests per 15 minutes per recipient (using a privacy-preserving SHA-256 hash `sha256('resend_recipient:' + email)` so raw emails are never stored in Redis keys).
  - Returns an identical generic success message regardless of whether the account exists, is already verified, or is unverified.

### 10 Real-Email Test Cases for Staging

| Test ID | Test Scenario | Execution Action | Expected Result |
|---|---|---|---|
| **EML-STG-01** | Registration Email Delivery | Register new merchant with real staging email address via `POST /v1/auth/register`. | Verification email arrives in recipient inbox within 10s with valid Stitch-styled HTML template. |
| **EML-STG-02** | Successful Email Verification | Click verification button in email (`/verify-email#token=...`). | Web console reads hash fragment, posts to `/v1/auth/verify-email`. Account marked `isEmailVerified: true`. |
| **EML-STG-03** | Replay Verification Token | Click verification link a second time or replay the token to `/v1/auth/verify-email`. | Rejected with HTTP 400 `INVALID_VERIFICATION_TOKEN` ("Token has already been consumed"). |
| **EML-STG-04** | Expired Verification Token | Attempt verification with token older than `EMAIL_VERIFICATION_EXPIRY_HOURS` (24h). | Rejected with HTTP 400 `INVALID_VERIFICATION_TOKEN` ("Verification token has expired"). |
| **EML-STG-05** | Resend Verification Email | Request new verification email via `POST /v1/auth/resend-verification`. | New email arrives with fresh token. Previous token is revoked in database. |
| **EML-STG-06** | Recipient Rate Limiting | Trigger 4 resend verification requests for the same email address within 15 minutes. | 4th request rejected with HTTP 429 `TOO_MANY_REQUESTS`. |
| **EML-STG-07** | IP Rate Limiting | Trigger 6 resend verification requests targeting different emails from the same IP. | 6th request rejected with HTTP 429 `TOO_MANY_REQUESTS`. |
| **EML-STG-08** | Anti-Enumeration Defense | Request resend for a non-existent email address and an already-verified email address. | Both return HTTP 200 with identical generic success message. Zero emails dispatched. |
| **EML-STG-09** | Invalid Recipient Handling | Submit malformed email address (e.g. `invalid-format`). | Rejected safely without sending network request to Resend. |
| **EML-STG-10** | Provider Network Outage | Temporarily set invalid `RESEND_API_KEY` in staging. | Registration transaction completes successfully; error is logged with redacted credentials; user can log in and request resend later. |

---

## 7. Authentication & Browser Security Readiness

### Cookie Security Specification

| Cookie Name | Purpose | HttpOnly | Secure Flag | SameSite | Path | Expiry / Max-Age |
|---|---|---|---|---|---|---|
| `bsk_session` | JWT Access Token | `true` | `true` (in prod/staging) | `Lax` | `/` | 900s (15 minutes) |
| `bsk_refresh` | Opaque Refresh Token Hash | `true` | `true` (in prod/staging) | `Strict` | `/v1/auth` | 2,592,000s (30 days) |
| `bsk_csrf` | Double-Submit CSRF Token | `false` (JS readable) | `true` (in prod/staging) | `Lax` | `/` | 86,400s (24 hours) |
| `bsk_g_nonce` | OpenID Connect Nonce Hash | `true` | `true` (in prod/staging) | `Lax` | `/v1/auth/google` | Bounded: `GOOGLE_NONCE_TTL_SECONDS` (default: 300s) |

### Implemented vs. Deployment-Dependent Protections

#### Implemented in Code
- **CSRF Double-Submit Validation:** Every mutating browser request (`POST`, `PATCH`, `DELETE`) requires both the `bsk_csrf` cookie and matching `X-CSRF-Token` header signed with `CSRF_SECRET`.
- **Fetch Metadata Policy:** Mutating requests bearing `Sec-Fetch-Site: cross-site` are blocked immediately with HTTP 403 `CSRF_CROSS_SITE_FORBIDDEN`.
- **Origin & Referer Enforcement:** Validates `Origin` against `ALLOWED_ORIGINS` / `FRONTEND_URL`. Rejects mismatched origins with HTTP 403 `CSRF_ORIGIN_MISMATCH`. If `Origin` is omitted (e.g. GET requests), validates `Referer`.
- **Anti-Prefetch & Anti-Navigation on Nonce:** Rejects `purpose: prefetch` and `sec-fetch-mode: navigate` on `/v1/auth/google/nonce`.
- **Anti-Caching Headers:** `/v1/auth/*` routes emit `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0`.

#### Deployment-Dependent (Must Be Enforced at Reverse Proxy)
- **Content-Security-Policy (CSP):** The application code does **not** emit a CSP header. The reverse proxy (Cloudflare/Nginx) must inject:
  ```text
  Content-Security-Policy: default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://staging-api.brisksms.com https://accounts.google.com/gsi/; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: https:;
  ```
- **X-Forwarded-For Sanitization:** The reverse proxy must strip client-supplied `X-Forwarded-For` headers and set `X-Forwarded-For $remote_addr` so that rate limiting cannot be spoofed.
- **HSTS (HTTP Strict Transport Security):** Must be injected by the edge proxy (`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`).

---

## 8. Database, Redis & Worker Readiness

### Migration Ordering & Checksum Integrity
Migrations are located in `packages/db/prisma/migrations/` and executed chronologically by `packages/db/src/cli.ts migrate`:
1. `20261107000000_init_foundation`: Core tables (`users`, `organizations`, `organization_memberships`, `devices`, `invoices`, `payments`, `raw_payment_evidence`).
2. `20261107010000_smsgate_keys_and_webhook_events`: SMSGate webhook signing keys and delivery event storage.
3. `20261109000000_durable_message_idempotency`: `message_idempotency_records` table with `UNIQUE(organization_id, idempotency_key)` and credit balance columns.
4. `20261109010000_message_dispatch_recovery`: Recovery leases (`claimed_by`, `lease_expires_at`, `dispatch_started_at`) and `DISPATCHING` status enum.
5. `20261110000000_email_verification_and_google_auth`: `email_verification_tokens` table, `google_subject` column, and scrypt password isolation.

*Fresh Migration Test:* Verified on clean database cluster; all 5 migrations execute cleanly in < 1.5 seconds.

### Background Runners & Fault Tolerance
1. **`DispatchRecoveryRunner` (Every 30s):**
   - Sweeps dispatches stuck in `DISPATCHING` whose lease has expired (`lease_expires_at < NOW()`).
   - Sweeps dispatches stuck in `PENDING` longer than `DISPATCH_PENDING_GRACE_SECONDS` (default: 60s).
   - Safe under multi-worker concurrency using PostgreSQL atomic CAS (`UPDATE ... WHERE status = 'DISPATCHING' AND lease_expires_at < NOW()`).
2. **`MaintenanceRunner` (Every 1h):**
   - Purges expired pairing tokens (`expires_at < NOW()`).
   - Purges revoked session JTIs older than 30 days.
   - Purges expired or consumed email verification tokens older than `MAINTENANCE_RETENTION_DAYS` (default: 30 days).
   - **Invariant:** Active, unexpired verification tokens are strictly preserved.
3. **Idempotency & Accounting Guarantees:**
   - Message dispatch operations enforce unique constraint `(organization_id, idempotency_key)`. Concurrent or repeated requests return the original dispatch record without duplicate carrier submission or double credit deduction.
   - Ambiguous HTTP responses from SMSGate (HTTP 408, 409, 429, 500–504, or network drops) are classified strictly as `UNCERTAIN`. Credits are neither auto-refunded nor blindly retried, preventing double dispatch.

---

## 9. Product-Specific Staging Boundaries

```mermaid
flowchart LR
    subgraph Product A: Payment Intelligence [NON-CUSTODIAL & NO BULK CREDITS]
        P1["Android Ingestion Relay<br/>(POST /v1/ingestion/evidence)"] --> P2["Append-Only Raw Evidence<br/>(status: OBSERVED)"]
        P2 --> P3["Deterministic Parser Engine<br/>(Normalize M-Pesa / Airtel)"]
        P3 --> P4["Candidate Match Suggestion<br/>(CANNOT Settle Invoice)"]
        P4 --> P5["Reconciliation Engine<br/>(ACID Lock SELECT FOR UPDATE)"]
        P5 --> P6["Invoice Balance Settled<br/>(status: PAID)"]
    end

    subgraph Product B: Cellular Messaging [PREPAID CREDIT LEDGER]
        M1["Client Dispatch Request<br/>(Idempotency-Key)"] --> M2["Reserve Prepaid Credits<br/>(Immutable Credit Ledger)"]
        M2 --> M3["TCRA Curfew Filter<br/>(20:00 - 07:00 EAT)"]
        M3 --> M4["SMSGate Cellular Relay<br/>(textMessage.text)"]
        M4 --> M5{"Gateway Classification"}
        M5 -->|200 / 201 Success| M6["Mark SENT / DELIVERED"]
        M5 -->|400-404 Rejection| M7["Mark FAILED & Refund Credit"]
        M5 -->|408 / 409 / 500-504| M8["Mark UNCERTAIN (No Auto-Refund)"]
    end
```

### Strict Non-Negotiable Operational Boundaries

#### Product A (Payment Intelligence)
- **Non-Custodial Invariant:** BriskSMS never connects to banking APIs, holds customer balances, or clears funds.
- **Evidence Immutability:** `raw_payment_evidence` records are append-only.
- **Settlement Boundary:** Notification ingestion (`POST /v1/ingestion/evidence`) and candidate matching **NEVER** mark an invoice paid. Settlement can only occur via the reconciliation engine within an ACID transaction using row-level locks (`SELECT ... FOR UPDATE`).
- **Billing Isolation:** Payment reconciliation billing is based on merchant subscription tiers and **never** requires or deducts bulk SMS credits.
- **Staging Rule:** Test only with synthetic mobile money SMS payloads. Never collect real merchant payment notifications or real customer financial transactions during staging.

#### Product B (Cellular Messaging Gateway)
- **SMSGate Payload Contract:** Outbound dispatch payloads must strictly use `textMessage.text`. Legacy `message` strings are prohibited.
- **Classification Invariant:** Ambiguous outcomes (timeouts, network resets, HTTP 409 conflicts, 5xx server errors) must be classified as `UNCERTAIN`. Blind retries and automatic credit refunds are strictly forbidden.
- **Curfew Enforcement:** Promotional campaigns must be held between 20:00 and 07:00 EAT. Transactional SMS are exempt.
- **Staging Rule:** Dispatch outbound SMS only to designated internal test SIM cards. Never send test messages to real customer numbers.

---

## 10. External Account & DNS Prerequisites Checklist

| Prerequisite Item | Provider / Service | Required Action | Status |
|---|---|---|---|
| **DNS Record: `staging-api.brisksms.com`** | DNS Registrar / Cloudflare | Point A/AAAA/CNAME record to staging reverse proxy. | `REQUIRES EXTERNAL CONFIGURATION` |
| **DNS Record: `staging-console.brisksms.com`** | DNS Registrar / Cloudflare | Point A/AAAA/CNAME record to staging web console host. | `REQUIRES EXTERNAL CONFIGURATION` |
| **Resend DKIM DNS Record** | DNS Registrar / Cloudflare | Add TXT `resend._domainkey.staging.brisksms.com` provided by Resend. | `REQUIRES EXTERNAL CONFIGURATION` |
| **Resend SPF DNS Record** | DNS Registrar / Cloudflare | Add MX and TXT records for `bounces.staging.brisksms.com`. | `REQUIRES EXTERNAL CONFIGURATION` |
| **Resend DMARC DNS Record** | DNS Registrar / Cloudflare | Add TXT `_dmarc.staging.brisksms.com` (`v=DMARC1; p=none;`). | `REQUIRES EXTERNAL CONFIGURATION` |
| **Google Cloud Project & Web Client** | Google Cloud Console | Create OAuth 2.0 Web Client ID; add `https://staging-console.brisksms.com` to Authorized JavaScript Origins. | `REQUIRES EXTERNAL CONFIGURATION` |
| **Resend API Key (`re_...`)** | Resend Dashboard | Generate sending key restricted to verified staging domain. | `REQUIRES EXTERNAL CONFIGURATION` |
| **PostgreSQL 16 Instance** | Cloud Provider / Staging Host | Provision PostgreSQL with `brisksms_staging` database. | `REQUIRES EXTERNAL CONFIGURATION` |
| **Redis 7 Instance** | Cloud Provider / Staging Host | Provision Redis 7 with password on private VPC network. | `REQUIRES EXTERNAL CONFIGURATION` |
| **Cryptographic Secrets** | Staging Admin Shell | Run secret generation script to produce independent master keys. | `REQUIRES EXTERNAL CONFIGURATION` |
| **Physical Android Test Device** | Hardware Lab | Install `app-debug.apk` on physical Android phone with test SIM. | `REQUIRES LIVE STAGING TEST` |

---

## 11. Rollback & Recovery Procedure

If a deployment or validation failure occurs in staging:

### Database Rollback
1. The 5 applied migrations are additive and non-destructive.
2. If schema rollback is required:
   ```bash
   # Restore pre-migration PostgreSQL logical dump
   psql -h staging-pg -U brisksms -d brisksms_staging < pre_migration_backup.sql
   ```
3. `ALLOW_PRODUCTION_DB_RESET` must remain `false`. Never drop staging databases in place.

### Service Rollback
1. Stop running worker processes:
   ```bash
   systemctl stop brisksms-worker  # or docker compose stop worker
   ```
2. Revert API and Web containers to previous verified container tag:
   ```bash
   docker compose up -d --no-deps api web
   ```
3. Clear cached Redis session state if key schema conflicts occur:
   ```bash
   redis-cli -h staging-redis -a "[PASS]" EVAL "for _,k in ipairs(redis.call('keys','auth:*')) do redis.call('del',k) end" 0
   ```
4. Restart background worker and monitor `DispatchRecoveryRunner` logs.

---

## 12. Staging Execution Gates & Sign-Off Criteria

Before BriskSMS staging can be certified as **PASS**, all of the following criteria must be fulfilled:

1. [x] **Monorepo Build & Typecheck:** 0 errors across all TypeScript and Kotlin packages (`VERIFIED IN CODE`).
2. [x] **Automated Test Suite:** 630/630 unit and integration tests passing (`VERIFIED BY AUTOMATED TEST`).
3. [x] **Remote CI Pipeline:** GitHub Actions passing on `main` (`VERIFIED IN REMOTE CI`).
4. [ ] **Remote Push Synchronization:** Push local commits `85ce006` through `263f77a` to `origin/main`.
5. [ ] **External Google SSO Setup:** Verified Google Cloud Console client ID and live browser login.
6. [ ] **External Resend Verification:** Real verification email delivered and token consumed via URL fragment.
7. [ ] **Android QR Pairing:** Physical device pairs via Keystore hardware key and registers device token.
8. [ ] **Product A Ingestion:** Synthetic M-Pesa notification ingested, parsed, and reconciled against test invoice.
9. [ ] **Product B Cellular Dispatch:** Outbound test SMS dispatched through cellular Android gateway to internal test phone.
10. [ ] **Recovery Execution:** Intentional worker SIGKILL recovers unleased dispatches within 60s without duplicate dispatch.
