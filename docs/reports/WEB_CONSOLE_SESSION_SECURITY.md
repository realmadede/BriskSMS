# BriskSMS Engineering Report: Web Session Security Final Acceptance Audit

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Branch:** `main`  
**Starting Checkpoint:** `1fb5b73f134c4d3068c2b9b23a46dfeb48987b4b`  
**Final Scope:** Complete Authentication Lifecycle Audit, Login/Refresh CSRF Defense, Cryptographic CSRF Verification, Origin/CORS Restrictions, Cookie/Cache Protections, and Boundary Isolation.  
**Test Corpus Status:** **428 / 428 Tests Passing Across 40 Files (0 Failures, 100% Pass)**  
**Dedicated Web Security Tests:** **42 / 42 Tests Passing (0 Failures, 100% Pass)**  
**Readiness Verdict:** **`READY FOR EXTERNAL SECURITY TESTING`**

---

## 1. Authentication Lifecycle Audit

Every authentication entry point was independently audited across middleware, guards, cookies, request parsing, and controller execution:

| Endpoint | Method | Auth Required | Cookies Emitted / Cleared | CSRF Enforced | Origin & Fetch Metadata Checked | Token Rotation / Revocation | Sensitive Tokens in Body | Cache-Control Protections |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/v1/auth/csrf` | `GET` | No | Emits `bsk_csrf` | Exempt (Safe GET) | None | Fresh token generated | CSRF token only | `no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0` |
| `/v1/auth/register` | `POST` | No | Emits `bsk_session`, `bsk_refresh`, `bsk_csrf` | Enforced if cookies or CSRF header present | Strict Origin whitelist; `Sec-Fetch-Site: cross-site` blocked | Issues initial user session and refresh token | Returns tokens for API clients; console uses cookies | `no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0` |
| `/v1/auth/login` | `POST` | No | Emits `bsk_session`, `bsk_refresh`, `bsk_csrf` | Enforced if cookies or CSRF header present | Strict Origin whitelist; `Sec-Fetch-Site: cross-site` blocked | Issues new access and refresh tokens | Returns tokens for API clients; console uses cookies | `no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0` |
| `/v1/auth/session` | `GET` | Yes (`bsk_session` or Bearer) | Refreshes `bsk_csrf` if missing | Exempt (Safe GET) | Enforced on cookie requests | None | User profile, organizations, CSRF token; NO access/refresh tokens | `no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0` |
| `/v1/auth/refresh` | `POST` | No (Requires `bsk_refresh` cookie or body token) | Rotates and re-emits `bsk_session`, `bsk_refresh`, `bsk_csrf` | Strict double-submit CSRF enforced on cookie refresh | Strict Origin whitelist; `Sec-Fetch-Site: cross-site` blocked | Atomically rotates refresh token; revokes old token (`FOR UPDATE`) | Returns rotated tokens for API clients; console uses cookies | `no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0` |
| `/v1/auth/logout` | `POST` | Yes (Optional / Tolerant) | Clears `bsk_session`, `bsk_refresh`, `bsk_csrf` (`Max-Age=0`) | Enforced if cookies or CSRF header present | Strict Origin whitelist; `Sec-Fetch-Site: cross-site` blocked | Revokes JTI in `revoked_sessions` and refresh token in `refresh_tokens` | None (Success message) | `no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0` |
| `/v1/auth/verify-email` | `POST` | No | None | None | Strict Origin whitelist; `Sec-Fetch-Site: cross-site` blocked | None | None (Confirmation message) | `no-store, no-cache, must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0` |

---

## 2. Login & Registration CSRF Protection

### 2.1 Attack Surface & Threat Model
In Login CSRF, an attacker crafts a malicious webpage that submits credentials for an attacker-controlled account to `POST /v1/auth/login`. If unmitigated, the victim's browser would establish a session under the attacker's account, allowing the attacker to observe financial transactions or ingest malicious data under their monitoring.

### 2.2 Implemented Defenses
1. **Origin Header Enforcement:**
   When a browser initiates a cross-origin login or registration request (via `<form>`, `fetch()`, or `XMLHttpRequest`), the browser automatically sets the `Origin` header. `POST /v1/auth/login` and `POST /v1/auth/register` inspect `req.headers.origin`. If the header is present and does not strictly match the authorized frontend origin set, the request is rejected with `403 CSRF_ORIGIN_MISMATCH`.
2. **Fetch Metadata Request Policy (`Sec-Fetch-Site`):**
   Modern browsers transmit `Sec-Fetch-Site` indicating request context. Any login or registration request where `Sec-Fetch-Site === 'cross-site'` is immediately terminated with `403 CSRF_CROSS_SITE_FORBIDDEN`.
3. **Pre-Authentication CSRF Handshake:**
   The web console initiates authentication via `GET /v1/auth/csrf` to acquire a pre-authentication `bsk_csrf` cookie and cryptographic token. When present, `validateCsrf()` validates the double-submit token prior to executing credential verification.
4. **Preservation of Non-Browser API Clients:**
   Programmatic API clients (curl, automated integration suites, mobile clients) do not emit browser `Origin` or `Sec-Fetch-*` headers. Requests with zero ambient cookies and no browser origin are recognized as direct API requests and proceed without browser CSRF restrictions.

---

## 3. Refresh Endpoint CSRF Protection & Concurrency Safety

### 3.1 Dual-Mode Token Intake
`POST /v1/auth/refresh` accommodates both automated API clients and browser cookie sessions:
- **API Mode:** Accepts `refreshToken` string in the request body. If an `Origin` header is provided, it must strictly match the authorized origin whitelist.
- **Cookie Mode:** When the body contains no token, the endpoint extracts `bsk_refresh` from HttpOnly cookies and strictly enforces double-submit CSRF verification (`X-CSRF-Token` header matching `bsk_csrf` cookie).

### 3.2 Single-Use Token Rotation & Invalidation
- Refresh tokens are stored as deterministic cryptographic hashes (`hashToken(rawToken)`) in PostgreSQL.
- Refresh operations execute within ACID transactions using PostgreSQL row-level locks:
  ```sql
  SELECT * FROM "refresh_tokens" WHERE "token_hash" = $1 FOR UPDATE;
  ```
- If `record.revoked_at` is already populated or the token has expired, the request is immediately rejected with `401 INVALID_TOKEN`.
- Successful refresh marks the token revoked (`UPDATE ... SET revoked_at = NOW()`) and atomically commits a newly generated child refresh token and short-lived access JWT.

### 3.3 Replay Rejection & Concurrency Race Condition Proof
- **Replay Attack Resistance:** Subsequent attempts to reuse an old, revoked refresh token fail with `401 INVALID_TOKEN`.
- **Concurrency Safety:** Parallel requests attempting to consume the same refresh token are serialized by the `FOR UPDATE` row lock. Exactly one request acquires the lock and succeeds; the second request unblocks, detects that `revoked_at` is now set, and terminates with `401 INVALID_TOKEN`. Branching of valid sessions is physically prevented.

---

## 4. Cryptographic CSRF Implementation & Malformed Token Defense

### 4.1 Token Construction & Verification
- **Entropy & Payload:** Tokens are constructed as:
  $$\text{token} = \text{nonce} \,(24\text{ bytes / }48\text{ hex}) \,\|\, \text{expiresAt} \,(13\text{ digits}) \,\|\, \text{HMAC-SHA256}(\text{nonce} \,\|\, \text{expiresAt}, \text{secret})$$
- **Size Bounds & Format Validation:** Tokens exceeding 512 bytes, under 32 bytes, or lacking valid separators are rejected immediately.
- **Nonce & Signature Validation:** Nonces must match `/^[0-9a-f]{48}$/i` and signatures must match `/^[0-9a-f]{64}$/i`. Non-hex characters, invalid timestamps, or negative expiry values fail verification.
- **Constant-Time Verification:** Double-submit cookie-to-header comparison and signature comparisons utilize `crypto.timingSafeEqual` over fixed-length buffers to eliminate timing side channels.
- **Server-Side Expiration:** Tokens older than 24 hours (`CSRF_COOKIE_MAX_AGE = 86400`) are rejected server-side.

### 4.2 Independent Secret Configuration & Production Fail-Closed
- In production (`NODE_ENV === 'production'`), `CSRF_SECRET` is strictly required.
- **Key Separation:** The secret must be independently configured. If `CSRF_SECRET` matches `JWT_ACCESS_SECRET` or `ENCRYPTION_MASTER_KEY`, startup fails closed with `FATAL: CSRF_SECRET must be independently configured`.
- **Entropy Requirement:** Secrets under 32 characters or matching known development defaults throw fatal errors on startup.

---

## 5. Production Origin & CORS Restrictions

### 5.1 Origin Resolution & Whitelist Defense
- Allowed origins are determined strictly from `ALLOWED_ORIGINS`, `CORS_ORIGIN`, and `FRONTEND_URL`.
- **Wildcard Prohibition:** Wildcard entries (`*`) and string literal `'null'` are filtered out. Wildcard origins cannot be credentialed or accepted as authorized origins.
- **Production Localhost Rejection:** In production mode, local development hosts (`localhost`, `127.0.0.1`) are excluded unless explicitly configured in environment variables.
- **Deceptive Hostname Resistance:** Subdomain spoofing (`evil-console.brisksms.co.tz`), suffix appending (`localhost:4200.evil.com`), and path modifications fail exact Set lookup (`getAllowedOrigins().has(origin)`).

### 5.2 CORS Header Specification
- **Credentialed CORS:** When `req.headers.origin` matches an authorized origin, the API returns:
  ```http
  Access-Control-Allow-Origin: <exact-matched-origin>
  Access-Control-Allow-Credentials: true
  Vary: Origin
  ```
- **Untrusted Preflight Handling:** Preflight `OPTIONS` requests from unauthorized origins receive `204 No Content` with `Vary: Origin` but **zero** `Access-Control-Allow-Origin` or `Access-Control-Allow-Credentials` headers, causing the browser to abort cross-origin dispatch.

---

## 6. Cookie & Response Security Policy

### 6.1 Cookie Flag Specification

| Cookie | HttpOnly | Secure (Prod) | SameSite | Path | Max-Age | Purpose |
| :--- | :---: | :---: | :---: | :--- | :--- | :--- |
| `bsk_session` | **Yes** | **Yes** | `Lax` | `/` | 900s (15m) | Short-lived JWT access session |
| `bsk_refresh` | **Yes** | **Yes** | `Strict` | `/v1/auth` (Narrow) | 2,592,000s (30d) | High-entropy refresh token |
| `bsk_csrf` | No | **Yes** | `Lax` | `/` | 86,400s (24h) | Cryptographic double-submit token |

- **Narrow Scope:** `bsk_refresh` is scoped strictly to `Path=/v1/auth`. The browser will never transmit the refresh token on standard API requests (`/v1/reconciliation/*`, `/v1/messaging/*`), minimizing ambient exposure.
- **Logout Cleansing:** `POST /v1/auth/logout` emits `Set-Cookie` headers with `Max-Age=0` and matching `Path` attributes (`/` for session/csrf, `/v1/auth` for refresh).
- **Domain Attribute:** No broad `Domain` attribute is configured, restricting cookie access to the exact origin host.

### 6.2 Cache-Control Protections on Sensitive Endpoints
All endpoints under `/v1/auth/*` unconditionally attach anti-caching response headers:
```http
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
Pragma: no-cache
Expires: 0
```
This ensures intermediary proxies, CDNs, corporate gateways, and local browser caches never persist authentication payloads, CSRF tokens, or session profiles.

---

## 7. Authentication Boundary Isolation

1. **Android Ingestion Device Isolation:**
   Device evidence ingestion (`POST /v1/ingestion/evidence`) authenticates strictly via `Authorization: Bearer bsk_dev_...` enforced by `DeviceAuthGuard`. Ambient browser session cookies (`bsk_session`) presented to device ingestion endpoints are rejected with `401 UNAUTHORIZED`.
2. **Developer API & Zapier Isolation:**
   External integrations authenticate via scoped API keys (`Authorization: Bearer bsk_live_...`). These requests bypass cookie CSRF validation (`authType === 'bearer'`), ensuring high-throughput automated operations remain unaffected.
3. **SMSGate Webhook Signing Independence:**
   SMSGate incoming cellular gateway webhooks authenticate via HMAC-SHA256 signature headers (`X-Signature`, `X-Timestamp`), completely isolated from user sessions.
4. **OAuth 2.0 PKCE Independence:**
   OAuth authorization code exchanges (`/v1/oauth/token`) utilize RFC 7636 PKCE code verifiers with single-use authorization codes, independent of merchant cookie sessions.

---

## 8. Verification Evidence & Test Execution

### 8.1 Dedicated Web Security Test Suite (`apps/api/test/web-session-and-csrf.test.ts`)
42 dedicated automated tests were executed covering all aspects of the hardening:
- **1. Cookie Security Attributes:** 3 tests (HttpOnly, production Secure, logout Max-Age=0).
- **2. Session Lifecycle & Invalidation:** 4 tests (cookie auth, 401 on expiration, 401 on revoked session, refresh rotation).
- **3. CSRF Protection for State-Changing Operations:** 5 tests (missing header, mismatched cookie, untrusted origin, valid execution, safe GET exemption).
- **4. Authentication Boundary Isolation:** 2 tests (device ingestion rejection of cookie auth, Bearer client preservation).
- **5. Login & Registration Cross-Site & Origin Protection:** 5 tests (cross-site login rejection, cross-site fetch-metadata rejection, cross-site register rejection, authorized origin login).
- **6. Refresh Endpoint CSRF, Rotation & Concurrency Safety:** 7 tests (untrusted origin refresh rejection, fetch-metadata cross-site rejection, missing CSRF token rejection, invalid CSRF token rejection, token rotation, revoked token replay rejection, concurrent race condition serialization).
- **7. CSRF Cryptographic Security & Malformed Token Defense:** 5 tests (expired token rejection, tampered signature rejection, malformed/non-hex rejection, oversized token rejection, production independent secret enforcement).
- **8. Production Origin, Deceptive Hostnames & CORS Security:** 7 tests (suffix attack rejection, subdomain attack rejection, null origin rejection, production localhost rejection, wildcard rejection, preflight untrusted origin omission, preflight authorized origin validation).
- **9. Cache-Control Security Headers on Sensitive Endpoints:** 4 tests (`no-store` headers on csrf, login, session, and refresh).

**Command:**
```bash
DATABASE_URL="postgresql://brisksms:brisksms_dev_secret@localhost:5433/brisksms_dev" \
PGHOST=/tmp PGPORT=5433 REDIS_URL="redis://localhost:6380" REDIS_SOCKET_PATH="/tmp/redis.sock" \
ENCRYPTION_MASTER_KEY="brisksms_dev_encryption_master_key_32_bytes_min!" \
JWT_ACCESS_SECRET="brisksms_dev_jwt_access_secret_32_bytes_minimum!" \
JWT_REFRESH_SECRET="brisksms_dev_jwt_refresh_secret_32_bytes_minimum!" \
CSRF_SECRET="brisksms_dev_csrf_secret_32_bytes_minimum_key!" \
bun test apps/api/test/web-session-and-csrf.test.ts
```

**Result:**
```text
bun test v1.4.2 (744846f84)

apps/api/test/web-session-and-csrf.test.ts:
✓ Web Console Session Security & CSRF Protection > 1. Cookie Security Attributes > sets HttpOnly, SameSite=Lax, and narrow Path on bsk_session upon login [451.27ms]
✓ Web Console Session Security & CSRF Protection > 1. Cookie Security Attributes > sets Secure attribute on all cookies in production mode [377.95ms]
✓ Web Console Session Security & CSRF Protection > 1. Cookie Security Attributes > clears all session cookies on logout with Max-Age=0 [375.11ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > authenticates GET /v1/auth/session using valid HttpOnly bsk_session cookie [347.17ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > rejects expired bsk_session cookie with 401 UNAUTHORIZED [302.90ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > rejects revoked bsk_session token after logout with 401 TOKEN_REVOKED [350.10ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > rotates refresh token and issues fresh cookies upon /v1/auth/refresh [344.61ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > rejects state-changing POST when X-CSRF-Token header is missing [361.32ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > rejects state-changing POST when X-CSRF-Token does not match bsk_csrf cookie [370.72ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > rejects request when Origin header is from an untrusted domain [325.87ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > accepts state-changing POST when valid CSRF token, cookie, and trusted origin are provided [386.59ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > allows safe GET requests to read data without requiring X-CSRF-Token header [348.34ms]
✓ Web Console Session Security & CSRF Protection > 4. Authentication Boundary Isolation > prevents browser cookie session from authenticating device ingestion endpoint [355.47ms]
✓ Web Console Session Security & CSRF Protection > 4. Authentication Boundary Isolation > preserves non-browser Bearer token API authentication without requiring cookies or CSRF [335.49ms]
✓ Web Console Session Security & CSRF Protection > 5. Login & Registration Cross-Site & Origin Protection > rejects cross-site login when Origin is from an untrusted domain with 403 CSRF_ORIGIN_MISMATCH [242.10ms]
✓ Web Console Session Security & CSRF Protection > 5. Login & Registration Cross-Site & Origin Protection > rejects cross-site login when Sec-Fetch-Site is cross-site with 403 CSRF_CROSS_SITE_FORBIDDEN [291.06ms]
✓ Web Console Session Security & CSRF Protection > 5. Login & Registration Cross-Site & Origin Protection > rejects cross-site registration when Origin is from an untrusted domain with 403 CSRF_ORIGIN_MISMATCH [235.76ms]
✓ Web Console Session Security & CSRF Protection > 5. Login & Registration Cross-Site & Origin Protection > rejects cross-site registration when Sec-Fetch-Site is cross-site with 403 CSRF_CROSS_SITE_FORBIDDEN [219.76ms]
✓ Web Console Session Security & CSRF Protection > 5. Login & Registration Cross-Site & Origin Protection > accepts login from authorized origin when valid CSRF token is provided [292.54ms]
✓ Web Console Session Security & CSRF Protection > 6. Refresh Endpoint CSRF, Rotation & Concurrency Safety > rejects cross-site refresh when Origin is from an untrusted domain with 403 CSRF_ORIGIN_MISMATCH [367.91ms]
✓ Web Console Session Security & CSRF Protection > 6. Refresh Endpoint CSRF, Rotation & Concurrency Safety > rejects cross-site refresh when Sec-Fetch-Site is cross-site with 403 CSRF_CROSS_SITE_FORBIDDEN [327.92ms]
✓ Web Console Session Security & CSRF Protection > 6. Refresh Endpoint CSRF, Rotation & Concurrency Safety > rejects cookie refresh when X-CSRF-Token header is missing [342.32ms]
✓ Web Console Session Security & CSRF Protection > 6. Refresh Endpoint CSRF, Rotation & Concurrency Safety > rejects cookie refresh when X-CSRF-Token is invalid or mismatched [318.85ms]
✓ Web Console Session Security & CSRF Protection > 6. Refresh Endpoint CSRF, Rotation & Concurrency Safety > rotates refresh token and invalidates old token upon successful refresh [309.76ms]
✓ Web Console Session Security & CSRF Protection > 6. Refresh Endpoint CSRF, Rotation & Concurrency Safety > strictly rejects reuse/replay of old revoked refresh token with 401 INVALID_TOKEN [305.49ms]
✓ Web Console Session Security & CSRF Protection > 6. Refresh Endpoint CSRF, Rotation & Concurrency Safety > prevents race condition: concurrent refresh requests cannot create multiple valid refresh branches [296.76ms]
✓ Web Console Session Security & CSRF Protection > 7. CSRF Cryptographic Security & Malformed Token Defense > rejects expired CSRF token [232.77ms]
✓ Web Console Session Security & CSRF Protection > 7. CSRF Cryptographic Security & Malformed Token Defense > rejects tampered CSRF token where signature does not match payload [257.41ms]
✓ Web Console Session Security & CSRF Protection > 7. CSRF Cryptographic Security & Malformed Token Defense > rejects malformed CSRF token with invalid separators, non-hex nonce, or invalid timestamp [254.99ms]
✓ Web Console Session Security & CSRF Protection > 7. CSRF Cryptographic Security & Malformed Token Defense > rejects oversized CSRF tokens exceeding 512 bytes [228.35ms]
✓ Web Console Session Security & CSRF Protection > 7. CSRF Cryptographic Security & Malformed Token Defense > enforces independent CSRF_SECRET in production and refuses to reuse JWT or encryption keys [261.95ms]
✓ Web Console Session Security & CSRF Protection > 8. Production Origin, Deceptive Hostnames & CORS Security > rejects deceptive origin suffix attacks (e.g. localhost:4200.evil.com) [247.19ms]
✓ Web Console Session Security & CSRF Protection > 8. Production Origin, Deceptive Hostnames & CORS Security > rejects deceptive origin subdomain attacks (e.g. evil-console.brisksms.co.tz) [279.88ms]
✓ Web Console Session Security & CSRF Protection > 8. Production Origin, Deceptive Hostnames & CORS Security > rejects null origin from sandboxed iframes or local files [244.75ms]
✓ Web Console Session Security & CSRF Protection > 8. Production Origin, Deceptive Hostnames & CORS Security > rejects localhost/127.0.0.1 in production mode unless explicitly configured in ALLOWED_ORIGINS [260.75ms]
✓ Web Console Session Security & CSRF Protection > 8. Production Origin, Deceptive Hostnames & CORS Security > rejects wildcard "*" in CORS_ORIGIN from being accepted as an authorized origin [240.53ms]
✓ Web Console Session Security & CSRF Protection > 8. Production Origin, Deceptive Hostnames & CORS Security > preflight OPTIONS with untrusted origin does NOT set Access-Control-Allow-Origin or Credentials [248.73ms]
✓ Web Console Session Security & CSRF Protection > 8. Production Origin, Deceptive Hostnames & CORS Security > preflight OPTIONS with authorized origin sets Allow-Origin, Allow-Credentials, and Vary: Origin [266.91ms]
✓ Web Console Session Security & CSRF Protection > 9. Cache-Control Security Headers on Sensitive Endpoints > sets Cache-Control: no-store and related headers on GET /v1/auth/csrf [251.04ms]
✓ Web Console Session Security & CSRF Protection > 9. Cache-Control Security Headers on Sensitive Endpoints > sets Cache-Control: no-store on POST /v1/auth/login [348.69ms]
✓ Web Console Session Security & CSRF Protection > 9. Cache-Control Security Headers on Sensitive Endpoints > sets Cache-Control: no-store on GET /v1/auth/session [321.96ms]
✓ Web Console Session Security & CSRF Protection > 9. Cache-Control Security Headers on Sensitive Endpoints > sets Cache-Control: no-store on POST /v1/auth/refresh [313.16ms]

 42 pass
 0 fail
Ran 42 tests across 1 file. [12.98s]
```

### 8.2 Full Monorepo Regression Run
```bash
bun test
```
```text
 428 pass
 0 fail
Ran 428 tests across 40 files. [63.65s]
```
All existing test suites across Milestone 1, 2, 2.5, 2.6, and 3 continue to pass with 100% success.

### 8.3 TypeScript Compilation
```bash
bun run build && cd apps/api && bun x tsc
```
- Status: **Exit 0**, clean compilation, zero type errors.

---

## 9. Residual Security Limitations & Operational Guidelines

1. **XSS Defense-in-Depth:**
   While server-managed `HttpOnly` cookies physically eliminate token theft via JavaScript access, an attacker who obtains arbitrary script execution could still trigger authenticated in-browser actions on behalf of the victim. Defense-in-depth requires configuring a strict Content Security Policy (CSP) header in web server configuration.
2. **Reverse Proxy SSL Header Trust:**
   Production deployments behind TLS-terminating proxies (Nginx, Cloudflare, Traefik) must ensure `X-Forwarded-Proto: https` is forwarded from trusted reverse proxy IP addresses only.
3. **Secret Rotation Strategy:**
   Rotating `CSRF_SECRET` invalidates in-flight CSRF tokens, requiring browser clients to refresh or re-fetch `/v1/auth/csrf`. Because `GET /v1/auth/csrf` is public and transparently called by `apiFetch()`, rotating `CSRF_SECRET` causes zero merchant downtime.

---

## 10. Final Acceptance Verdict

All 7 authentication lifecycle endpoints, login CSRF, refresh CSRF, origin whitelisting, cryptographic double-submit verification, and cache protections have been implemented, verified, and audited.

**Verdict:** **`READY FOR EXTERNAL SECURITY TESTING`**
