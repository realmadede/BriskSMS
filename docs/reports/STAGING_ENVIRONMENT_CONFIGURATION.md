# BriskSMS Engineering Report: Staging Environment Configuration & Secret Governance

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Branch:** `main`  
**Baseline Checkpoint:** `c7b4a50ab8ad636996f328645be2d18517230bd2`  
**Scope:** Exhaustive Static and Dynamic Environment Variable Inventory, Validation Rules, Fail-Closed Security Invariants, and Secret Provisioning Protocols for Staging & Production.

---

## 1. Executive Summary & Configuration Governance

BriskSMS enforces a strict **Production-First, Security-First** configuration governance model. All configuration and secret management must adhere to the following verified principles:

1. **Fail-Closed Bootstrapping:** In `production` and `staging` (`NODE_ENV=production`), the application runtime strictly halts boot if any required secret is missing, has insufficient entropy (< 32 characters or < 64 hex characters), matches known development/CI defaults, or violates cryptographic independence.
2. **Cryptographic Key Independence:** Distinct cryptographic boundaries must be backed by mathematically independent key material:
   - `ENCRYPTION_MASTER_KEY`: AES-256-GCM symmetric encryption for data at rest (device tokens, webhook secrets, gateway credentials).
   - `JWT_ACCESS_SECRET`: HMAC-SHA256 signing secret for short-lived merchant JWT access tokens (15-minute expiry).
   - `CSRF_SECRET`: HMAC-SHA256 signing secret for double-submit anti-CSRF cookies and headers.
   - Reusing key material across any two boundaries triggers immediate fatal application termination.
3. **Multi-Tenant & Network Isolation:** Configuration toggles that allow private/loopback network targets (`ALLOW_PRIVATE_GATEWAY_NETWORKS`) or destructive schema manipulation (`ALLOW_PRODUCTION_DB_RESET`) must fail closed and be strictly prohibited in staging and production.
4. **Zero Object Storage Requirement:** BriskSMS is purely database-backed. All raw payment notifications and evidence payloads are immutably stored in PostgreSQL (`raw_payment_evidence` table) as native JSONB. No S3, MinIO, Cloudflare R2, or blob storage credentials are required or supported.
5. **Redis Transport & Protocol Architecture:** The application runtime (`packages/db/src/redis.ts`) utilizes a custom lightweight RESP protocol client over raw TCP `net.Socket` (or local Unix domain socket). It handles password authentication (`AUTH <password>`) and database selection (`SELECT <db>`), but does **not** implement in-transit TLS handshakes internally. Therefore, staging/production environments requiring encrypted Redis communication must enforce transport encryption via private VPC networking or an external TLS termination tunnel (e.g., stunnel/ghostunnel). Redis persistence (AOF/RDB) is a server-side daemon configuration directive, not an application client capability.
6. **Authentication & Integration Blockers:**
   - Active merchant authentication uses custom scrypt password hashing, HMAC-signed JWTs, and secure cookies.
   - **Google Sign-In / Google Identity Token Validation:** **Completely absent** in the active codebase.
   - **Email Verification via Resend / SMTP:** **Completely absent** in the active codebase. The database includes an `is_email_verified` boolean flag, but no outbound transactional email provider client exists.
   - These missing capabilities are **explicit staging and product blockers** for workflows that require third-party identity federation or automated transactional email delivery.

---

## 2. Exhaustive Server-Side Environment Variable Inventory

Static analysis of the BriskSMS codebase reveals exactly **26 server-side environment variables** consumed by backend services and CLI tools:

