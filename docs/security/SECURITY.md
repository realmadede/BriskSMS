# Security Architecture & Operations Policy

**Last Synced:** 2026-11-16  
**Classification:** Production Security Standard (Synced with Current Runtime Implementation)  
**Target Systems:** API, Worker, Web Portal, Android Client, Database, Edge Network  

---

## 1. Core Security Tenets

1. **Security by Design:** Security controls are woven into the relational architecture, API middleware, and CI pipelines.
2. **Zero Trust Tenant Isolation:** Every data access path authenticates the caller and strictly scopes queries to the authenticated `organizationId`.
3. **Defense in Depth:** Multiple independent security barriers protect financial evidence: Edge WAF/CSP -> Rate Limiting -> JWT/CSRF & Keystore PoP Signature Verification -> Application RBAC -> Database Row Locks & Triggers.
4. **Least Privilege:** Services, database users, devices (`bsk_dev_...`), and developer/OAuth tokens (`bsk_live_...`, `bsk_at_...`) enforce strict boundary separation.

---

## 2. Authentication & Credential Management

### 2.1. User Authentication
- **Password Storage:** Passwords hashed using **`scrypt`** (`node:crypto` `scryptSync` with 16-byte random salt, stored as `scrypt:<salt>:<derivedKeyHex>`) and compared via `timingSafeEqual`. Legacy weak hashes (MD5, SHA1, plain SHA256) are banned; invited unactivated users have `passwordHash = undefined` (zero sentinel hashes).
- **Session & Refresh Tokens:**
  - **Access Token:** Short-lived JSON Web Token (JWT), valid for **15 minutes** (`900s`), signed with **HMAC-SHA256** (`HS256`) using `JWT_ACCESS_SECRET` (minimum 32 chars in production; fail-closed boot validation). Emitted in HttpOnly `bsk_session` cookie (and bearer payload for API clients).
  - **Refresh Token:** Opaque 256-bit cryptographic random string (`bsk_ref_...`), stored SHA-256 hashed in PostgreSQL `refresh_tokens`, valid for **30 days** (`2,592,000s`), transmitted via `HttpOnly; Secure (prod); SameSite=Strict; Path=/v1/auth` cookie (`bsk_refresh`).
  - **Rotation & Family Revocation:** Refresh exchanges execute under `SELECT ... FOR UPDATE`. Replaying an already-consumed token revokes the entire `family_id` and records active session `jti`s in durable `revoked_sessions` + Redis (`auth:revoked_jti:<jti>`). Every `authenticate()` check verifies active user status (`401 ACCOUNT_DEACTIVATED`) and active org membership (`403 FORBIDDEN`).
- **Multi-Factor Authentication (MFA):**
  - *Implementation Note:* `users.two_factor_secret` / `two_factor_enabled` schema columns exist for future TOTP (RFC 6238) rollout; mandatory TOTP challenge enforcement during login is deferred roadmap work.

### 2.2. Android Device Authentication
- Android devices do not use human username/password credentials (`bsk_dev_...` tokens only).
- **Pairing Ceremony (Two-Step Challenge-Response Proof-of-Possession):**
  1. Web dashboard generates a single-use enrollment token (`bsk_pair_...`, valid for 5 minutes) via `POST /v1/devices/pairing-token` and renders it as a QR payload.
  2. Android app scans the QR code and generates a hardware-backed EC P-256 (`secp256r1`) keypair in **Android Keystore**.
  3. **Challenge Issuance (`POST /v1/devices/pairing-challenge`):** The app submits `enrollmentToken`, its X.509 SPKI `publicKeyPem`, and allowed algorithms (`EC_P256`, `SHA256_ECDSA`). Backend validates key curve/size/uniqueness and issues a cryptographically random 256-bit single-use challenge (`device_pairing_challenges`, default TTL `120s`, capped by token expiry).
  4. **Local Proof Signing & Atomic Verification (`POST /v1/devices/pair`):** The app constructs the length-prefixed binary transcript (`BRISKSMS-DEVICE-PAIRING-POP-V1`), signs it with its Keystore EC P-256 private key (`SHA256withECDSA`), and submits the proof. Under strict row-level lock order (`pairing_tokens -> device_pairing_challenges -> devices`), the backend verifies bindings, expiry, key fingerprint, and ASN.1 DER ECDSA signature, atomically consumes both challenge and token, and issues a `bsk_dev_...` credential.
