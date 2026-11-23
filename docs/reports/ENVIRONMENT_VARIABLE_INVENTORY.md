# BriskSMS Engineering Report: Environment Variable Inventory & Configuration Governance

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Branch:** `main`  
**Last Synced Against:** `e6c593d0f5bedd41939fd45c9f23082a1bada04b` + Uncommitted P0–P2 & Hard Audit Remediations  
**Scope:** Complete Static and Dynamic Configuration Inventory Across Monorepo Packages and Services  
**Compliance Standard:** Production-First, Zero-Leakage, Fail-Closed Security Governance

---

## 1. Executive Summary & Configuration Governance

BriskSMS enforces a **Production-First, Security-First** configuration governance model. All configuration and secret ingestion must comply with three core rules:

1. **Fail-Closed Production Bootstrapping:** In `production` mode (`NODE_ENV=production`), the application refuses to boot if any required secret is missing, has insufficient entropy (< 32 characters / < 64 hex characters), or matches known development/CI defaults.
2. **Cryptographic Key Independence:** Distinct cryptographic keys must be provisioned for distinct cryptographic boundaries. The CSRF signing secret (`CSRF_SECRET`), the user JWT access token secret (`JWT_ACCESS_SECRET`), and the AES-256-GCM at-rest encryption key (`ENCRYPTION_MASTER_KEY`) must never share the same underlying key material.
3. **Multi-Tenant & SSRF Isolation:** Configuration variables that permit loopback network routing (`ALLOW_PRIVATE_GATEWAY_NETWORKS`) or destructive schema teardown (`ALLOW_PRODUCTION_DB_RESET`) are strictly prohibited or hard-disabled in production.

---

## 2. Complete Environment Variable Inventory

The following table documents every environment variable referenced in the BriskSMS monorepo source code:

