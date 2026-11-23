# Platform Billing Plan: BriskSMS as Its Own Payee

Status (22 November 2026): steps 1 to 4 are built, step 5 is built in the API only, step 6 is not started. Sections 3 and 4 describe the original design. Where the built design differs, the "Correction" section governs. Activation is atomic with verification, so the retry fallback is not needed.

| Step | State |
|---|---|
| 1. Billing workspace setting and evidence lookup | Built |
| 2. `/nexus` billing workspace field, payment instructions, platform audit | Built |
| 3. Payment request, one invoice in the billing workspace, activation when it is paid | Built |
| 4. Console payment request panel for paid plans | Built |
| 5. Credit packs and credit purchase | Built: API, migration, tests, the `/nexus` credit packs tab and the console "Buy SMS credits" card. The two screens were checked in headless Chrome against a stubbed API, not yet end to end with a real payment |
| 6. Aggregator settings, routing table, single adapter | Not started |
Scope: subscription payments, SMS credit purchases, and a single carrier-agnostic STK push gateway.

Basis: the repository audit of the payment, subscription, messaging and STK push modules. Items marked "to confirm" were not read in full and must be checked before coding.

## 1. Problem

1. Subscription checkout verifies the customer's payment reference only inside the customer's own organization (`apps/api/src/modules/subscription/subscription.service.ts`, the evidence queries filter on `organization_id = <customer org>`). BriskSMS has no receiving workspace of its own, so a customer can satisfy checkout with evidence from their own workspace.
2. `messaging.service.purchaseCredits` has no HTTP route. Only tests call it, so customers cannot buy SMS credits.
3. STK push has one adapter class per carrier (`apps/api/src/modules/stk-push/adapters/`: M-Pesa, Mixx, Airtel, HaloPesa, and unsupported stubs). Every adapter fails closed. Negotiating and integrating each carrier separately is not practical.

## 2. Non-negotiable rules this plan keeps

- SMS evidence never auto-settles. A payment becomes `VERIFIED` only through human-attested verification or a provider-authenticated callback.
- Raw evidence stays immutable and append-only.
- Product A (payment intelligence) and Product B (bulk messaging) keep separate ledgers. Reconciliation never needs messaging credits.
- BriskSMS is non-custodial for customer money. It only receives money that customers owe BriskSMS (subscriptions and credits).
- Prices, packs, limits and provider settings are configured on `/nexus`. Nothing is hardcoded.

## 3. Step 1: Platform billing workspace

### Design
1. A platform setting, "billing workspace", holds one organization id. It is set on `/nexus` through a platform-admin route. When unset, paid checkout fails closed with a clear error. The free tier is unaffected.
2. The billing workspace is an ordinary organization. It pairs an Android relay device and adds the payment accounts that receive subscription and credit money. Evidence ingestion and normalization are unchanged.
3. Checkout evidence queries move from the customer's organization to the billing workspace. The other conditions stay: state `VERIFIED`, currency match, amount at least the price, not disputed, not already consumed.
4. One payment funds one purchase. The existing duplicate guard on the provider reference is kept and backed by a database unique constraint so it holds under concurrent requests.
5. Verification in the billing workspace uses the existing rules: reference of at least 6 characters, notes of at least 10, separation of duties. Only members with the Finance role verify billing payments; the Owner of the billing workspace manages the setting.

### Correction (found while building step 3)
The first version of this plan assumed a payment in the billing workspace could be verified without an invoice. It cannot. `verifyPayment` requires a target invoice and always writes an `invoice_payments` row, and the normalized-payment branch of checkout only accepts payments with no such row. So that branch can never succeed in production. The design below replaces it. Decision: Option A, one invoice per checkout.

