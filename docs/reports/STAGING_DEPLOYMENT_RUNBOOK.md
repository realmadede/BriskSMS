# BriskSMS Engineering Runbook: Staging Deployment & Operational Procedures

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Branch:** `main`  
**Last Synced Against:** `e6c593d0f5bedd41939fd45c9f23082a1bada04b` + P0–P2 & Hard Audit Remediations  
**Scope:** Canonical, Step-by-Step Staging Deployment Runbook, Service Orchestration, Post-Deployment Verification, Rollback Protocols, and Disaster Recovery Procedures.

---

## 1. Prerequisites & Staging Infrastructure Topology

BriskSMS staging deploys as a **modular monolith** on a single isolated staging host or container group, with network-isolated managed state persistence:

```
[ Internet / Edge ]
        │
        ▼ (HTTPS / TLS 1.3)
[ Cloudflare / Nginx Reverse Proxy ]
        ├── staging-api.brisksms.app      ──▶ apps/api (Port 3000)
        └── staging-console.brisksms.app  ──▶ apps/web (Port 4200)
                                                    │
                                                    ▼
                                          [ apps/worker (BullMQ) ]
                                                    │
                   ┌────────────────────────────────┴───────────────────────────────┐
                   ▼ (TLS / SSL)                                                    ▼ (TCP / Private VPC)
       [ Managed PostgreSQL 16+ ]                                       [ Managed Redis 7+ ]
         (Database: brisksms_staging)                                     (Namespace: staging:bullmq)
```

### Staging Infrastructure Specifications & Limitations:
- **Compute Host (Operational Estimate):** 1x Linux Server (Ubuntu 22.04 / 24.04 LTS), 2 vCPU, 4 GB RAM. (Estimated runtime memory footprint: API ~150MB, Worker ~120MB, Web ~50MB, system overhead ~500MB).
- **Single-Node Availability Limitation:** A single-node compute staging deployment represents a **Single Point of Failure (SPOF)** with zero multi-AZ redundancy. This is acceptable for functional and integration staging, but is not suitable for high-availability production.
- **Runtimes:** Bun v1.4.2 (`packageManager`) and Node.js v20+ / v24+.
- **Database:** Managed PostgreSQL 16+ with SSL enabled (`sslmode=require`).
- **Cache & Queue:** Redis 7+ reachable over private VPC TCP network (`redis://...`) with password authentication. Note: The application runtime (`packages/db/src/redis.ts`) uses raw TCP `net.Socket` for `redis://` URLs and TLS (`tls.connect`) for `rediss://` URLs. Use `rediss://` if Redis traffic leaves the host.
- **Object Storage:** **None required.** BriskSMS persists all payment evidence in PostgreSQL (`raw_payment_evidence` table) as native JSONB.

---

## 2. Deployment Sequence (Step-by-Step)

Follow this strict chronological order during deployment. Never start worker or API processes before database migrations and catalog seeding are complete.

### Step 1: Clone Repository & Checkpoint Verification
```bash
# Clone the repository
git clone https://github.com/realmadede/BriskSMS.git /opt/brisksms
cd /opt/brisksms

# Verify clean status
git status
```

### Step 2: Install Dependencies & Build Workspace
```bash
# Install frozen dependencies via Bun
bun install --frozen-lockfile

# Compile TypeScript packages and bundle modular packages
bun run build

# Verify strict type safety across the monorepo
bun run typecheck
```

### Step 3: Configure Staging Environment Variables
Create `/opt/brisksms/.env` using the template from `docs/reports/STAGING_ENVIRONMENT_CONFIGURATION.md`.
```bash
cat << 'EOF' > /opt/brisksms/.env
NODE_ENV=production
PORT=3000
API_BASE_URL=https://staging-api.brisksms.app
FRONTEND_URL=https://staging-console.brisksms.app
ALLOWED_ORIGINS=https://staging-console.brisksms.app

DATABASE_URL=postgresql://brisksms_staging_user:STRONG_STAGING_PASSWORD@postgres-staging.internal:5432/brisksms_staging?sslmode=require
FORCE_TCP_POSTGRES=true
ALLOW_PRODUCTION_DB_RESET=false

REDIS_URL=redis://:STRONG_REDIS_PASSWORD@redis-staging.internal:6379
FORCE_TCP_REDIS=true

# Cryptographic secrets: Must be independently generated 64 hex character strings
ENCRYPTION_MASTER_KEY=REPLACE_WITH_GENERATED_64_HEX_AES_KEY
JWT_ACCESS_SECRET=REPLACE_WITH_GENERATED_64_HEX_JWT_SECRET
CSRF_SECRET=REPLACE_WITH_GENERATED_64_HEX_CSRF_SECRET

DISPATCH_PENDING_GRACE_SECONDS=60
DISPATCH_RECOVERY_INTERVAL_MS=30000

PROMOTIONAL_CURFEW_ENABLED=true
PROMOTIONAL_CURFEW_START_HOUR_EAT=20
PROMOTIONAL_CURFEW_END_HOUR_EAT=7
ALLOW_PRIVATE_GATEWAY_NETWORKS=false
BRISKSMS_SILENT_LOGS=false

# 7. Google Identity & Resend Transactional Email
GOOGLE_CLIENT_ID=replace_with_staging_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=replace_with_staging_google_client_secret
RESEND_API_KEY=re_replace_with_staging_resend_api_key
RESEND_FROM_EMAIL=BriskSMS Staging <verify@staging.brisksms.app>
EMAIL_VERIFICATION_EXPIRY_HOURS=24
EOF
```

