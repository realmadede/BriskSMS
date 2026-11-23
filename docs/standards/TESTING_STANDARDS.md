# Testing Standards & Quality Assurance Strategy

**Last Synced:** 2026-11-16  
**Test Frameworks:** `bun test` with `node:test` & `node:assert/strict` (Backend, Worker, Web, Shared Packages), JUnit 4 (`4.13.2`) + Mockito/OkHttp MockWebServer (Android JVM Unit Tests), Playwright E2E *(Deferred Phase 7+/8)*  
**Current Verified Baseline:** `544` passing tests across `41` workspace files (`bun run test`, verified 2026-11-17 on PostgreSQL 18 with all 15 migrations) + `10` Android unit test classes (`41` `@Test` methods)  

---

## 1. Testing Pyramid

```
           / \
          /   \
         / E2E \         [Planned] Live Browser Playwright Journeys + Physical SIM Field Trials
        /-------\
       /  Integ  \       Live PostgreSQL 16 + Redis 7 Integration Tests (apps/api, apps/worker, packages/db)
      /-----------\
     /  Contract & \     HTTP Router Security, Web Server Hardening, Android OkHttp/PoP Unit Suites
    /    Unit       \    Parser Corpus, Exact BigInt Currency Math, Crypto/SSRF, UI Refraction, Zapier
   /-----------------\
```

---

## 2. Unit Testing Standards

1. **Parser Test Corpus (`packages/parser-engine/test/engine.test.ts` & Android `PaymentProviderRegistryTest.kt`):**
   - Validate anonymized provider notifications across Vodacom M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, and CRDB Bank on the server `ParserEngine`, plus Android source-eligibility filtering.
   - Cover standard transactions, Lipa/Paybill memos, single-decimal amounts, personal-phone spoofing rejection, outgoing transfer rejection, malformed strings, and stable deduplication hashing.
2. **Financial & Security Primitives:**
   - Cover `toMinorUnits` exact decimal parsing, Tanzanian phone normalization (`061`/`077` included), AES-256-GCM encryption/decryption, SSRF URL blocking (`validateOutboundHttpUrl`), and Android Proof-of-Possession transcripts (`DevicePairingProofOfPossessionTest.kt`).

---

## 3. Integration Testing Standards (`apps/api/test/`, `apps/worker/test/`, `packages/db/test/`)

1. **Database & Concurrency Integration:**
   - Integration suites execute directly against live **PostgreSQL 16** (port `54322` locally / `5433` in CI) and **Redis 7** (port `6379` / `6380`).
   - Verify tenant isolation (`CROSS_ORGANIZATION_FORBIDDEN`, `TENANT_DEVICE_MISMATCH`), append-only trigger immutability (`prevent_immutable_record_mutation`, `trg_claim_events_immutable`), concurrent lock serialization (`pg_advisory_xact_lock`, `FOR UPDATE`, `FOR UPDATE SKIP LOCKED`), fail-closed subscription verification, and idempotent worker credit refunds.
   - Always run `bun run test` via file-scoped suite directories so compiled `dist/` files are never double-executed.
   - Clear shared IP rate-limit buckets (`await authService.clearRateLimits()`) in `beforeEach` for multi-test HTTP auth suites sharing synthetic loopback/socket IPs.

---

## 4. Android & Web Verification Standards

- **Android (`apps/android/`):** Run under Temurin JDK `17` via `./gradlew testDebugUnitTest compileDebugKotlin assembleDebug --offline --no-daemon` (covering all 10 JUnit classes / 41 `@Test` methods plus APK assembly). Physical device instrumented tests (`androidTest`) remain a Phase 8 hardware prerequisite.
- **Web Portal (`apps/web/test/web-server.test.ts`):** Verify Node HTTP route status codes, security headers, `/assets/` encoded/unencoded path traversal blocking, XSS escaping, CSV/SpreadsheetML parsing honesty, and REST docs alignment.

---

## 5. CI Enforcement

GitHub Actions (`.github/workflows/ci.yml`) runs `bun run typecheck`, `bun run build`, `bun run db:migrate`, and `bun run test` against PostgreSQL 16 + Redis 7 in job `verify`, plus `./gradlew testDebugUnitTest`, `lintDebug`, and `assembleDebug` in job `android-verify`.
