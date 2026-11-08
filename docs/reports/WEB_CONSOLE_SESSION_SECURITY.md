# BriskSMS Engineering Report: Web Console Session Security Hardening

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Starting Checkpoint:** `53568040bada52a652ffa1a3a3df74ca2ccd4564`  
**Target:** Web Console Session Authentication & CSRF Hardening  
**Status:** **COMPLETED & VERIFIED (372 / 372 Tests Passing)**  
**Verdict:** **READY FOR EXTERNAL SECURITY TESTING**

---

## 1. Executive Summary & Baseline Audit

### 1.1 Baseline Vulnerability Assessment
Prior to this hardening phase, the merchant web console (`apps/web/src/console.html`) maintained authenticated sessions by writing raw JWT access and refresh tokens to browser `localStorage` under the key `brisksms_merchant_session`.

**Identified Security Weaknesses:**
1. **XSS Exfiltration Vulnerability:** Any client-side cross-site scripting (XSS) vulnerability or compromised third-party script could read raw authentication and refresh tokens directly from `window.localStorage`.
2. **Missing Ambient Cookie Protection:** Authentication was exclusively Bearer-based; the server did not emit or enforce browser-managed `HttpOnly`, `Secure`, or `SameSite` cookies.
3. **Absence of CSRF Defense:** Because the application relied on client-managed Bearer headers, transitioning to ambient cookie sessions without CSRF protection would expose merchants to Cross-Site Request Forgery (CSRF).
4. **Client-Controlled Session Termination:** Logout previously cleared local browser keys without reliably invalidating the underlying JWT JTI on the server side.

### 1.2 Scope & Boundaries Preserved
This security hardening was executed with strict adherence to architectural boundaries:
- **No Disruption to Non-Browser Clients:** Automated test suites, CLI tools, external developer API consumers (`bsk_live_...`), Zapier integrations, and Android ingestion devices (`bsk_dev_...`) continue to operate via `Authorization: Bearer <token>` without cookie or CSRF requirements.
- **Strict Device Ingestion Isolation:** Browser cookie sessions are explicitly rejected from device ingestion endpoints (`POST /v1/ingestion/evidence`).
- **Zero UI Regressions:** The Liquid Glass styling, layout, typography, navigation, and functionality of `console.html` remain intact.

---

## 2. Hardened Architecture & Implementation

### 2.1 Cookie Security Specification (`apps/api/src/core/cookies.ts`)

Three dedicated server-managed cookies were introduced, each tailored to a specific operational lifecycle:

| Cookie Name | Purpose | Flags | Scope / Path | Lifetime |
| :--- | :--- | :--- | :--- | :--- |
| **`bsk_session`** | Short-lived JWT access token | `HttpOnly; SameSite=Lax` | Path: `/` | 15 minutes (`Max-Age=900`) |
| **`bsk_refresh`** | High-entropy refresh token | `HttpOnly; SameSite=Strict` | Path: `/v1/auth` (Narrow) | 30 days (`Max-Age=2592000`) |
| **`bsk_csrf`** | Cryptographic CSRF verification token | `SameSite=Lax` (Readable by JS) | Path: `/` | 24 hours (`Max-Age=86400`) |

In production mode (`NODE_ENV === 'production'`), the `Secure` flag is unconditionally enforced across all cookies.

### 2.2 Cryptographic Double-Submit CSRF Defense

For state-changing operations (`POST`, `PUT`, `PATCH`, `DELETE`) submitted with ambient session cookies, the API enforces a multi-layered CSRF defense:

1. **Origin & Referer Validation:**
   - Every incoming request's `Origin` or `Referer` header is inspected against a strict whitelist configured via `FRONTEND_URL`, `CORS_ORIGIN`, or local development hosts (`localhost`, `127.0.0.1`).
   - Cross-origin requests from unapproved domains are rejected with `403 CSRF_ORIGIN_MISMATCH`.
2. **HMAC-SHA256 Token Signature:**
   - CSRF tokens are generated as `${randomToken}.${expiry}.${hmacSignature}`.
   - Tampered tokens, expired tokens, or tokens signed with an unapproved secret are rejected with `403 CSRF_TOKEN_INVALID`.
