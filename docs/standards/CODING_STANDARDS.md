# Coding Standards & Clean Architecture Rules

**Primary Languages:** TypeScript 5.5+ (Backend/Frontend), Kotlin 2.0+ (Android)  
**Paradigms:** Domain-Driven Design (DDD), Modular Monolith, Functional Core / Imperative Shell  

---

## 1. Universal Clean Code Principles

1. **Explicit Over Implicit:** Write clear, descriptive variable and function names. Avoid cryptic abbreviations.
2. **Fail Fast & Explicit Error Handling:** Never catch exceptions without handling or logging them. Avoid empty `catch {}` blocks. Use custom domain error classes.
3. **No Unsafe Type Assertions:** Avoid `any` in TypeScript. Use `unknown` and validate with runtime type guards or Zod schemas before casting.
4. **Preserve Comments & Documentation:** Maintain documentation integrity. Keep code comments accurate, clean, and directly tied to complex domain logic.

---

## 2. TypeScript & NestJS Standards

1. **Strict Mode:** `tsconfig.json` must enforce `"strict": true`, `"noImplicitAny": true`, `"strictNullChecks": true`.
2. **Modular Architecture:**
   - Feature folders in `apps/api/src/modules/` contain their own `controller`, `service`, `module`, `dtos`, and `repositories`.
   - Never import directly across module internal files; import only exported services from the sibling module.
3. **Validation Pipes:**
   - All inbound controller payloads must be validated using `class-validator` / `class-transformer` or `ZodValidationPipe`.
   - Strip unknown properties: `{ whitelist: true, forbidNonWhitelisted: true }`.
4. **Dependency Injection:**
   - Leverage NestJS constructor dependency injection.
   - Inject repository and logger interfaces rather than instantiating classes directly.

---

## 3. Kotlin & Android Standards

1. **Modern Android Architecture:**
   - Jetpack Compose for all user interfaces.
   - MVVM / MVI pattern using `ViewModel` and Kotlin `StateFlow`.
   - Coroutines for asynchronous work; never block the main thread.
2. **WorkManager & Background Execution:**
   - Use `WorkManager` with `Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED)` for guaranteed background synchronization.
   - Use Android `ForegroundService` with a persistent notification for critical real-time notification listeners.
3. **Android Keystore Security:**
   - All cryptographic keys must be stored in the hardware-backed `AndroidKeyStore`.
   - Never log raw SMS payloads or decrypted messages to logcat in production builds (`if (BuildConfig.DEBUG) ...`).

---

## 4. Linting & Formatting Standards

1. **Prettier:** Enforced via `.prettierrc` (2 spaces, single quotes, trailing commas, 100 character print width).
2. **ESLint:** Configured with `@typescript-eslint` recommended rules. Unused variables and unresolved promises are treated as errors.
3. **Git Pre-Commit Hook:** Husky / lint-staged runs linter and formatting checks automatically before commits.

