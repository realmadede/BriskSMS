# Coding Standards & Clean Architecture Rules

**Last Synced:** 2026-11-16  
**Primary Languages:** TypeScript `5.6+` (Backend, Worker, Packages), Kotlin `1.9.23` (Android / AGP `8.3.1` / Gradle `8.14.3`)  
**Paradigms:** Domain-Driven Modular Monolith, Functional Core / Imperative Shell  

---

## 1. Universal Clean Code Principles (Skarp Framework)

All development in BriskSMS adheres strictly to the four Karpathy Invariants from the Skarp Framework:

1. **Think Before Coding:**
   - Never guess or make assumptions on financial logic, database structures, or tenant boundaries.
   - Surface multiple interpretations and tradeoffs when requirements permit ambiguity.
   - Stop immediately if context is missing or contradictory.
2. **Simplicity First:**
   - Write the minimum concrete code required to solve the task.
   - Forbid speculative configurability, premature abstractions, and one-off helper wrappers.
   - Apply the Senior Engineer Smell Test: simplify before presenting solutions.
3. **Surgical Changes:**
   - Touch only files, functions, and lines directly within scope.
   - Zero orthogonal edits to adjacent whitespace, unrelated comments, or styles.
   - The Diff Test: Every line in git diff must demonstrably trace to the prompt.
4. **Goal-Driven Execution:**
   - Define declarative, verifiable outcomes upfront.
   - Formulate verification commands (`bun run typecheck`, `bun run build`, `bun run test`, `./gradlew testDebugUnitTest`) and verify before declaring completion.

### General Engineering Standards:
1. **Explicit Over Implicit:** Write clear, descriptive variable and function names. Avoid cryptic abbreviations.
2. **Fail Fast & Explicit Error Handling:** Never catch exceptions without handling or logging them. Use domain error classes (`BriskError`, `HttpException`, `DatabaseUnavailableError`, `RedisUnavailableError`).
3. **No Unsafe Type Assertions:** Avoid `any` in TypeScript. Validate inputs via explicit runtime type guards and canonical domain parsers (`normalizeTanzanianPhone`, `toMinorUnits`, `validateOutboundHttpUrl`) before processing.
4. **Preserve Comments & Documentation:** Maintain documentation integrity. Keep code comments accurate, clean, and directly tied to complex domain logic.

---

## 2. TypeScript & Modular Monolith Standards (`apps/api`, `apps/worker`, `packages/*`)

1. **Strict Mode:** Workspace `tsconfig.json` and `packages/config` enforce `"strict": true` with project references compiled via `tsc -b` (`bun run typecheck`).
2. **Modular Architecture (`apps/api/src/modules/`):**
   - Feature folders (`auth`, `developer`, `device`, `ingestion`, `messaging`, `oauth`, `organization`, `reconciliation`, `stk-push`, `subscription`) contain `*.controller.ts` route registrations (`Router`) and `*.service.ts` transactional services.
   - Respect dependency boundaries: `apps/*` depend on `packages/*`; `packages/*` must never import from `apps/*`.
3. **Input Validation & Security Boundaries:**
   - Route handlers validate required fields, sizes (1 MB router payload cap, `rawPayload <= 4096`), CSRF/Origin rules, and caller/tenant context explicitly before service invocation.
   - Never log raw payment SMS payloads, private keys, or secrets (`packages/db/src/logger.ts` `redactSensitiveData()`).

---

## 3. Kotlin & Android Standards (`apps/android`)

1. **Android Architecture & Toolchain Boundary:**
   - Pinned Gradle `8.14.3`, Android Gradle Plugin `8.3.1`, Kotlin/KAPT `1.9.23`, and Temurin JDK `17` (do not upgrade toolchains without coordinated CI verification).
   - Jetpack Compose UI obeying [`docs/skills/brisksms-design/SKILL.md`](../skills/brisksms-design/SKILL.md) Glisse tokens.
   - Room SQLite + WorkManager (`EvidenceUploadWorker`, `TelemetryWorker`) and Foreground Service (`SmsGateRelayService`) using Coroutines and `OkHttp`/`Gson`.
2. **Android Keystore Security:**
   - Asymmetric EC P-256 identity keys live inside `AndroidKeyStore` (`KeystoreManager.kt`), and sensitive tokens/pending job results use Keystore AES-256-GCM (`KeystoreSecureStorage.kt`).
   - Do not use `org.json.JSONObject` helpers in pure-JVM unit-tested parsing paths without Gson or explicit Robolectric coverage (`isReturnDefaultValues = true` stubs return `null`).
   - Never log raw SMS payloads or decrypted secrets in release builds.

---

## 4. Verification Before Merge

- Run `bun run typecheck && bun run build` and `bun run test` against PostgreSQL 16 + Redis 7.
- For Android changes, run `./gradlew testDebugUnitTest compileDebugKotlin assembleDebug --offline --no-daemon` using JDK 17.