- **Threat Mitigations Built Into Enrollment:**
  - **Intercepted Pairing Token Attack:** Stealing a `bsk_pair_...` token fails without completing PoP for the bound key.
  - **Cross-Token / Cross-Org Substitution & Replay:** Challenges bind `sha256Hex(token)`, `organizationId`, `enrollmentId`, `challengeId`, `publicKeyFingerprint`, and `expiresAtIso`.
  - **Silent Key Replacement Prohibited:** Requests presenting `bsk_dev_...`, `deviceId`/`existingDeviceId`, or an already-registered `publicKeyFingerprint` receive HTTP `409` (`DEVICE_KEY_REPLACEMENT_FORBIDDEN` / `PUBLIC_KEY_ALREADY_REGISTERED`).
- **Payload Ingestion:** Paired devices authenticate with `bsk_dev_...` (verified via constant-time `timingSafeEqual` on SHA-256 hashes; revoked devices fail closed `403 DEVICE_REVOKED`).

### 2.3. Developer API Keys & OAuth 2.0 PKCE
- Developer API keys follow the prefix standard **`bsk_live_<random>`** and are stored SHA-256 hashed in `api_keys` (plaintext returned once upon creation).
- OAuth 2.0 (`/v1/oauth/*`) issues **`bsk_at_...`** access tokens and **`bsk_rt_...`** refresh tokens strictly enforcing **RFC 7636 PKCE `S256`** (`plain` rejected with `400 INVALID_REQUEST`), `https://` (or loopback dev) `redirect_uri` checks, and `clientSecret` validation on confidential clients.
- Platform catalog admin mutations (`/v1/admin/catalog/*`) require independent `PLATFORM_ADMIN_SECRET` verification via `X-Platform-Admin-Key` (`503 PLATFORM_ADMIN_UNCONFIGURED` / `403`).

---

## 3. Cryptography & Data Protection at Rest and in Transit

1. **In Transit:**
   - Reverse proxy / Cloudflare Edge terminates **TLS 1.3**, injects HSTS and CSP headers, and sanitizes `X-Forwarded-For` (`TRUST_PROXY=true`).
   - Android pairing/network client enforces HTTPS-only server endpoints (`PairingUrlValidator` & `EvidenceUploadAndPairingPolicyTest`). *(Certificate pinning and Edge WAF deployment are Phase 8 production infrastructure tasks.)*
2. **At Rest:**
   - Sensitive secrets (`webhook_endpoints.secret` encrypted via migration `20261116010000_encrypt_webhook_endpoint_secrets`, `messaging_accounts.encrypted_api_token`, `smsgate_signing_keys`) are encrypted application-side using **AES-256-GCM** (`encryptSecret` / `decryptSecret`) with independent 12-byte IVs and authenticated tags backed by `ENCRYPTION_MASTER_KEY`.
   - `processWebhookDeliveryJob` and `SmsGateProvider` validate destination URLs via `validateOutboundHttpUrl()` + `redirect: 'error'` to block SSRF into loopback, link-local (`169.254.169.254`), and RFC 1918 private subnets.

---

## 4. Webhook Security & Signatures

All outbound webhooks to merchant endpoints are cryptographically signed to prevent spoofing and tampering:
- Header: `X-BriskSMS-Signature: t=1730822400,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`
- Signature Formula:
  $$\text{v1} = \text{HMAC-SHA256}(\text{endpoint\_secret}, \text{timestamp} \parallel "." \parallel \text{json\_payload})$$
- Merchants verify that `timestamp` is within 300 seconds of current system time to block replay attacks.

---

## 5. Security Incident Response & Audit Logging

1. **Immutable Audit Trails:**
   - Every state change, authentication event, device pairing/revocation, and manual financial override writes to `audit_logs`.
   - Audit logs are append-only. No application role possesses `UPDATE` or `DELETE` privileges on this table.
2. **Anomaly Detection:**
   - *Not yet implemented:* automated device quarantine and owner email alerts on rate anomalies (e.g., a single device sending 100 payments in 1 minute). Today, revoked devices fail closed (`403 DEVICE_REVOKED`) and conflicting payment references are quarantined (`COLLISION_QUARANTINED`), but device rate anomalies are not detected automatically.
   - Brute-force login attempts are blocked using Redis-backed IP/Account rate limiters.
3. **Breach Notification Protocol:**
   - In accordance with the Tanzania Personal Data Protection Act (PDPA 2022), any confirmed security breach impacting personal data must be escalated to the Data Protection Officer (DPO) and reported to the PDPC within 72 hours.
   - Step-by-step procedure, containment controls and known gaps: [`docs/compliance/DATA_BREACH_RESPONSE_PLAN.md`](../compliance/DATA_BREACH_RESPONSE_PLAN.md).

---

## 6. SMSGate Inbound Webhook Identity, Tenant Binding & Key Rotation