| Variable Name | Consuming Service(s) | Required in Staging/Prod? | Sensitive / Secret? | Development Default | Fail-Closed Behavior | Expected Format & Validation Rules | Operational Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `NODE_ENV` | All Services & CLI | **Required** | No | `development` | Defaults to `development`. Setting `production` activates strict runtime guards. | String: `production`, `staging`, `development`, or `test`. | Governs runtime environment, cookie security attributes, origin enforcement, and encryption guards. |
| `PORT` | `apps/api` | Optional | No | `3000` | Falls back to `3000`. | Positive integer (1-65535). | TCP listening port for the API modular monolith. |
| `DATABASE_URL` | `apps/api`, `apps/worker`, `packages/db` | **Required** | **YES (DB Credentials)** | None | **Fatal boot termination** if missing or invalid. | Valid PostgreSQL URI: `postgresql://[user]:[password]@[host]:[port]/[db]?sslmode=require` | Authoritative PostgreSQL connection string. Must use `sslmode=require` in staging. |
| `PGHOST` | `packages/db` | Optional | No | None | Falls back to host parsed from `DATABASE_URL`. | Valid hostname, IP, or Unix socket path (e.g. `/var/run/postgresql`). | Optional host override or explicit Unix domain socket path. |
| `PGUSER` | `packages/db` | Optional | No | `brisksms` | Falls back to user parsed from `DATABASE_URL`. | Valid PostgreSQL role name. | Optional database username override. |
| `PGPASSWORD` | `packages/db` | Optional | **YES** | None | Falls back to password parsed from `DATABASE_URL`. | High-entropy password string. | Optional database password override. |
| `FORCE_TCP_POSTGRES` | `packages/db`, CI | Optional | No | `false` | None | Boolean string: `'true'` or `'false'`. | When `'true'`, forces TCP network connection and prevents local Unix domain socket probing. Essential in containerized staging. |
| `ALLOW_PRODUCTION_DB_RESET` | `packages/db` | **PROHIBITED** | No | `false` | **Throws `SECURITY_GUARD_VIOLATION`** if set to `'true'` when `NODE_ENV=production`. | Must be omitted or `'false'`. | Safety guard preventing accidental execution of destructive schema drop or database reset. |
| `REDIS_URL` | `apps/api`, `apps/worker`, `packages/db` | **Required** | **YES (Redis Auth)** | None | **Fatal boot termination** if missing or invalid. | Valid Redis TCP URI: `redis://[:password@]host:port[/db]`. | Authoritative Redis connection URI for BullMQ queues, rate limiting, and ephemeral outbox processing. |
| `REDIS_SOCKET_PATH` | `packages/db` | Optional | No | None | Falls back to TCP connection. | Filesystem path to Redis socket. | Optional filesystem path to local Redis Unix domain socket. |
| `FORCE_TCP_REDIS` | `packages/db`, CI | Optional | No | `false` | None | Boolean string: `'true'` or `'false'`. | When `'true'`, forces TCP network connection to Redis and skips local socket checks. |
| `ENCRYPTION_MASTER_KEY` | `apps/api`, `apps/worker`, `packages/db` | **Required** | **YES (CRITICAL)** | Dev fallback | **Fatal boot termination** if missing, < 32 chars, or in `INSECURE_DEFAULT_KEYS`. | 32-byte key: 64 hexadecimal characters (`/^[0-9a-fA-F]{64}$/`) or ≥ 32-character string. | AES-256-GCM master key used to encrypt device secrets, webhook secrets, and gateway credentials at rest. |
| `JWT_ACCESS_SECRET` | `apps/api` | **Required** | **YES (CRITICAL)** | Dev fallback | **Fatal boot termination** in production if missing or weak. | High-entropy string ≥ 32 characters (prefer 64 hex characters). | HMAC-SHA256 signing secret for short-lived merchant JWT access tokens (15-minute expiry). |
| `CSRF_SECRET` | `apps/api` | **Required** | **YES (CRITICAL)** | Dev fallback | **Fatal boot termination** if missing, < 32 chars, in `INSECURE_DEFAULT_KEYS`, or matches `JWT_ACCESS_SECRET` / `ENCRYPTION_MASTER_KEY`. | High-entropy string ≥ 32 characters (prefer 64 hex characters). Strictly distinct from other secrets. | HMAC-SHA256 signing secret for double-submit CSRF cookie tokens with embedded timestamp verification. |
| `ALLOWED_ORIGINS` | `apps/api` | **Required** | No | Localhost origins | In production, requests from unlisted origins return `403 CSRF_ORIGIN_MISMATCH`. Wildcard `*` strictly rejected. | Comma-separated list of fully qualified HTTPS origins (e.g., `https://staging-console.brisksms.com`). | Authorized browser origins permitted to communicate with API session endpoints. |
| `CORS_ORIGIN` | `apps/api` | Optional | No | None | Merged with `ALLOWED_ORIGINS`. | Comma-separated list of HTTPS origins. | Alternative/legacy environment variable merged with `ALLOWED_ORIGINS`. |
| `FRONTEND_URL` | `apps/api` | **Required** | No | None | Merged into allowed CORS origins; falls back to localhost in dev. | Fully qualified HTTPS URL (e.g., `https://staging-console.brisksms.com`). | Canonical base URL of the merchant web console for links and redirect validations. |
| `API_BASE_URL` | `apps/api`, `apps/worker` | **Required** | No | `http://localhost:3000` | Falls back to localhost in development. | Fully qualified HTTPS URL (e.g., `https://staging-api.brisksms.com`). | Public canonical URL of the BriskSMS API embedded in Android QR pairing payloads and webhook callbacks. |
| `ALLOW_PRIVATE_GATEWAY_NETWORKS` | `apps/api` | **PROHIBITED** | No | `false` | When not `'true'`, SSRF filter strictly blocks loopback (127.0.0.1, ::1), link-local (169.254.x), and private subnets (10.x, 172.16-31.x, 192.168.x). | Must be omitted or `'false'` in staging/production. | SSRF guard toggle. Must remain `false` in staging to protect private cloud infrastructure. |
| `PROMOTIONAL_CURFEW_ENABLED` | `apps/api`, `apps/worker` | Optional | No | `true` | When not `'false'`, promotional curfew is strictly enforced. | Boolean string: `'true'` or `'false'`. | TCRA commercial messaging curfew toggle. When true, promotional SMS are held between curfew hours. |
| `PROMOTIONAL_CURFEW_START_HOUR_EAT` | `apps/api`, `apps/worker` | Optional | No | `20` (8:00 PM) | Falls back to 20. | Integer between 0 and 23. | Commercial curfew start hour in East Africa Time (UTC+3). Outbound promotional SMS held after this hour. |
| `PROMOTIONAL_CURFEW_END_HOUR_EAT` | `apps/api`, `apps/worker` | Optional | No | `7` (7:00 AM) | Falls back to 7. | Integer between 0 and 23. | Commercial curfew end hour in East Africa Time (UTC+3). Held promotional SMS resume delivery at this hour. |
| `DISPATCH_PENDING_GRACE_SECONDS` | `apps/worker` | Optional | No | `60` | Falls back to 60 seconds. | Positive integer in seconds (e.g. 60). | Grace window before a PENDING dispatch operation with no active lease is considered crashed and eligible for recovery sweep. |
| `DISPATCH_RECOVERY_INTERVAL_MS` | `apps/worker` | Optional | No | `30000` | Falls back to 30,000 ms (30s). | Positive integer in milliseconds (e.g. 30000). | Polling interval for `DispatchRecoveryRunner` to sweep stale dispatches and expired claims across API/worker restarts. |
| `CLIENT_ID` | `packages/zapier-app` | Optional | No | `brisksms_zapier_client` | Standard client ID. | Alphanumeric string. | OAuth 2.0 client identifier for the BriskSMS Zapier integration. |
| `BRISKSMS_SILENT_LOGS` | `packages/db`, Tests | Optional | No | `false` | Falls back to standard logging. | Boolean string: `'true'` or `'false'`. | When `'true'`, suppresses error logs on stdout/stderr (used in automated test runners). Leave `false` in staging. |

