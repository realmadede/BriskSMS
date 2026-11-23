# Deployment Architecture & Operations Guide

**Last Synced:** 2026-11-16  
**Environments:** Development (Local), Staging, Production  
**Runtime:** Bun `1.4.2` / Node.js `20+` / `24`, PostgreSQL `16+`, Redis `7+`  

---

## 1. Environment Topology

```
+--------------------------------------------------------------------------------+
|                     Cloudflare / Edge TLS 1.3 Reverse Proxy                    |
|     (TLS Termination, WAF, CSP Injection, Sanitizes X-Forwarded-For Header)    |
+--------------------------------------------------------------------------------+
                      |                                       |
                      v                                       v
         [console.brisksms.app]                      [api.brisksms.app]
       (apps/web Static Portal :4200)            (apps/api Modular Monolith :3000)
                                                              |
                                                              v
                                              +----------------------------------+
                                              |        Compute Node (Linux)      |
                                              |  - Process/Container: `api`      |
                                              |  - Process/Container: `worker`   |
                                              |  - Private VPC: `redis` (No TLS) |
                                              +----------------------------------+
                                                              |
                                                              v
                                              +----------------------------------+
                                              |  Managed PostgreSQL 16+ (SSL)    |
                                              |  (53 Tables, 15 SQL Migrations)  |
                                              +----------------------------------+
```

- **Redis Transport Security Boundary:** `packages/db/src/redis.ts` uses raw TCP (`net.createConnection`) or local Unix domain sockets for `redis://` URLs, and TLS (`tls.connect` with SNI) for `rediss://` URLs. In staging and production, Redis **must** remain inside a private VPC / localhost; `rediss://` adds in-transit encryption but does not replace network isolation.
- **Reverse Proxy Trust Boundary:** Set `TRUST_PROXY=true` only when the upstream reverse proxy strips and overwrites `X-Forwarded-For` with the real client socket address.

---

## 2. Local Development Environment

Local services are orchestrated via `docker-compose.yml` (or host PostgreSQL 16 + Redis 7):
- **PostgreSQL 16:** Default `localhost:5432` (configurable via `DATABASE_URL`).
- **Redis 7:** Default `localhost:6379` (configurable via `REDIS_URL` / `REDIS_SOCKET_PATH`).

Common local workflow commands (Bun `1.4.2`):

```bash
bun install --frozen-lockfile
docker compose up -d postgres redis
bun run db:migrate
bun run db:seed
bun run db:status
bun run typecheck
bun run build
bun run test
bun run worker:start
```

---

## 3. Environment Variables & Secret Governance

Production secrets must never be committed to Git. See `.env.example` and [`ENVIRONMENT_VARIABLE_INVENTORY.md`](../reports/ENVIRONMENT_VARIABLE_INVENTORY.md) for the complete validated inventory. Core variables include:

| Variable | Scope | Fail-Closed Behavior / Purpose |
|---|---|---|
| `NODE_ENV` | Global | `development`, `staging`, or `production`. Enables strict boot & CSRF/origin checks. |
| `PORT` | API (`apps/api`) | HTTP listening port (default: `3000`). |
| `DATABASE_URL` | API / Worker / DB | PostgreSQL 16+ connection URI (`sslmode=require` recommended in staging/prod). |
| `REDIS_URL` | API / Worker / DB | Redis 7+ URI (`FORCE_TCP_REDIS=true` in containers). |
| `ENCRYPTION_MASTER_KEY` | API / Worker / DB | **Mandatory in prod.** 64-hex or >= 32-char AES-256-GCM key; rejects known defaults on boot. |
| `JWT_ACCESS_SECRET` | API (`apps/api`) | **Mandatory in prod.** Independent >= 32-char HMAC-SHA256 secret for `15m` access tokens. |
| `CSRF_SECRET` | API (`apps/api`) | **Mandatory in prod.** Independent >= 32-char secret for double-submit CSRF tokens (cannot equal JWT/AES keys). |
| `PLATFORM_ADMIN_SECRET` | API (`/v1/admin/catalog/*`) | Minimum 24 chars; fails closed `503 PLATFORM_ADMIN_UNCONFIGURED` when unset. |
| `ALLOWED_ORIGINS` / `FRONTEND_URL` | API (`apps/api`) | Exact allowed web origins for CORS & Login/Refresh CSRF defense (wildcard `*` forbidden). |
| `TRUST_PROXY` | API (`apps/api`) | `'true'` enables `X-Forwarded-For` client IP resolution in prod/staging behind a trusted proxy. |
| `ALLOW_PRIVATE_GATEWAY_NETWORKS` / `ALLOW_PRIVATE_WEBHOOK_NETWORKS` / `ALLOW_INSECURE_WEBHOOK_HTTP` | API / Worker | Keep `'false'` / unset in production to enforce SSRF & HTTPS webhook protections. |
| `STRICT_MIGRATION_CHECKSUMS` | `packages/db` | Defaults true in `NODE_ENV=production`; validates applied `_prisma_migrations` SHA-256 checksums. |

---

## 4. CI/CD Pipeline (`.github/workflows/ci.yml`)

GitHub Actions executes two automated verification jobs on push and pull request to `main`:

1. **`verify` (Monorepo Build & Integration Tests on `ubuntu-latest`):**
   - Spins up `postgres:16-alpine` (port `5433`) and `redis:7-alpine` (port `6380`).
   - Sets up Node.js `24` and Bun `1.4.2`, generates independent ephemeral `ENCRYPTION_MASTER_KEY`, `JWT_ACCESS_SECRET`, and `CSRF_SECRET`.
   - Runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`, `bun run db:migrate`, and `bun run test`.
2. **`android-verify` (Android Companion on `ubuntu-latest`):**
   - Sets up Temurin JDK `17` and Android SDK.
   - Runs `./gradlew --version`, `./gradlew projects --no-daemon`, `./gradlew testDebugUnitTest --no-daemon`, `./gradlew lintDebug --no-daemon`, and `./gradlew assembleDebug --no-daemon` under `set -e -o pipefail`, uploading logs and the debug APK artifact (`if-no-files-found: error`).

Container image publishing, multi-AZ production failover drills, and automated CD rollout pipelines remain planned deployment tasks (see [`STAGING_DEPLOYMENT_RUNBOOK.md`](../reports/STAGING_DEPLOYMENT_RUNBOOK.md)).

---

## 5. Disaster Recovery & Backup Objectives

1. **PostgreSQL Snapshots:** Automated daily snapshots retained for 30 days.
2. **Point-in-Time Recovery (PITR):** Continuous WAL archiving for sub-second transactional recovery.
3. **Recovery Targets:** RPO < 5 minutes, RTO < 30 minutes (validated via staging drills prior to production launch).