> [!CAUTION]
> Ensure permissions are restricted: `chmod 600 /opt/brisksms/.env`.

### Step 4: Execute Database Migrations
Run the transactional migration runner against a fresh staging database. **15 sequential SQL migrations** must apply cleanly (`20261107000000_init_foundation` through `20261116010000_encrypt_webhook_endpoint_secrets`):
```bash
# Check current migration status
bun run db:status

# Apply pending Prisma SQL migrations
bun run db:migrate
```

### Step 5: Seed Commercial Catalog
Populate immutable plans, subscription quotas, feature flags, and currency definitions:
```bash
bun run db:seed
```
*Expected Output:*
```text
[BriskSMS DB] Seeding commercial catalog...
[BriskSMS DB] Features, products, and default subscription tiers seeded successfully.
```

### Step 6: Start Background Queue Worker (`apps/worker`)
The worker must be started before the API so it is ready to process outbox events and launch the `DispatchRecoveryRunner`:
```bash
bun run worker:start
```
*Verify Worker Logs:*
```text
[BriskSMS Worker] Connecting to Redis and PostgreSQL...
[BriskSMS Worker] Outbox dispatcher initialized.
[BriskSMS Worker] BullMQ queues registered: messaging_outbox, webhook_deliveries, events.
[BriskSMS Worker] Dispatch recovery runner registered (interval: 30000ms, grace: 60s).
```

### Step 7: Start API Modular Monolith (`apps/api`)
```bash
bun run apps/api/src/main.ts
```
*Verify API Logs:*
```text
[BriskSMS Crypto] Production encryption configuration validated successfully.
[BriskSMS API] Modular Backend listening on port 3000
[BriskSMS API] Health Endpoint: http://localhost:3000/v1/health
```

### Step 8: Start Merchant Web Console (`apps/web`)
```bash
bun run apps/web/server.ts
```
*Verify Web Logs:*
```text
[BriskSMS Web] Serving Stitch assets on port 4200
```

---

## 3. Reverse Proxy & Edge Routing Configuration