### Client-Side / Documentation Variables (Not Consumed by Backend Services):
- `BRISKSMS_API_KEY`: Featured in developer portal code snippets (`apps/web/src/developers.html`) showing external third-party developers how to initialize client SDKs. Not consumed by the BriskSMS backend.
- `BRISKSMS_DEVICE_TOKEN`: Featured in documentation code snippets showing companion device SDK usage. Not consumed by the BriskSMS backend.

---

## 3. Cryptographic Key Generation & Separation Protocols

In compliance with our production-first security standard, staging secrets must be independently generated using cryptographically secure random bytes:

```bash
# ==============================================================================
# Staging Secret Generation Script (POSIX Compliant)
# Run once during staging provisioning and store output in secure secret manager
# ==============================================================================

# 1. Generate 32-byte AES-256-GCM Master Encryption Key (64 Hex Characters)
export STG_ENCRYPTION_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 2. Generate Independent JWT Access Token Signing Secret (64 Hex Characters)
export STG_JWT_ACCESS_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 3. Generate Independent CSRF Signing Secret (64 Hex Characters)
export STG_CSRF_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 4. Enforce Mathematical Independence
if [ "$STG_ENCRYPTION_MASTER_KEY" = "$STG_JWT_ACCESS_SECRET" ] || \
   [ "$STG_JWT_ACCESS_SECRET" = "$STG_CSRF_SECRET" ] || \
   [ "$STG_ENCRYPTION_MASTER_KEY" = "$STG_CSRF_SECRET" ]; then
    echo "FATAL: Cryptographic key collision detected. Regenerate keys!" >&2
    exit 1
fi

echo "Cryptographic secrets generated and validated with strict independence."
```