| Variable Name | Applicable Services | Required in Prod? | Sensitive / Secret? | Development Default | Fail-Closed Behavior | Operational Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `NODE_ENV` | All Services & CLI | **Required** | No | `development` | Defaults to development. Setting `production` activates strict runtime guards. | Governs application runtime environment, cookie security flags, origin enforcement, and encryption guards. |
| `PORT` | `apps/api` | Optional | No | `3000` | Fallback to `3000` | HTTP listening port for the API modular monolith. |
| `DATABASE_URL` | `apps/api`, `apps/worker`, `packages/db` | **Required** | **YES (DB Credentials)** | None (Required) | Throws fatal error on startup if connection string is missing or invalid. | Authoritative PostgreSQL connection URI (e.g., `postgresql://user:pass@host:5432/dbname?sslmode=require`). |
| `PGHOST` | `packages/db` | Optional | No | None | Fallback to host parsed from `DATABASE_URL`. | Optional host override or explicit Unix socket path (`/var/run/postgresql`). |
| `PGUSER` | `packages/db` | Optional | No | `brisksms` | Fallback to user parsed from `DATABASE_URL`. | Optional PostgreSQL username override. |
| `PGPASSWORD` | `packages/db` | Optional | **YES** | None | Fallback to password parsed from `DATABASE_URL`. | Optional PostgreSQL password override. |
| `FORCE_TCP_POSTGRES` | `packages/db`, CI | Optional | No | `false` | None | When `'true'`, forces TCP network connection and prevents local Unix domain socket resolution. Crucial for containerized environments. |
| `ALLOW_PRODUCTION_DB_RESET` | `packages/db` | **PROHIBITED** | No | `false` | **Always blocked in production.** Throws `SECURITY_GUARD_VIOLATION` if called when `NODE_ENV=production`. | Safety guard preventing accidental execution of destructive schema drop / database reset. |
| `REDIS_URL` | `apps/api`, `apps/worker`, `packages/db` | **Required** | **YES (Redis Auth)** | None (Required) | Throws fatal error on startup if Redis connection string is missing. | Redis connection URI for BullMQ queues, rate limiting, and ephemeral outbox processing. |
| `REDIS_SOCKET_PATH` | `packages/db` | Optional | No | None | Fallback to TCP connection. | Optional filesystem path to local Redis Unix domain socket. |
| `FORCE_TCP_REDIS` | `packages/db`, CI | Optional | No | `false` | None | When `'true'`, forces TCP network connection to Redis and skips local socket checks. |
| `ENCRYPTION_MASTER_KEY` | `apps/api`, `apps/worker`, `packages/db` | **Required** | **YES (CRITICAL)** | Fallback in dev/test | **Fatal boot termination** in production if missing, < 32 chars, or in `INSECURE_DEFAULT_KEYS`. | 32-byte (or 64-hex char) AES-256-GCM master key used to encrypt device secrets, webhook secrets, and gateway credentials at rest. |
| `JWT_ACCESS_SECRET` | `apps/api` | **Required** | **YES (CRITICAL)** | Dev fallback | Dev fallback in dev/test; required in production. | HMAC-SHA256 signing secret for short-lived merchant JWT access tokens (15-minute expiry). |
| `CSRF_SECRET` | `apps/api` | **Required** | **YES (CRITICAL)** | Dev fallback | **Fatal error in production** if missing, < 32 chars, in `INSECURE_DEFAULT_KEYS`, or matches `JWT_ACCESS_SECRET` / `ENCRYPTION_MASTER_KEY`. | HMAC-SHA256 signing secret for double-submit CSRF cookie tokens with embedded timestamp verification. |
| `ALLOWED_ORIGINS` | `apps/api` | **Required in Prod** | No | Localhost origins | In production, requests from unlisted origins return `403 CSRF_ORIGIN_MISMATCH`. Wildcard `*` strictly rejected. | Comma-separated list of authorized browser web console origins (e.g., `https://console.brisksms.app`). |
| `CORS_ORIGIN` | `apps/api` | Optional | No | None | Merged with `ALLOWED_ORIGINS`. | Legacy/alternative comma-separated list of allowed CORS origins. |
| `FRONTEND_URL` | `apps/api` | **Required in Prod** | No | None | Merged with `ALLOWED_ORIGINS`. | Canonical URL of the merchant web console for email links and CORS validation. |
| `API_BASE_URL` | `apps/api`, `apps/worker` | **Required in Prod** | No | `http://localhost:3000` | Fallback to localhost. | Public canonical URL of the BriskSMS API used in webhook payloads and companion app pairing codes. |
| `PAIRING_CHALLENGE_TTL_SECONDS` | `apps/api` | Optional | No | `120` | Rejects values outside integer range `10..300` with `500 INVALID_PAIRING_CONFIG`. | Single-use Android device pairing Proof-of-Possession challenge lifetime in seconds (capped by pairing token expiry). |
| `DEVICE_COMMAND_TTL_SECONDS` | `apps/api` | Optional | No | `3600` | Rejects values outside `5..604800` with `500 INVALID_DEVICE_COMMAND_CONFIG`. | Default expiration lifetime for durable PostgreSQL `device_commands`. |
| `DEVICE_COMMAND_LEASE_SECONDS` | `apps/api` | Optional | No | `60` | Rejects values outside `5..3600` with `500 INVALID_DEVICE_COMMAND_CONFIG`. | Bounded delivery lease window before unacknowledged `device_commands` become eligible for redelivery. |
| `PLATFORM_ADMIN_SECRET` | `apps/api` | **Required for `/v1/admin/catalog/*`** | **YES (CRITICAL)** | None | Fails closed with `503 PLATFORM_ADMIN_UNCONFIGURED` when unset or `< 24` chars; invalid `X-Platform-Admin-Key` returns `403`. | Shared constant-time admin secret protecting platform subscription catalog mutations. |
| `TRUST_PROXY` | `apps/api` | Recommended behind TLS proxy | No | `false` | When not `'true'` in staging/prod, ignores `X-Forwarded-For` and uses raw socket IP. | Enables `X-Forwarded-For` extraction behind a sanitizing reverse proxy. |
| `STRICT_MIGRATION_CHECKSUMS` | `packages/db` | Auto `'true'` in prod | No | `false` | Rejects mismatch between disk `migration.sql` SHA-256 and `_prisma_migrations.checksum`. | Enforces strict SQL migration checksum integrity on boot/deploy. |
| `ALLOW_PRIVATE_GATEWAY_NETWORKS` | `apps/api`, `apps/worker` | **PROHIBITED in Prod** | No | `false` | When not `'true'`, SSRF filter strictly blocks loopback, link-local (169.254.x), and private subnets (10.x, 172.16-31.x, 192.168.x). | Toggle allowing private IP targets for local SMSGate test gateways during local integration testing. |
| `ALLOW_PRIVATE_WEBHOOK_NETWORKS` | `apps/api`, `apps/worker` | **PROHIBITED in Prod** | No | `false` | Blocks private/loopback/metadata webhook destinations unless `'true'`. | Toggle permitting private network webhook targets in local development. |
| `ALLOW_INSECURE_WEBHOOK_HTTP` | `apps/api`, `apps/worker` | **PROHIBITED in Prod** | No | `false` | Requires HTTPS webhook URLs in production unless explicitly `'true'`. | Development escape hatch for non-HTTPS local webhook test endpoints. |
| `PROMOTIONAL_CURFEW_ENABLED` | `apps/api`, `apps/worker` | Optional | No | `true` | When not explicitly `'false'`, TCRA promotional curfew is strictly enforced. | Governs whether outbound promotional SMS are held outside permitted commercial hours. |
| `PROMOTIONAL_CURFEW_START_HOUR_EAT` | `apps/api`, `apps/worker` | Optional | No | `20` (8:00 PM) | Fallback to 20 | Commercial curfew start hour in East Africa Time (UTC+3). Outbound promotional SMS held after this hour. |
| `PROMOTIONAL_CURFEW_END_HOUR_EAT` | `apps/api`, `apps/worker` | Optional | No | `7` (7:00 AM) | Fallback to 7 | Commercial curfew end hour in East Africa Time (UTC+3). Held promotional SMS resume delivery at this hour. |
| `GOOGLE_CLIENT_ID` | `apps/api` | Required for Google SSO | No | None | Rejects Google Sign-In tokens when unset or audience mismatches. | Expected OAuth 2.0 `aud`/`azp` Client ID for Google ID token verification. |
| `GOOGLE_NONCE_TTL_SECONDS` | `apps/api` | Optional | No | `300` | Clamped/validated to `30..900` seconds (fallback `300`). | Server-issued OpenID Connect `bsk_g_nonce` lifetime. |
| `RESEND_API_KEY` | `apps/api` | Required for Email | **YES** | None | Logs configuration error and returns failure cleanly when unset. | Bearer API key for Resend transactional verification emails. |
| `RESEND_FROM_EMAIL` | `apps/api` | Optional | No | `BriskSMS <verify@brisksms.app>` | Fallback to default verified address. | Sender identity for verification emails. |
| `EMAIL_VERIFICATION_EXPIRY_HOURS` | `apps/api` | Optional | No | `24` | Fallback to 24 hours. | Lifetime of single-use `bsk_ev_...` verification tokens. |
| `DISPATCH_PENDING_GRACE_SECONDS` / `DISPATCH_RECOVERY_INTERVAL_MS` | `apps/worker` | Optional | No | `60` / `30000` (or `10000`) | Safe integer defaults. | Stale `PENDING` SMSGate dispatch grace window and worker recovery sweep cadence. |
| `HISTORY_RETENTION_DAYS` | `apps/worker` | Optional | No | `90` | A value that is not a number falls back to 90; values below 30 are raised to 30. | How long finished outbound SMS jobs and device commands are kept before `MaintenanceRunner` deletes them in small batches. |
| `MAINTENANCE_INTERVAL_MS` / `MAINTENANCE_RETENTION_DAYS` | `apps/worker` | Optional | No | `3600000` / `30` | Safe integer defaults. | `MaintenanceRunner` cleanup schedule and retention window. |
| `BRISKSMS_SILENT_LOGS` | `packages/db`, Tests | Optional | No | `false` | Fallback to standard logging. | When `'true'`, suppresses error logs on stdout/stderr during test runs. |
| `CLIENT_ID` / `CLIENT_SECRET` | `packages/zapier-app` | Optional | **YES (`CLIENT_SECRET`)** | `brisksms_zapier_client` | Public client flow unless confidential secret set. | OAuth credentials for `@brisksms/zapier-app`. |
| `BRISKSMS_API_KEY` / `BRISKSMS_DEVICE_TOKEN` / `BRISKSMS_SESSION_TOKEN` | CLI / Docs | Optional | **YES** | None | Client-side REST integration / helper env vars only (not required by API boot). | Sample env vars used by client helpers and REST developer portal snippets. |
| `APP_RELEASE_VERSION_CODE` / `_VERSION_NAME` / `_APK_URL` / `_APK_SHA256` / `_NOTES` / `_MIN_SUPPORTED_VERSION_CODE` | `apps/api` | Optional | No | None (no release published) | Unset `APP_RELEASE_VERSION_CODE` means no update is offered. Once it is set, a missing name, a non-`https` or unparsable APK URL, a checksum that is not 64 hex characters, notes over 1000 characters, or a minimum above the version code makes `GET /v1/app/releases/latest` answer `503 APP_RELEASE_CONFIG_INVALID`. | Describes the newest direct-download APK. The Android `direct` build reads it to offer an in-app update; the `play` build never calls it. |