### Activation through a billing invoice (Option A)
1. A paid checkout creates a payment request: a normal invoice in the billing workspace (reference like `SUB4F9K2XQ`, amount from the price snapshot, optional payer phone) plus a `billing_checkout_requests` row that stores the plan version, price, currency and interval the customer chose.
2. The customer pays BriskSMS's receiving number and puts the reference in the payment memo. The payment SMS is matched to the invoice by the existing rules (exact reference, or sender phone with an exact amount). Nothing new is guessed.
3. A Finance user in the billing workspace verifies the payment with the existing rules: separation of duties, row locks, claim checks, duplicate protection.
4. When verification marks the invoice paid, the subscription is activated in the same database transaction, on the terms the customer requested. There is no separate event or worker, so activation cannot be missed.
5. Underpayment leaves the invoice partly paid and the plan inactive until the balance is paid. Overpayment goes to review as it does for any invoice, and activates once verified. A customer has one open request at a time. Cancelling it voids the invoice.
6. The payment instructions shown to the customer (where to pay) are text configured on `/nexus`, not code.
7. Retry fallback is not needed for activation, since it is atomic with verification. The customer can still check the status of the request.
8. Expiry is not used. A verified full payment always activates, because the money has been received. Cancelling the request is the way to abandon it.

### Changes
- Migration: `billing_checkout_requests`.
- A hook in `verifyPayment`, run only when the invoice becomes paid, that activates a matching request.
- `/nexus`: payment instructions field on the Billing tab, audited.
- Console checkout dialog: shows the reference, amount and instructions, and a "Waiting for confirmation" state.

### Tests
- Evidence in the customer's own organization is rejected.
- Underpayment is rejected; overpayment is accepted.
- Duplicate replay never grants two subscriptions.
- One reference used by two organizations: the second is rejected.
- Two concurrent checkouts with the same reference: exactly one succeeds.
- Payment verified before checkout, and payment verified after checkout: both activate exactly once.
- Expired pending request does not activate.
- Billing workspace unset: paid checkout fails closed; free tier works.

## 4. Step 2: Credit purchase

### Design
1. Credit packs (credits, price, currency, active flag) live in their own table and are configured on `/nexus`. They are separate from the plan catalog.
2. New route `POST /v1/organizations/:orgId/messaging/credits/checkout` with `{ packId, paymentRef }`. Owner or Admin, human session only, rate limited like subscription checkout.
3. Same pending and automatic-activation flow as subscriptions, with the same retry fallback.
4. Activation runs in one transaction: lock the evidence row, record consumption, then call `purchaseCredits` with the payment id as `referenceId`. A unique constraint on the consumed payment id makes retries safe.
5. Credits are written only to `messaging_credit_ledger`. Nothing touches subscription billing.

### Changes
- Migration: `credit_packs`, `credit_purchases`.
- `/nexus`: Credit packs tab.
- Console Bulk SMS pane: balance and a "Buy credits" action. Pack prices come from the API.

### Tests
- The step 1 edge cases, plus: credits appear in the ledger exactly once, balance after equals balance before plus the pack, a pack deactivated mid-checkout is rejected, and one organization cannot use another organization's reference.

## 5. Step 3: One STK push gateway for all carriers

### What exists
- `StkPushAdapter` interface with `initiatePush` and `parseCallback`, and a registry keyed by carrier (`stk-adapter.registry.ts`).
- A callback verifier registry keyed by carrier, disabled by default (`verifiers/callback-verifier.registry.ts`).
- Fail-closed outcomes: `UNCONFIGURED`, `UNSUPPORTED`, `UNCERTAIN`. These are never auto-retried.

### Design
1. **One aggregator adapter.** A single adapter class implements `StkPushAdapter` and is registered for every carrier that the aggregator covers. Carrier-specific adapter files stop being the integration point.
2. **Aggregator settings on `/nexus`, not in code.** A settings record holds: aggregator name, base URL, credentials (encrypted with the existing `encryptSecret`), callback secret, and an enabled flag. Which aggregator is used is data, not code. Switching aggregator after negotiation means changing the record.
3. **Carrier routing table.** One row per carrier: enabled, aggregator, and the carrier's network code if the aggregator needs one. Adding a carrier is a row, not a new module.
4. **Dialect, not hardcoding.** The request, response and callback formats of an aggregator are unknown until a contract and documentation exist. The adapter delegates them to a small dialect object (build request, parse response, verify and parse callback). One dialect file is added once an aggregator is chosen. Until then the dialect list is empty and every dispatch returns `UNCONFIGURED`.
5. **Callback authentication stays strict.** A callback is provider-authenticated only when the dialect's verifier validates the signature against the configured secret. A callback that fails verification is stored as evidence and never settles anything.
6. **Kill switch stays in the environment.** `ENABLE_LIVE_CARRIER_STK` remains an env-level fail-closed switch. `/nexus` settings cannot turn live dispatch on by themselves.