---

## 4. Staging `.env` Template (`.env.staging.example`)

Below is the verified template for staging deployments. **Never commit actual values to Git.**

```env
# ==============================================================================
# BriskSMS Staging Environment Configuration Template
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. Core Runtime & Server
# ------------------------------------------------------------------------------
NODE_ENV=production
PORT=3000
API_BASE_URL=https://staging-api.brisksms.com
FRONTEND_URL=https://staging-console.brisksms.com
ALLOWED_ORIGINS=https://staging-console.brisksms.com

# ------------------------------------------------------------------------------
# 2. Persistent Storage (PostgreSQL 16+)
# ------------------------------------------------------------------------------
DATABASE_URL=postgresql://brisksms_staging_user:REPLACE_WITH_STAGING_PG_PASSWORD@postgres-staging.internal:5432/brisksms_staging?sslmode=require
FORCE_TCP_POSTGRES=true
ALLOW_PRODUCTION_DB_RESET=false

# ------------------------------------------------------------------------------
# 3. Message Queue & Ephemeral State (Redis 7+)
# Note: packages/db/src/redis.ts uses raw TCP. Ensure private network / VPC isolation.
# ------------------------------------------------------------------------------
REDIS_URL=redis://:REPLACE_WITH_STAGING_REDIS_PASSWORD@redis-staging.internal:6379
FORCE_TCP_REDIS=true

# ------------------------------------------------------------------------------
# 4. Cryptographic Secrets (Strictly Independent, 64 Hex Characters Each)
# ------------------------------------------------------------------------------
ENCRYPTION_MASTER_KEY=REPLACE_WITH_64_HEX_CHAR_AES_KEY
JWT_ACCESS_SECRET=REPLACE_WITH_64_HEX_CHAR_JWT_SECRET
CSRF_SECRET=REPLACE_WITH_64_HEX_CHAR_CSRF_SECRET

# ------------------------------------------------------------------------------
# 5. Background Worker & Dispatch Recovery
# ------------------------------------------------------------------------------
DISPATCH_PENDING_GRACE_SECONDS=60
DISPATCH_RECOVERY_INTERVAL_MS=30000

# ------------------------------------------------------------------------------
# 6. Regulatory Curfew & Security Guards
# ------------------------------------------------------------------------------
PROMOTIONAL_CURFEW_ENABLED=true
PROMOTIONAL_CURFEW_START_HOUR_EAT=20
PROMOTIONAL_CURFEW_END_HOUR_EAT=7
ALLOW_PRIVATE_GATEWAY_NETWORKS=false
BRISKSMS_SILENT_LOGS=false
```

---

## 5. Security & Isolation Invariants

1. **No Shared Key Material:** Boot sequence fails immediately if `CSRF_SECRET === JWT_ACCESS_SECRET` or `CSRF_SECRET === ENCRYPTION_MASTER_KEY`.
2. **SSRF Hard-Blocking:** `ALLOW_PRIVATE_GATEWAY_NETWORKS=false` enforces DNS and IP resolution checks that block loopback (`127.0.0.1`, `::1`), link-local (`169.254.169.254`), and RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
3. **Database Guard:** Any attempt to invoke database drop/reset methods when `NODE_ENV=production` raises an uncatchable `SECURITY_GUARD_VIOLATION`.
4. **No Plaintext API Keys Stored:** Developer API keys are hashed with `SHA-256` before persistence. Plaintext is displayed only once upon creation.