### 6.1. Upstream Protocol Constraints & Invariants
- Upstream SMSGate application (Android client and private VPS) supports only **one active signing key** at any time (`webhooks.signing_key`). It does not support simultaneous dual-key generation.
- Upstream signs webhooks using `HMAC-SHA256(signing_key, rawBodyBytes + timestampStringBytes)`.
- Re-transmissions by upstream gateways will update `X-Timestamp` and therefore recompute `X-Signature`.

### 6.2. Receiver-Side Grace Period & Transition Model
To prevent dropped delivery receipts while an administrator reconfigures the physical Android device:
1. When a key is rotated via `rotateDeviceSigningKey` or `rotateGatewaySigningKey`, the old key is retained in `encrypted_prev_key` with a 24-hour grace period (`rotated_at`).
2. During this 24-hour transition window, BriskSMS resolves candidate keys as `[currentKey, previousKey]`. Webhooks signed by either key are accepted.
3. After 24 hours, `previousKey` is invalidated and only `currentKey` is accepted.
4. All key provisioning, rotation, and revocation actions are immutably logged to `audit_logs`.

### 6.3. Step-by-Step Production Key Rotation Procedure
1. **Initiate Rotation on BriskSMS:**
   - Administrator issues rotation request via authenticated management API:
     `POST /v1/messaging/devices/:deviceId/keys/rotate`
   - System generates or ingests a high-entropy secret (min 16 chars), stores it encrypted with AES-256-GCM in PostgreSQL, and preserves the active key as `previousKey`.
2. **Update Android Gateway Client:**
   - Open SMSGate on the physical Android relay device.
   - Navigate to **Settings > Webhooks > Signing Key**.
   - Enter the newly provisioned signing key and save.
3. **Verification:**
   - Outgoing delivery reports dispatched after the update are signed with the new key.
   - Any in-flight requests signed with the previous key during transit are honored seamlessly by the 24-hour grace period.
4. **Grace Period Expiry:**
   - After 24 hours, the receiver purges the previous key from active candidate evaluation.

### 6.4. Authoritative Tenant & Device Binding
- Incoming webhooks must NEVER trust request-supplied organization context (`?org=`, `x-organization-id`, or payload `organizationId`).
- The device ID (`rawPayload.deviceId`) is resolved against authoritative database records (`smsgate_signing_keys` and `devices`).
- If a device is registered to multiple organizations, resolution fails closed with `409 AMBIGUOUS_DEVICE_IDENTITY`.
- If a device is marked `REVOKED`, requests are rejected with `403 DEVICE_REVOKED`.
- Any caller-supplied routing hint is checked against the authoritative device binding; any mismatch is rejected with `403 TENANT_DEVICE_MISMATCH`.
- Target messages are verified to belong to the authoritative organization; cross-tenant updates are rejected with `403 TENANT_MESSAGE_MISMATCH`.

### 6.5. Durable Webhook Event Identity
- Deduplication keys must be deterministic across retries:
  $$\text{event\_fingerprint} = \text{SHA-256}(\text{orgId} \parallel ":" \parallel \text{deviceId} \parallel ":" \parallel \text{stableKey})$$
- Transport-ephemeral values (`X-Signature`, `X-Timestamp`, dynamic `new Date()`) are strictly **excluded** from the fingerprint.
- If upstream supplies an authoritative event ID (`id` or `eventId`), it is used as the stable key.
- Concurrency-safe deduplication is guaranteed via PostgreSQL `UNIQUE (event_fingerprint)` constraint and row locks inside an ACID database transaction.

---

## 7. Master Encryption Key (`ENCRYPTION_MASTER_KEY`) Provisioning Policy

1. **Entropy & Length Requirements:**
   - `ENCRYPTION_MASTER_KEY` must be a high-entropy secret consisting of at least 32 characters or a 64-character hexadecimal string (256-bit entropy).
2. **Fail-Closed Production Boot Guard:**
   - On startup, `validateProductionEncryptionConfig()` executes before any route handling.
   - In production (`NODE_ENV === 'production'`), the application immediately crashes with a fatal error if:
     - `ENCRYPTION_MASTER_KEY` is undefined, empty, or whitespace.
     - `ENCRYPTION_MASTER_KEY` matches any known CI, test, or development fallback string (e.g., `brisksms_ci_encryption_master_key_32_bytes_min!`).
     - Length is under 32 characters.
3. **Secret Injection:**
   - In production, `ENCRYPTION_MASTER_KEY` must be injected via secure container environment variables or cloud secret managers (e.g., HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager).
   - Master encryption keys must NEVER be committed to Git or exposed in logs.