### Money flow rule (decided)
BriskSMS never receives customer money and is never the path for it. STK push for a customer's own invoices (Product A) works only with that customer's own aggregator or merchant credentials, stored per organization and encrypted. The aggregator settles directly to the customer's account. Existing behavior stays as it is: BriskSMS only dispatches the prompt and records the evidence.
- The aggregator settings on `/nexus` hold only the platform-level connection (endpoint, dialect, enabled carriers). They carry no customer funds and no shared merchant account for customer invoices.
- BriskSMS's own STK pushes (subscriptions and credits) use BriskSMS's own merchant credentials and move only BriskSMS's own revenue.
- If an aggregator cannot support per-organization merchant credentials, it is not suitable for customer invoice STK push, and that feature stays `UNCONFIGURED` for that aggregator.

### Contract requirements to raise in the negotiation
- Per-merchant credentials or sub-merchant support, with settlement directly to each customer's own account.
- A signed callback or a status-query endpoint, so a payment can be provider-authenticated.
- A sandbox for tests that run against real response shapes.
- Idempotency keys on push requests, and the settlement and refund terms.

### Tests
- Registered dialect absent: dispatch returns `UNCONFIGURED`, never throws, never retries.
- Bad callback signature: evidence stored, payment not verified.
- Carrier disabled in the routing table: dispatch returns `UNSUPPORTED`.
- Timeout or 5xx: `UNCERTAIN`, no automatic retry, no double push on resubmission with the same idempotency key.
- Once a billing-workspace STK push succeeds, the checkout evidence query (`stk_push_transactions` with `SUCCESS`) already accepts it. To confirm in step 1.

## 6. Order of work

One concern per commit. Infrastructure is not mixed with business logic. Documentation in `docs/` is updated alongside each step.

1. Platform setting and billing-workspace evidence lookup. Verify: `bun test` from the repo root, `bun run typecheck`.
2. `/nexus` billing workspace field and platform audit logging. Verify: nexus tests, and a headless Chrome check at 375px.
3. Pending checkout and automatic activation, with retry. Verify: the step 1 test list.
4. Console checkout dialog.
5. Credit packs: migration, service, route. Then the `/nexus` tab and the Bulk SMS purchase UI.
6. Aggregator settings, routing table and the single adapter, with no dialects until the contract exists.

## 7. Risks

- Verification is human, so it is not instant. Automatic activation removes the customer's retry step but not the operator's verification step.
- If the billing workspace's relay misses an SMS, that payment cannot be verified. Manual evidence entry for the billing workspace is to confirm.
- A pending request that matches by reference alone could be claimed by the wrong customer. Matching must also check amount, currency and the organization that created the request, and the global reference claim table must be checked for cross-organization behavior (to confirm).
- The aggregator's terms decide whether customer-facing STK push is possible without custody. If not, it stays disabled. This is a commercial gate, not a coding task.

## 8. Decisions recorded

1. Automatic activation, with manual retry as fallback.
2. A dedicated Finance role verifies billing-workspace payments, with separation of duties.
3. Credit packs are fixed packs, configured on `/nexus`.
4. The billing workspace is a normal workspace designated by the platform setting.
5. STK push uses one aggregator gateway. The aggregator is configured on `/nexus`, and no provider is hardcoded.
6. BriskSMS never receives or routes customer money. Customer invoice STK push uses the customer's own credentials, and existing non-custodial behavior stays unchanged.
