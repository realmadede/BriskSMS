# Security Architecture & Operations Policy

**Classification:** Internal Production Security Standard  
**Target Systems:** API, Worker, Android Client, Database, Edge Network  

---

## 1. Core Security Tenets

1. **Security by Design:** Security controls are woven into the relational architecture, API middleware, and deployment pipelines from Day Zero.
2. **Zero Trust Tenant Isolation:** Every data access path must authenticate the caller and strictly scope queries to the authenticated `organizationId`. Cross-tenant data bleed is treated as a critical P0 incident.
3. **Defense in Depth:** Multiple independent security barriers protect financial evidence: Cloudflare Edge WAF -> API Rate Limiting -> JWT & Keystore Signature Verification -> Application RBAC -> Database Row Constraints.
4. **Least Privilege:** Services, database users, and human operators have access only to the exact resources required to perform their functions.

---

## 2. Authentication & Credential Management

### 2.1. User Authentication
- **Password Storage:** Passwords hashed using **Argon2id** (memory cost: 64 MB, iterations: 3, parallelism: 1). Legacy algorithms (MD5, SHA1, plain SHA256) are strictly banned.
- **Session Tokens:**
  - Access Token: Short-lived JSON Web Token (JWT), valid for 15 minutes, signed with RS256 or Ed25519 asymmetric keys.
  - Refresh Token: Opaque 256-bit cryptographic random string, stored hashed in PostgreSQL, valid for 7 days, transmitted via HTTP-only, Secure, SameSite=Strict cookies.
  - Token Rotation: Every refresh token exchange revokes the old token and issues a new one. Reusing a revoked refresh token triggers immediate invalidation of all active sessions for that user.
- **Multi-Factor Authentication (MFA):**
  - TOTP (RFC 6238) supported via authenticator apps (Google Authenticator, Authy).
  - Mandatory for all users holding `Owner`, `Admin`, or `Finance` roles.

### 2.2. Android Device Authentication
- Android devices do not use standard username/password authentication.
- **Pairing Ceremony:**
  1. Web dashboard generates a cryptographically signed QR code containing a single-use enrollment token (valid for 5 minutes).
  2. Android app scans the QR code and generates a P-256 keypair in the hardware-backed **Android Keystore**.
  3. The app submits its public key and enrollment token to `/v1/devices/enroll`.
  4. Backend verifies the enrollment token, binds the public key to the device ID, and issues a device credential.
- **Payload Signing:**
  - Every batch of relayed payment notifications is signed on-device using the Keystore private key (`SHA256withECDSA`).
  - Backend verifies the signature against the registered public key before accepting the payload.

### 2.3. Developer API Keys
- API keys follow the prefix standard: `bsk_live_[32 random alphanumeric characters]` (Production) and `bsk_test_[32 random alphanumeric characters]` (Sandbox).
- The raw key is shown to the developer **only once** upon generation.
- The database stores only the SHA-256 hash of the API key:
  ```sql
  CREATE TABLE api_keys (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(16) NOT NULL,
    label VARCHAR(100),
    permissions JSONB NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  );
  ```

---

## 3. Cryptography & Data Protection at Rest and in Transit

1. **In Transit:**
   - Strict TLS 1.3 requirement for all external communication.
   - HSTS (`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`) enforced at Cloudflare Edge.
   - Android client employs SSL certificate pinning against the API host.
2. **At Rest:**
   - Database volumes encrypted at rest with AES-256.
   - Sensitive third-party credentials (MikroTik passwords, WHMCS API secrets) are encrypted application-side using AES-256-GCM before writing to the database:
     $$\text{Ciphertext} = \text{AES-256-GCM}(\text{MasterKey}, \text{IV}, \text{Secret}, \text{OrgId})$$
   - Master encryption keys are injected via environment variables and managed securely outside the database.

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
   - Rate anomalies (e.g., a single device sending 100 payments in 1 minute) trigger automated device quarantine and email alerts to the organization owner.
   - Brute-force login attempts are blocked using Redis-backed IP/Account rate limiters.
3. **Breach Notification Protocol:**
   - In accordance with the Tanzania Personal Data Protection Act (PDPA 2022), any confirmed security breach impacting personal data must be escalated to the Data Protection Officer (DPO) and reported to the PDPC within 72 hours.
