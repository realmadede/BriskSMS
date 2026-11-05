# Deployment Architecture & Operations Guide

**Environments:** Development (Local), Staging, Production  
**Cloud Providers:** Cloudflare (Edge, CDN, DNS, WAF), Hetzner / AWS (Compute & Storage)  
**Containerization:** Docker Compose / Kamal  

---

## 1. Environment Topology

```
+--------------------------------------------------------------------------------+
|                             Cloudflare Edge Network                            |
|             (SSL Termination, DDoS Mitigation, Geo-DNS, Cloudflare WAF)        |
+--------------------------------------------------------------------------------+
                      |                                       |
                      v                                       v
         [app.brisksms.co.tz]                        [api.brisksms.co.tz]
      (Cloudflare Pages / Angular SPA)           (Application Ingress / Reverse Proxy)
                                                              |
                                                              v
                                              +----------------------------------+
                                              |        Compute Node (Linux)      |
                                              |  - Docker Container: `api`       |
                                              |  - Docker Container: `worker`    |
                                              |  - Docker Container: `redis`     |
                                              +----------------------------------+
                                                              |
                                                              v
                                              +----------------------------------+
                                              |    Managed PostgreSQL Database   |
                                              |    (Automated Backups & PITR)    |
                                              +----------------------------------+
```

---

## 2. Local Development Environment

Local services are containerized via `docker-compose.yml`:
- **PostgreSQL 16:** Available on `localhost:5432`.
- **Redis 7:** Available on `localhost:6379`.

To start local services:
```bash
docker compose up -d
npm run db:migrate
npm run dev
```

---

## 3. Environment Variables & Secret Configuration

Production secrets must never be committed to Git. The `.env.example` template documents all required environment variables:

| Variable | Scope | Purpose |
|---|---|---|
| `NODE_ENV` | Global | `development`, `staging`, or `production`. |
| `PORT` | API | HTTP port for the NestJS API (default: `3000`). |
| `DATABASE_URL` | Global | PostgreSQL connection string with connection pool options. |
| `REDIS_URL` | Worker/API | Redis connection string for BullMQ and cache. |
| `JWT_SECRET` | Auth | Secret or private key used for signing JWT access tokens. |
| `ENCRYPTION_MASTER_KEY` | Security | 256-bit hexadecimal key for AES-256-GCM data encryption. |
| `BEEM_API_KEY` | Messaging | API credentials for Beem Africa SMS gateway. |
| `DARSMS_API_KEY` | Messaging | API credentials for DARSMS gateway. |
| `SENTRY_DSN` | Telemetry | Sentry error tracking endpoint. |

---

## 4. CI/CD Pipeline (GitHub Actions)

The deployment pipeline is automated via GitHub Actions:
1. **Pull Request Stage:**
   - Linting check (`npm run lint`).
   - TypeScript build check (`npm run build`).
   - Unit tests and parser corpus validation (`npm run test`).
   - Integration tests with ephemeral PostgreSQL container.
2. **Main Branch Deployment:**
   - Automated Docker image build and push to container registry.
   - Database migration execution (`npx prisma migrate deploy`).
   - Rolling restart of `api` and `worker` containers with zero downtime.
   - Sentry release tracking and source map upload.

---

## 5. Disaster Recovery & Backup Strategy

1. **PostgreSQL Snapshots:** Automated daily snapshots retained for 30 days.
2. **Point-in-Time Recovery (PITR):** Continuous Write-Ahead Logging (WAL) archiving allows restoring the database to any millisecond within the preceding 7 days.
3. **Disaster Recovery Target:**
   - Recovery Point Objective (RPO): < 5 minutes.
   - Recovery Time Objective (RTO): < 30 minutes.