---

## 3. Deep-Dive by Functional Subsystem

### 3.1 Security, Encryption & Web Session Management

```mermaid
flowchart TD
    subgraph Secret_Separation["Cryptographic Secret Separation (Strict Independence)"]
        AESKey["ENCRYPTION_MASTER_KEY<br/>(AES-256-GCM)<br/>64 Hex Chars"]
        JWTSec["JWT_ACCESS_SECRET<br/>(HMAC-SHA256)<br/>Min 32 Chars"]
        CSRFSec["CSRF_SECRET<br/>(HMAC-SHA256)<br/>Min 32 Chars"]
    end
    
    AESKey -.->|Strictly Not Equal| JWTSec
    JWTSec -.->|Strictly Not Equal| CSRFSec
    CSRFSec -.->|Strictly Not Equal| AESKey
    
    AESKey --> DataStorage["Encrypted Secrets at Rest<br/>(Device Keys, Webhook Secrets, SMSGate Tokens)"]
    JWTSec --> AccessTokens["Merchant JWT Access Tokens (15m Expire)"]
    CSRFSec --> CSRFTokens["HMAC Double-Submit CSRF Tokens (24h Expire)"]
```

#### `ENCRYPTION_MASTER_KEY`
- **Algorithm:** AES-256-GCM with authenticated tags (`tagHex`) and unique 96-bit initialization vectors (`ivHex`).
- **Production Validation:**
  - Evaluated on boot via `validateProductionEncryptionConfig()`.
  - Must not match any entry in `INSECURE_DEFAULT_KEYS`.
  - Must not contain substrings `ci_encryption` or `dev_encryption`.
  - Length must be at least 32 characters (or 64 hexadecimal characters).
  - Hex strings (`/^[0-9a-fA-F]{64}$/`) are decoded directly into 32-byte buffers; other strings are hashed with SHA-256 to derive the 256-bit key buffer.

