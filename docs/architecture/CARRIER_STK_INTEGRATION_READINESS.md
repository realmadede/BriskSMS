# BriskSMS Carrier STK Push Integration Readiness & Boundary Contract

**Document Status:** Authoritative Carrier Dispatch Boundary (P0 Hardened)  
**Scope:** Product A — Carrier STK / USSD Push Initiation (`apps/api/src/modules/stk-push/`)  
**Safety Posture:** **All outbound carrier dispatch adapters and inbound callback verifiers FAIL CLOSED by default.**

---

## 1. Executive Boundary Summary

BriskSMS does **not** claim or simulate live Mobile Network Operator (MNO) STK push integrations before official merchant contracts, API specifications, sandbox/production credentials, and callback signature verification mechanisms are onboarded and verified.

### Verified Code Boundaries (`apps/api/src/modules/stk-push/`)

1. **Outbound Dispatch Fail-Closed Registry (`StkAdapterRegistry`):**
   - `MpesaStkAdapter` (`MPESA`), `TigoStkAdapter` (`MIXX`), `AirtelStkAdapter` (`AIRTEL_MONEY`), and `HalopesaStkAdapter` (`HALOPESA`) explicitly declare `isConfigured = false` and return `{ outcome: 'UNCONFIGURED', success: false, code: 'PROVIDER_DISPATCH_DISABLED', retryable: false }`.
   - `UnsupportedStkAdapter` handles `TTCL_PESA`, `CRDB_BANK`, `NMB_BANK`, and `MANUAL_BANK_TRANSFER`, returning `{ outcome: 'UNSUPPORTED', success: false, code: 'UNSUPPORTED_STK_PROVIDER', retryable: false }`.
   - HTTP `POST /v1/payments/stk-push` maps these fail-closed outcomes to HTTP `503 PROVIDER_DISPATCH_DISABLED` (unconfigured MNOs) and HTTP `422 UNSUPPORTED_STK_PROVIDER` (unsupported rails). No `PENDING` checkout or `payment.stk.initiated` outbox event is created.
2. **Checkout Lifecycle State Machine (`StkPushStatus`):**
   - `INITIATING`: Reserved pre-dispatch state prior to/during outbound transport call.
   - `PENDING`: Carrier transport explicitly returned `{ outcome: 'ACCEPTED', success: true }`. Only `PENDING` checkouts may accept payment settlement via verified callbacks.
   - `DISPATCH_UNCERTAIN`: Transport timeout, network reset, HTTP 408/409/429/5xx, or ambiguous failure after dispatch may have left our network boundary. Returns HTTP `504 STK_DISPATCH_UNCERTAIN` (`retryable: false`); blocks blind duplicate retries.
   - `UNSUPPORTED`: Pre-dispatch fail-closed rejection (unconfigured or unsupported provider).
   - `FAILED`: Definitive pre-acceptance carrier rejection (`outcome: 'DEFINITIVE_FAILURE'`).
   - `CANCELLED` / `EXPIRED` / `SUCCESS`: Post-`PENDING` terminal states.
3. **No Fabricated References:**
   - `stk_push_transactions.provider_reference` stays strictly `NULL` at initiation time and is populated **only** by an authenticated provider callback (or explicit compliance dispute recording).
   - No synthetic `voda_`, `tigo_`, `airtel_`, or `halo_` checkout prefixes are fabricated.
4. **Org-Scoped Idempotency:**
   - `stk_push_transactions` enforces `UNIQUE (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL` alongside SHA-256 `request_fingerprint` verification (`409 IDEMPOTENCY_CONFLICT` on parameter mismatch).
   - Retrying with the same `Idempotency-Key` returns `PENDING`/`SUCCESS` idempotently without re-dispatching, or fails closed (`409 STK_DISPATCH_UNCERTAIN`, `503`, `422`, `502`) without re-invoking external carrier transports.
5. **Inbound Callback Verification (`CallbackVerifierRegistry`):**
   - All 8 `PaymentProvider` entries remain registered to `DisabledProviderCallbackVerifier` (`HTTP 403 PROVIDER_CALLBACK_DISABLED`).
   - `TestStkAdapter` and `TestCallbackVerifier` enforce `NODE_ENV !== 'production'` guards and are strictly test-only.
6. **MNP-Safe Explicit Provider Routing (`StkPushRequestDto.provider`):**
   - Because Tanzanian subscribers can port mobile numbers across networks under Mobile Number Portability (MNP), `POST /v1/payments/stk-push` accepts an optional explicit `provider` (`PaymentProvider`), recording `routingResolution: 'EXPLICIT'` and hashing `provider` into `request_fingerprint`.
   - When `provider` is omitted, `stkPushService` falls back to `inferCarrierHintFromPrefix(normalizedPhone)` (`routingResolution: 'PREFIX_HEURISTIC'`; legacy `detectTanzanianCarrier` deprecated). Callers serving ported customers should always pass `provider` explicitly.

---

## 2. Carrier Integration Readiness Matrix

*Strictly distinguishes verified repository facts from missing external contracts/unknowns. Nothing below is inferred or fabricated.*

