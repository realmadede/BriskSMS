# BriskSMS Engineering Runbook: Staging Deployment & Operational Procedures

**Repository:** `https://github.com/realmadede/BriskSMS`  
**Branch:** `main`  
**Checkpoint:** `a80f99846b0d9e7ad3c5e886982e05244ad2d363` (origin/main: `c7b4a50ab8ad636996f328645be2d18517230bd2`)  
**Scope:** Canonical, Step-by-Step Staging Deployment Runbook, Service Orchestration, Post-Deployment Verification, Rollback Protocols, and Disaster Recovery Procedures.

---

## 1. Prerequisites & Staging Infrastructure Topology

BriskSMS staging deploys as a **modular monolith** on a single isolated staging host or container group, with network-isolated managed state persistence:

```
[ Internet / Edge ]
        │
        ▼ (HTTPS / TLS 1.3)
[ Cloudflare / Nginx Reverse Proxy ]
        ├── staging-api.brisksms.com      ──▶ apps/api (Port 3000)
        └── staging-console.brisksms.com  ──▶ apps/web (Port 4200)
                                                    │
                                                    ▼
                                          [ apps/worker (BullMQ) ]
                                                    │
                   ┌────────────────────────────────┴───────────────────────────────┐
                   ▼ (TLS / SSL)                                                    ▼ (TLS / Auth)
       [ Managed PostgreSQL 16+ ]                                       [ Managed Redis 7+ ]
         (Database: brisksms_staging)                                     (Namespace: staging:bullmq)
```

### Staging Infrastructure Minimum Requirements:
- **Compute Host:** 1x Linux Server (Ubuntu 22.04 / 24.04 LTS), 2 vCPU, 4 GB RAM.
- **Runtimes:** Bun v1.4.2 (`packageManager`) and Node.js v20+ / v24+.
- **Database:** Managed PostgreSQL 16+ with SSL enabled (`sslmode=require`).
- **Cache & Queue:** Managed Redis 7+ with password authentication and TLS (`rediss://`).
- **Object Storage:** **None required.** BriskSMS persists all payment evidence in PostgreSQL (`raw_payment_evidence` table) as native JSONB.

---

## 2. Deployment Sequence (Step-by-Step)

Follow this strict chronological order during deployment. Never start worker or API processes before database migrations and catalog seeding are complete.

### Step 1: Clone Repository & Checkpoint Verification
```bash
# Clone the repository
git clone https://github.com/realmadede/BriskSMS.git /opt/brisksms
cd /opt/brisksms

# Checkout the accepted checkpoint
git checkout a80f99846b0d9e7ad3c5e886982e05244ad2d363

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
API_BASE_URL=https://staging-api.brisksms.com
FRONTEND_URL=https://staging-console.brisksms.com
ALLOWED_ORIGINS=https://staging-console.brisksms.com

DATABASE_URL=postgresql://brisksms_staging_user:STRONG_STAGING_PASSWORD@postgres-staging.internal:5432/brisksms_staging?sslmode=require
FORCE_TCP_POSTGRES=true
ALLOW_PRODUCTION_DB_RESET=false

REDIS_URL=rediss://:STRONG_REDIS_PASSWORD@redis-staging.internal:6379
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
EOF
```

> [!CAUTION]
> Ensure permissions are restricted: `chmod 600 /opt/brisksms/.env`.

### Step 4: Execute Database Migrations
Run the transactional migration runner against the staging database:
```bash
# Check current migration status
bun run db:status

# Apply pending Prisma SQL migrations
bun run db:migrate
```
*Expected Output:*
```text
[BriskSMS DB] Checking migration status...
[BriskSMS DB] Applied migration: 20261107000000_init_foundation
[BriskSMS DB] Applied migration: 20261107010000_smsgate_keys_and_webhook_events
[BriskSMS DB] Applied migration: 20261109000000_durable_message_idempotency
[BriskSMS DB] Migrations up to date.
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
# Using systemd or daemon supervisor:
# systemctl start brisksms-worker
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
# Using systemd or daemon supervisor:
# systemctl start brisksms-api
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
# Using systemd or daemon supervisor:
# systemctl start brisksms-web
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
    server_name staging-api.brisksms.com;

    ssl_certificate /etc/letsencrypt/live/staging-api.brisksms.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging-api.brisksms.com/privkey.pem;
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
    server_name staging-console.brisksms.com;

    ssl_certificate /etc/letsencrypt/live/staging-console.brisksms.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staging-console.brisksms.com/privkey.pem;
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
Execute an unauthenticated probe to the health endpoint:
```bash
curl -s -i https://staging-api.brisksms.com/v1/health
```

*Expected HTTP Response (200 OK):*
```json
HTTP/2 200 
content-type: application/json; charset=utf-8

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
      "queue": { "status": "UP" }
    }
  }
}
```

### Smoke Test: Merchant Registration & Session Security
```bash
# Register a test organization
curl -s -i -X POST https://staging-api.brisksms.com/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"staging-admin@example.com","password":"StagingPassword2026!","orgName":"Staging Corp"}'
```
*Verification Check:*
- Response status: `201 Created`
- Header `Set-Cookie` contains `bsk_session` (`HttpOnly; Secure; SameSite=Lax`).
- Header `Set-Cookie` contains `bsk_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/v1/auth`).
- Header `Set-Cookie` contains `bsk_csrf` (`Secure; SameSite=Lax`).

---

## 5. Rollback Protocols

### 5.1 Application Code Rollback
If a regression is identified post-deployment:
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
4. Verify health via `curl -s https://staging-api.brisksms.com/v1/health`.

### 5.2 Database Migration Rollback Considerations
- **Transactional Rollback:** All BriskSMS migrations execute within explicit PostgreSQL ACID transactions (`withTransaction` in `packages/db/src/migrate.ts`). If any SQL statement fails during execution, PostgreSQL rolls back all schema changes in that migration automatically.
- **Applied Migration Rollback:** If a committed migration introduces a schema defect:
  - Do **NOT** use `db:reset:dev` (hard-blocked in staging/production by `ALLOW_PRODUCTION_DB_RESET=false`).
  - Draft a forward-compensating migration file in `packages/db/prisma/migrations/<timestamp>_revert_<name>/migration.sql`.
  - Apply the compensating migration with `bun run db:migrate`.

### 5.3 Queue & Ephemeral State Drain
- In the event of a worker crash or poison job in BullMQ:
  - Active jobs are guarded by a 30-second lock renewal.
  - Stalled jobs are automatically reclaimed by healthy worker processes.
  - Inspect failed jobs using Redis CLI:
    ```bash
    redis-cli -u $REDIS_URL LLEN staging:bullmq:messaging_outbox:failed
    ```

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
   - Staging Redis must be configured with Append-Only File (`appendonly yes`) and RDB snapshots to ensure queue jobs and rate-limit counters survive container restarts.
3. **Emergency Signing-Key Rotation:**
   - If an SMSGate gateway key is compromised:
     - Generate a new 32-byte hex secret.
     - Invoke `smsGateKeyService.setDeviceSigningKey(orgId, deviceId, newSecret)`.
     - The previous key remains valid for the grace window to prevent dropping in-flight delivery webhooks.
     - Once the physical device is updated, revoke the previous key.