#### `CSRF_SECRET`
- **Algorithm:** HMAC-SHA256 signing of `${nonce}.${expiresAt}`.
- **Production Validation:**
  - Evaluated on boot and request time via `getCsrfSecret()`.
  - Must be independently configured: throws `FATAL: CSRF_SECRET must be independently configured and not reuse JWT_ACCESS_SECRET` if secrets are identical.
  - Throws `FATAL: CSRF_SECRET must be independently configured and not reuse ENCRYPTION_MASTER_KEY` if secrets are identical.

#### `ALLOWED_ORIGINS` & `FRONTEND_URL`
- **Protection Vector:** Cross-Origin Resource Sharing (CORS) and Login/Refresh CSRF defense.
- **Production Validation:**
  - Evaluated via `getAllowedOrigins()` and `isAllowedOrigin(origin)`.
  - Explicitly discards wildcard `'*'` and `'null'`. In production, if unconfigured, no origin is authorized, preventing cross-origin attacks.

---

### 3.2 Authoritative Database Persistence (PostgreSQL 16+)

#### `DATABASE_URL`
- **Format:** `postgresql://[user[:password]@][host][:port][/database][?parameters]`
- **Connection Modes:**
  - In containerized staging/production, `sslmode=require` or `sslmode=verify-full` is mandatory.
  - `FORCE_TCP_POSTGRES='true'` guarantees the client bypasses filesystem Unix domain socket probing (`/var/run/postgresql`), ensuring reliable container-to-managed-database networking.