| Provider (`PaymentProvider`) | Current Dispatch Adapter State | Current Callback Parser State | Callback Verifier State | Verified Contract in Repo? | Missing Onboarding / Technical Prerequisites |
|---|---|---|---|---|---|
| **Vodacom M-Pesa** (`MPESA`) | `MpesaStkAdapter` (`isConfigured = false` -> `UNCONFIGURED`, HTTP `503`) | Parses Daraja-style `{ Body: { stkCallback } }` & normalized JSON fields | `DisabledProviderCallbackVerifier` (HTTP `403`) | **Partial JSON shape only** (Daraja callback field names in `parseCallback`); **NO outbound initiation API contract** | Official Vodacom M-Pesa Tanzania commercial merchant/aggregator agreement; sandbox & production base URLs & endpoints; OAuth/session key exchange & RSA payload encryption spec; request/response schemas; official callback IP allowlist / mTLS / signature contract; carrier idempotency header spec |
| **Mixx by Yas / Tigo Pesa** (`MIXX`) | `TigoStkAdapter` (`isConfigured = false` -> `UNCONFIGURED`, HTTP `503`) | Generic placeholder field extractor (`checkoutId`, `transId`, `receiptNumber`, `currency`) | `DisabledProviderCallbackVerifier` (HTTP `403`) | **None** | Merchant onboarding approval; official Mixx by Yas B2B STK/USSD push API spec, base URLs, auth tokens/HMAC spec, request/response payloads, callback signature verification spec, and idempotency guarantees |
| **Airtel Money** (`AIRTEL_MONEY`) | `AirtelStkAdapter` (`isConfigured = false` -> `UNCONFIGURED`, HTTP `503`) | Generic placeholder field extractor (`transactionId`, `airtelMoneyId`, `code === '200'`, `currency`) | `DisabledProviderCallbackVerifier` (HTTP `403`) | **None** | Merchant KYB & Airtel Money Tanzania OpenAPI credentials; verified environment endpoints; OAuth2 / asymmetric encryption spec; exact STK initiation & query schemas; webhook HMAC/signature header spec; carrier idempotency behavior |
| **HaloPesa** (`HALOPESA`) | `HalopesaStkAdapter` (`isConfigured = false` -> `UNCONFIGURED`, HTTP `503`) | Generic placeholder field extractor (`transId`, `receiptNumber`, `code === '0'`, `currency`) | `DisabledProviderCallbackVerifier` (HTTP `403`) | **None** | Halotel merchant onboarding & API documentation; endpoints/environments; authentication scheme; request/response contracts; callback verification mechanism; idempotency contract |
| **TTCL Pesa** (`TTCL_PESA`) | `UnsupportedStkAdapter` (`UNSUPPORTED`, HTTP `422`) | Throws unsupported | `DisabledProviderCallbackVerifier` (HTTP `403`) | **None** (MSISDN `073x` carrier detection only) | Official TTCL Pesa merchant gateway availability determination and full API/webhook specification (if offered) |
| **CRDB / NMB / Manual Bank** (`CRDB_BANK`, `NMB_BANK`, `MANUAL_BANK_TRANSFER`) | `UnsupportedStkAdapter` (`UNSUPPORTED`, HTTP `422`) | Throws unsupported | `DisabledProviderCallbackVerifier` (HTTP `403`) | **Out of STK scope** (reconciled via Companion Relay, Direct API, or Manual Reconciliation) | N/A for STK push; bank API contracts would use dedicated bank integration adapters if onboarded |

---

## 3. Adapter Contract for Future Official Carrier Implementations

Every future carrier adapter implementing `StkPushAdapter` (`apps/api/src/modules/stk-push/adapters/stk-adapter.interface.ts`) **must** satisfy all of the following before `isConfigured` can become `true`:

1. **Credential Validation:** Validate all required environment/tenant secrets via validated config schemas before accepting traffic; keep `isConfigured = false` if any required credential, certificate, or endpoint is absent.
2. **Bounded Transport & SSRF Guard:** Use explicit connect/request timeouts shorter than worker/HTTP lock leases and validate outbound HTTPS destination URLs against SSRF/private-network rules.
3. **Explicit Outcome Classification (`StkDispatchOutcome`):**
   - Return `outcome: 'ACCEPTED', success: true, providerCheckoutId` **only** when the carrier API returns an authoritative HTTP 2xx acceptance confirmation.
   - Return `outcome: 'DEFINITIVE_FAILURE', success: false` **only** when the carrier guarantees rejection **prior** to queuing/prompting the subscriber.
   - Return `outcome: 'UNCERTAIN', success: false` (never `ACCEPTED`, never `DEFINITIVE_FAILURE`) on timeouts, network resets, HTTP 408/409/429/5xx, or unparseable carrier responses.
4. **Idempotency Propagation:** Forward `params.idempotencyKey` (or carrier-native `OriginatorConversationID` / request ID) on the outbound carrier request per that carrier's specification.
5. **Callback Verifier Pairing:** Never enable `isConfigured = true` for a carrier without simultaneously replacing `DisabledProviderCallbackVerifier` for that `PaymentProvider` with a cryptographically verified `ProviderCallbackVerifier` matching the official carrier webhook specification.
6. **Secret Redaction:** Never include API keys, bearer tokens, passwords, or private signing material in thrown errors or `StkInitiateResult.errorMessage`.