### Nginx Staging Configuration (`/etc/nginx/sites-available/brisksms-staging.conf`)
```nginx
# API Reverse Proxy
server {
    listen 443 ssl http2;
    server_name staging-api.brisksms.app;

    ssl_certificate /etc/letsencrypt/live/staging-api.brisksms.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging-api.brisksms.app/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# Web Console Reverse Proxy
server {
    listen 443 ssl http2;
    server_name staging-console.brisksms.app;

    ssl_certificate /etc/letsencrypt/live/staging-console.brisksms.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging-console.brisksms.app/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:4200;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

---

## 4. Health Verification & Smoke Tests

### Health Probe Verification
```bash
curl -s -i https://staging-api.brisksms.app/v1/health
```
*Expected HTTP Response (200 OK):*
```json
{
  "success": true,
  "data": {
    "status": "UP",
    "service": "@brisksms/api",
    "version": "1.0.0",
    "dependencies": {
      "process": { "status": "UP" },
      "postgresql": { "status": "UP" },
      "redis": { "status": "UP" },
      "worker": { "status": "UP" },
      "queues": { "status": "UP" }
    }
  }
}
```

### Smoke Test Sequence
1. **Merchant Registration:**
   ```bash
   curl -s -i -X POST https://staging-api.brisksms.app/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{"email":"staging-admin@example.com","password":"StagingPassword2026!","fullName":"Staging Admin","organizationName":"Staging Corp"}'
   ```
2. **Device QR Pairing Token:**
   ```bash
   curl -s -i -X POST https://staging-api.brisksms.app/v1/devices/pairing-token \
     -H "Content-Type: application/json" \
     -b cookies.txt
   ```
3. **Notification Evidence Ingestion:**
   ```bash
   curl -s -i -X POST https://staging-api.brisksms.app/v1/ingestion/evidence \
     -H "Authorization: Bearer bsk_dev_TEST_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"senderAddress":"MPESA","rawPayload":"0123456 Confirmed. Received Tsh 50,000...","simSlot":1,"deviceTimestamp":"2026-11-10T04:00:00Z"}'
   ```
4. **Authorized Payment Verification:**
   ```bash
   curl -s -i -X POST https://staging-api.brisksms.app/v1/reconciliation/verify \
     -H "Content-Type: application/json" \
     -b cookies.txt \
     -d '{"paymentId":"PAYMENT_UUID","verificationMethod":"MANUAL_FINANCE_APPROVAL"}'
   ```
5. **SMSGate Inbound Delivery Webhook:**
   ```bash
   curl -s -i -X POST https://staging-api.brisksms.app/v1/messaging/webhooks/smsgate \
     -H "X-Signature: HMAC_SIGNATURE" \
     -H "X-Timestamp: 1794260000" \
     -H "Content-Type: application/json" \
     -d '{"messageId":"MSG_UUID","status":"DELIVERED"}'
   ```
6. **Email Verification Token Consumption:**
   ```bash
   curl -s -i -X POST https://staging-api.brisksms.app/v1/auth/verify-email \
     -H "Content-Type: application/json" \
     -d '{"token":"bsk_ev_TOKEN_FROM_EMAIL"}'
   ```
7. **Google Identity Sign-In (OpenID Connect SSO):**
   ```bash
   curl -s -i -X POST https://staging-api.brisksms.app/v1/auth/google \
     -H "Content-Type: application/json" \
     -d '{"idToken":"VALID_GOOGLE_ID_TOKEN"}'
   ```

---

## 5. Rollback Protocols

### 5.1 Application Code Rollback
1. Stop API and Worker services:
   ```bash
   systemctl stop brisksms-api brisksms-worker
   ```
2. Checkout previously accepted Git commit:
   ```bash
   git checkout <PREVIOUS_STABLE_COMMIT>
   bun install --frozen-lockfile
   bun run build
   ```
3. Restart services:
   ```bash
   systemctl start brisksms-worker brisksms-api
   ```
4. Verify health via `curl -s https://staging-api.brisksms.app/v1/health`.

### 5.2 Database Migration Rollback Considerations
- **Transactional Rollback:** All BriskSMS migrations execute within explicit PostgreSQL ACID transactions (`withTransaction` in `packages/db/src/migrate.ts`). If any SQL statement fails during execution, PostgreSQL rolls back all schema changes in that migration automatically.
- **Applied Migration Rollback:** If a committed migration introduces a schema defect:
  - Do **NOT** use `db:reset:dev` (hard-blocked in staging/production by `ALLOW_PRODUCTION_DB_RESET=false`).
  - Draft a forward-compensating migration file in `packages/db/prisma/migrations/<timestamp>_revert_<name>/migration.sql`.
  - Apply the compensating migration with `bun run db:migrate`.

---

## 6. Disaster Recovery & Data Persistence

1. **PostgreSQL Backups:**
   - Automated daily snapshots configured at the database provider level.
   - Point-in-time recovery (PITR) enabled with 7-day retention.
   - Manual pre-deployment logical dump:
     ```bash
     pg_dump $DATABASE_URL --format=custom --file=/opt/backups/brisksms_staging_$(date +%Y%m%d_%H%M%S).dump
     ```
2. **Redis Persistence:**
   - Staging Redis must be configured with Append-Only File (`appendonly yes`) and RDB snapshots at the Redis daemon level to ensure queue jobs and rate-limit counters survive container restarts.
3. **Emergency Signing-Key Rotation:**
   - If an SMSGate gateway key is compromised:
     - Generate a new 32-byte hex secret.
     - Invoke `smsGateKeyService.setDeviceSigningKey(orgId, deviceId, newSecret)`.
     - The previous key remains valid for the grace window to prevent dropping in-flight delivery webhooks.
     - Once the physical device is updated, revoke the previous key.

---

## 7. Implementation Blockers

The following items block production release:
1. **Google Sign-In credentials:** The code exists (`POST /v1/auth/google/nonce`, `POST /v1/auth/google`), but a Google Cloud OAuth Web Client ID for the staging origin has not been provisioned.
2. **Resend email credentials:** The code exists (`apps/api/src/modules/auth/providers/resend.provider.ts`), but a Resend API key and DKIM/SPF/DMARC records for the staging sender domain have not been provisioned.
3. **Physical Cellular Hardware:** Staging deployment is blocked pending physical Android phones and live Tanzanian carrier SIM cards.