#### `ALLOW_PRODUCTION_DB_RESET`
- **Safety Enforcement:**
  - Defined in `packages/db/src/migrate.ts`.
  - When `NODE_ENV=production` or `DATABASE_URL` contains `prod`, calling `resetDevDatabase()` or `resetTestDatabaseState()` immediately throws `SECURITY_GUARD_VIOLATION`.
  - This prevents accidental truncation or schema deletion in staging/production databases.

---

### 3.3 Asynchronous Queues & Background Processing (Redis 7+ & BullMQ)

#### `REDIS_URL`
- **Format:** `redis://[:password@]host:port[/db]` (raw TCP `net.Socket` or Unix domain socket) or `rediss://[:password@]host:port[/db]` (TLS via `tls.connect` in `packages/db/src/redis.ts`). Redis must still run inside a private VPC subnet or localhost.
- **Staging Requirements:**
  - In staging/production, password authentication is mandatory.
  - Prefix/namespace separation is maintained via BullMQ queue configurations (`staging:bullmq:events`, `staging:bullmq:outbox`).
  - `FORCE_TCP_REDIS='true'` ensures containerized workers connect across the staging VPC without searching for `/tmp/redis.sock`.

---

### 3.4 Regulatory & Cellular Gateway Controls

#### `PROMOTIONAL_CURFEW_ENABLED`, `PROMOTIONAL_CURFEW_START_HOUR_EAT`, `PROMOTIONAL_CURFEW_END_HOUR_EAT`
- **Regulatory Standard:** Tanzania Communications Regulatory Authority (TCRA) Commercial Messaging Directives.
- **Operational Logic:**
  - Evaluated in `apps/api/src/modules/messaging/messaging.service.ts` via `isPromotionalCurfewActive()`.
  - Promotional messages dispatched between 20:00 (8:00 PM) and 07:00 (7:00 AM) EAT are queued with status `SCHEDULED` and a release timestamp set to 07:00 EAT.
  - Transactional OTPs and payment verification alerts are classified as `TRANSACTIONAL` and immediately bypass the curfew.

#### `ALLOW_PRIVATE_GATEWAY_NETWORKS`
- **SSRF Defense:**
  - Evaluated in `apps/api/src/modules/messaging/providers/smsgate.provider.ts`.
  - By default (`false`), any attempt to configure an SMSGate URL targeting `localhost`, `127.0.0.1`, `::1`, `169.254.169.254`, or RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) is rejected.
  - In production, this must never be enabled.

---

## 4. Production Secret Generation & Provisioning Guide

For engineers provisioning a new staging or production environment, use the following cryptographically validated commands:

```bash
# ------------------------------------------------------------------------------
# 1. Generate 32-byte AES-256-GCM Master Encryption Key (64 Hex Characters)
# ------------------------------------------------------------------------------
export ENCRYPTION_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# ------------------------------------------------------------------------------
# 2. Generate Independent JWT Access Token Secret (64 Hex Characters)
# ------------------------------------------------------------------------------
export JWT_ACCESS_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# ------------------------------------------------------------------------------
# 3. Generate Independent CSRF Signing Secret (64 Hex Characters)
# ------------------------------------------------------------------------------
export CSRF_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# ------------------------------------------------------------------------------
# 4. Verify Secrets Are Strictly Distinct
# ------------------------------------------------------------------------------
if [ "$ENCRYPTION_MASTER_KEY" = "$JWT_ACCESS_SECRET" ] || [ "$JWT_ACCESS_SECRET" = "$CSRF_SECRET" ] || [ "$ENCRYPTION_MASTER_KEY" = "$CSRF_SECRET" ]; then
    echo "FATAL: Cryptographic key collision detected. Regenerate keys!"
    exit 1
else
    echo "Cryptographic keys generated and validated with strict independence."
fi
```

### Storing Secrets Securely
- **Staging / Production Infrastructure:** Inject keys via secure cloud secret managers (e.g., AWS Secrets Manager, Doppler, Vault, or Cloudflare Secrets).
- **Never commit `.env` files** containing real keys to version control.
- Ensure all CI/CD pipelines use repository secrets with masked logging.

---

## 5. Conclusion

This inventory represents the authoritative reference for configuring, hardening, and verifying all environment variables across BriskSMS services. Strict adherence to these validation rules ensures that staging and production deployments operate with zero secret leakage and fail-closed security.