3. **Double-Submit Matching:**
   - The client must transmit the value of the `bsk_csrf` cookie in the `X-CSRF-Token` (or `X-XSRF-Token`) HTTP header.
   - Verification utilizes constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks.
4. **Exemption for Safe Methods & Bearer Clients:**
   - Idempotent read operations (`GET`, `HEAD`, `OPTIONS`) require no CSRF header.
   - Explicit non-browser clients transmitting `Authorization: Bearer <token>` are tagged with `authType: 'bearer'` and bypass CSRF checks, ensuring automated integrations remain unimpeded.

### 2.3 Server-Side Session Lifecycle & Revocation

- **Login & Registration (`POST /v1/auth/login`, `POST /v1/auth/register`):**
  - Generates cryptographic tokens, serializes `bsk_session`, `bsk_refresh`, and `bsk_csrf` as `Set-Cookie` response headers, and returns user/organization context alongside `csrfToken`.
- **Session Inspection (`GET /v1/auth/session`):**
  - Authenticates the caller via `bsk_session`, loads user and organization membership, and ensures a valid CSRF token is active.
- **Silent Refresh (`POST /v1/auth/refresh`):**
  - Accepts refresh requests with zero body payload if the `bsk_refresh` cookie is present.
  - Enforces database refresh token rotation, updates `revoked_at`, and emits fresh cookies for all three types.
- **Authoritative Logout (`POST /v1/auth/logout`):**
  - Revokes the JWT JTI in the PostgreSQL `revoked_sessions` table.
  - Revokes the refresh token in the `refresh_tokens` table.
  - Emits immediate cookie invalidation headers (`Max-Age=0`) for `bsk_session`, `bsk_refresh`, and `bsk_csrf`.

### 2.4 Merchant Console Hardening (`apps/web/src/console.html`)

- **Elimination of Local Storage Secrets:**
  - Removed all code persisting access and refresh tokens to `localStorage`.
  - Only non-sensitive tenant preferences (such as `brisksms_active_org_id`) are stored in client storage.
- **Ambient Cookie Transport:**
  - Wrapper function `apiFetch()` sets `credentials: 'include'` on every request, ensuring the browser automatically manages `HttpOnly` cookie transmission without exposing them to JavaScript.
- **Automatic CSRF Header Binding:**
  - Mutating operations (`POST`, `PUT`, `DELETE`) automatically extract the CSRF token from the `bsk_csrf` cookie (or fetch one via `GET /v1/auth/csrf`) and attach it as `X-CSRF-Token`.
- **Session Expiration & Sign Out Controls:**
  - Added visual "Sign Out" button in the console header.
  - Implemented `handleSessionExpired()` and `resetDashboardToBlank()` to immediately clear sensitive financial figures (balances, transaction feeds, review queues) from the DOM upon 401 expiration or explicit sign out.

---

## 3. Verification & Test Evidence

### 3.1 Dedicated Web Session & CSRF Test Suite

A comprehensive test suite was implemented in `apps/api/test/web-session-and-csrf.test.ts` covering:
1. **Cookie Attributes:** `HttpOnly`, narrow `Path`, `SameSite=Lax`, `SameSite=Strict`, and `Secure` enforcement in production.
2. **Session Lifecycle:** `GET /v1/auth/session` authentication, expired session rejection (401), revoked session rejection after logout (401 `TOKEN_REVOKED`), and cookie-based refresh token rotation.
3. **CSRF Enforcement:** Missing header rejection (403), mismatched cookie/header rejection (403), untrusted origin rejection (403), authorized mutating POST acceptance (201), and safe GET exemption (200).
4. **Boundary Isolation:** Ensuring cookie sessions cannot access device ingestion endpoints (`POST /v1/ingestion/evidence`), and preserving pure Bearer token API requests.

**Test Execution:**
```bash
bun test apps/api/test/web-session-and-csrf.test.ts
```

**Results:**
```text
bun test v1.4.2 (744846f84)

apps/api/test/web-session-and-csrf.test.ts:
✓ Web Console Session Security & CSRF Protection > 1. Cookie Security Attributes > sets HttpOnly, SameSite=Lax, and narrow Path on bsk_session upon login [382.12ms]
✓ Web Console Session Security & CSRF Protection > 1. Cookie Security Attributes > sets Secure attribute on all cookies in production mode [325.25ms]
✓ Web Console Session Security & CSRF Protection > 1. Cookie Security Attributes > clears all session cookies on logout with Max-Age=0 [350.03ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > authenticates GET /v1/auth/session using valid HttpOnly bsk_session cookie [324.77ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > rejects expired bsk_session cookie with 401 UNAUTHORIZED [288.93ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > rejects revoked bsk_session token after logout with 401 TOKEN_REVOKED [331.17ms]
✓ Web Console Session Security & CSRF Protection > 2. Session Lifecycle & Invalidation > rotates refresh token and issues fresh cookies upon /v1/auth/refresh [312.79ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > rejects state-changing POST when X-CSRF-Token header is missing [338.64ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > rejects state-changing POST when X-CSRF-Token does not match bsk_csrf cookie [329.54ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > rejects request when Origin header is from an untrusted domain [314.45ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > accepts state-changing POST when valid CSRF token, cookie, and trusted origin are provided [371.70ms]
✓ Web Console Session Security & CSRF Protection > 3. CSRF Protection for State-Changing Operations > allows safe GET requests to read data without requiring X-CSRF-Token header [339.21ms]
✓ Web Console Session Security & CSRF Protection > 4. Authentication Boundary Isolation > prevents browser cookie session from authenticating device ingestion endpoint [342.57ms]
✓ Web Console Session Security & CSRF Protection > 4. Authentication Boundary Isolation > preserves non-browser Bearer token API authentication without requiring cookies or CSRF [337.09ms]

 14 pass
 0 fail
Ran 14 tests across 1 file. [4.86s]
```

### 3.2 Monorepo Full Regression Test Run

The full monorepo test corpus was executed against live PostgreSQL 18 and Redis 7 instances:

```bash
bun test
```

**Results:**
```text
 372 pass
 0 fail
Ran 372 tests across 40 files. [50.31s]
```

Zero regressions across all existing Milestone 1, 2, 2.5, 2.6, and 3 suites.

### 3.3 TypeScript Compilation

```bash
bun run build && cd apps/api && bun x tsc
```
- Status: **Exit 0**, clean compilation, zero type errors.

---

## 4. Production Deployment & Security Guidelines

When deploying BriskSMS to production environments:

1. **Reverse-Proxy SSL Termination:**
   - Reverse proxies (Cloudflare, Nginx, AWS ALB) must forward `X-Forwarded-Proto: https` so the API accurately identifies secure connections.
2. **Fail-Closed Secrets Management:**
   - In production (`NODE_ENV === 'production'`), the API enforces that `CSRF_SECRET`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `ENCRYPTION_MASTER_KEY` are at least 32 characters in length and contain no development or CI defaults (`dev_`, `ci_`). If weak secrets are detected, process startup fails immediately.
3. **CORS & Origin Configuration:**
   - Set `FRONTEND_URL` and `CORS_ORIGIN` to the exact merchant domain (e.g., `https://console.brisksms.co.tz`). Never configure wildcard origins (`*`) alongside `credentials: true`.
4. **Security Invariant Notice:**
   - While `HttpOnly` cookies eliminate credential theft via script access, defense-in-depth requires maintaining strict Content Security Policy (CSP) headers to prevent unauthorized DOM manipulation in the event of an XSS flaw.

---

## 5. Audit Conclusion

With the removal of token storage from `localStorage`, implementation of server-managed `HttpOnly` session and refresh cookies, HMAC-SHA256 double-submit CSRF protection, origin validation, and synchronized database session revocation, the web console authentication system has met all enterprise security hardening criteria.

**Readiness Verdict:** `READY FOR EXTERNAL SECURITY TESTING`
