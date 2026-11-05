# Deliverable B: Product Requirements Document (PRD)

**Product Name:** BriskSMS  
**Document Version:** 1.0.0  
**Target Market:** Tanzania (Initial), East Africa & SADC (Expansion)  
**Classification:** Commercial SaaS Platform  
**Architecture Lead:** Principal Architect & Senior Full-Stack Lead  

---

## 1. Product Vision & Value Proposition

BriskSMS is an enterprise-grade Payment Intelligence, Financial Reconciliation, Business Automation, and Messaging platform designed specifically for businesses operating in mobile-money-dominated economies.

In Tanzania and across emerging markets, over 80% of consumer-to-business (C2B) payments occur over mobile money (Vodacom M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, TTCL Pesa) or bank transfers (CRDB SimBanking, NMB Mkononi). However, small and medium enterprises (SMEs) face immense operational bottlenecks:
- **Cashier Fraud & Fake SMS Scams:** Bad actors present fabricated SMS text messages or altered screenshots to claim products or services.
- **Manual Reconciliation Grind:** Accountants spend hours every evening manually matching bank/M-Pesa SMS texts against physical receipt books, spreadsheets, or accounting software.
- **Delayed Fulfillment:** Customers waiting for internet renewals (MikroTik/PPPoE), web hosting accounts (WHMCS), school fee receipts, or order dispatches must wait until a human verifies the transaction.
- **Expensive Telco Gateways:** Direct C2B telco API integrations require prohibitive corporate bank guarantees, lengthy regulatory vetting, and expensive monthly minimums that shut out thousands of SMEs.

**BriskSMS bridges this chasm by delivering two independently monetized products within a single unified organization management platform:**

```
                                    +----------------------------------------+
                                    |                BriskSMS                |
                                    |       Unified Business Platform        |
                                    +----------------------------------------+
                                                        |
                    +-----------------------------------+-----------------------------------+
                    |                                                                       |
+---------------------------------------+                               +---------------------------------------+
|               Product A               |                               |               Product B               |
|         Payment Intelligence          |                               |            Bulk Messaging             |
|        & Business Automation          |                               |        (Independent & Optional)       |
+---------------------------------------+                               +---------------------------------------+
| - Android Ingestion Relay             |                               | - Sender ID Management (TCRA)         |
| - M-Pesa / Mixx / Airtel / HaloPesa   |                               | - Single & Bulk SMS Campaigns         |
| - CRDB / NMB Bank Alert Parsers       |                               | - Scheduled Broadcasts                |
| - Duplicate & Fraud Detection         |                               | - Contact Groups & Custom Attributes  |
| - Automatic Invoice Matching          |                               | - Personalized Message Templates      |
| - MikroTik / WHMCS / Webhook Actions  |                               | - Real-time Delivery Reports (DLR)    |
| - Audit Logs & Financial Reports      |                               | - Developer Messaging REST API        |
+---------------------------------------+                               +---------------------------------------+
| Monetization: SaaS Monthly/Annual Tier|                               | Monetization: Prepaid Credit Ledger   |
+---------------------------------------+                               +---------------------------------------+
                    |                                                                       |
                    +-----------------------------------+-----------------------------------+
                                                        |
                                    +----------------------------------------+
                                    |       Shared Core Infrastructure       |
                                    | - Multi-tenant Isolation (Org ID)      |
                                    | - Role-Based Access Control (RBAC)     |
                                    | - Device Pairing (QR / Keystore)       |
                                    | - Developer Platform (API Keys, Hooks) |
                                    | - Audit Trail & Compliance (PDPA)      |
                                    +----------------------------------------+
```

### Critical Commercial Rule
**Payment reconciliation does not require bulk SMS credits.** Customers subscribing to Product A can use the complete payment intelligence, reconciliation, and workflow automation engine without ever purchasing bulk SMS credits. Product B is completely optional.

---

## 2. Target Customer Personas

| Customer Segment | Core Pain Point | How BriskSMS Solves It | Key Integrations Needed |
|---|---|---|---|
| **Local ISPs & Hotspot Operators** | Customers pay via M-Pesa at night; internet remains suspended until office hours, causing complaints. | Automatically matches M-Pesa payments with PPPoE/Hotspot username and triggers immediate MikroTik API profile activation. | MikroTik RouterOS (v6 & v7 API/SSH), RADIUS |
| **Web Hosting & Cloud Agencies** | Manual invoice clearing in WHMCS / Blesta delays cPanel and VPS provisioning. | Ingests payment notification, verifies payload hash, marks WHMCS invoice as Paid via WHMCS API, and provisions services instantly. | WHMCS REST API, WooCommerce |
| **Schools & Colleges** | Parents pay school fees via mobile money paybill; administrative staff manually reconcile thousands of student IDs. | Ingests student reference number from payment memo, matches against student fee ledger, flags partial payments, and generates accounting reports. | CSV Student Ledger, Custom Webhooks |
| **Retailers, Supermarkets & Wholesalers** | Cashiers are tricked by fake SMS messages; manual end-of-day till balancing takes hours. | Real-time audio/screen alert on till terminal; instant deduplication ensures same M-Pesa code is never accepted twice. | Cloud Webhooks, Cashier Terminal Dashboard |
| **SaaS & Subscription Startups** | Cannot afford official mobile money direct aggregator corporate guarantees ($2,000+ bond). | Connects an authorized company Android phone with a registered Lipa Kwa M-Pesa / Till SIM to automate payment processing instantly. | Developer REST API, Webhooks |

---

## 3. User Roles & Access Control (RBAC)

BriskSMS enforces strict role-based access control across organization boundaries:

1. **Platform SuperAdmin (Internal BriskSMS Ops):**
   - System-wide telemetry, tenant health, provider parser health metrics, global aggregator routing, and abuse monitoring.
2. **Organization Owner:**
   - Full legal and operational control over an organization.
   - Manages billing subscriptions (Product A), buys SMS credits (Product B), invites/removes team members, generates production API keys.
3. **Organization Admin:**
   - Manages devices (pairing/revocation), configures payment provider channels, sets up automation rules (MikroTik/WHMCS), and manages webhook endpoints.
4. **Finance Manager / Accountant:**
   - Full read/write access to payment records, invoices, reconciliation exceptions, and manual match resolution.
   - Access to audit logs, ledger reports, and tax/accounting exports. Cannot modify integration secrets or device pairing.
5. **Cashier / Support Agent:**
   - Read-only access to transaction verification status (e.g., verifying if a customer's M-Pesa code was received and settled).
   - Can submit payment matching notes for review, but cannot approve manual reconciliation overrides.
6. **Developer:**
   - Manages API keys, sandbox environments, webhook endpoints, event replay debugging, and API usage analytics.

---

## 4. Product Modules & Functional Requirements

### Module 1: Identity, Multi-Tenancy & Security
- **FR-1.1:** Organizations are strictly isolated multi-tenant entities. Every resource (devices, payments, invoices, contacts, API keys) must be bound to a unique `organizationId`.
- **FR-1.2:** Users can belong to multiple organizations with distinct roles per organization.
- **FR-1.3:** Authentication via secure JWT with short expiration (15 minutes) and rotating HTTP-only refresh tokens (7 days).
- **FR-1.4:** Two-Factor Authentication (2FA) via TOTP (RFC 6238) for all administrative and financial roles.

### Module 2: Device Management & Secure Android Ingestion
- **FR-2.1:** Android devices connect to an organization via a secure QR code pairing flow containing a single-use cryptographically signed enrollment token.
- **FR-2.2:** On enrollment, the Android app generates an asymmetric keypair in the hardware-backed Android Keystore and registers its public key with the backend.
- **FR-2.3:** The device maintains a bidirectional heartbeat (WebSocket or HTTP polling fallback) reporting battery level, network type, signal strength, and last sync timestamp.
- **FR-2.4:** Multiple Android devices can be registered per organization, with assigned labels (e.g., "Main Store Till", "Kariakoo Branch Sim 1").
- **FR-2.5:** Device revocation takes effect immediately: revoked device tokens are blacklisted in Redis and rejected at the API gateway.
- **FR-2.6:** Offline resilience: In the event of cellular or Wi-Fi disconnection, the Android client queues raw notifications in an encrypted local SQLite/Room database and syncs them automatically upon reconnection with exponential backoff.

### Module 3: Payment Intelligence & Ingestion Engine
- **FR-3.1:** The ingestion API accepts incoming notification payloads containing raw text, sender address, receiving SIM slot, device timestamp, and a cryptographic signature.
- **FR-3.2:** The raw payload is immediately persisted in an append-only `raw_payment_evidence` table before any parsing logic executes.
- **FR-3.3:** The parsing engine isolates provider-specific logic into versioned adapters:
  - Vodacom M-Pesa (Tanzania)
  - Mixx by Yas (Tanzania, formerly Tigo Pesa)
  - Airtel Money (Tanzania)
  - HaloPesa (Halotel Tanzania)
  - TTCL Pesa (Tanzania)
  - CRDB Bank (SimBanking / Alerts)
  - NMB Bank (Mkononi / Alerts)
- **FR-3.4:** The parser normalizes unstructured text into a canonical financial record:
  - Canonical Transaction Reference (e.g., `QA12BC34DE`)
  - Amount and ISO Currency (e.g., `50000.00 TZS`)
  - Sender Name and Masked Phone Number
  - Recipient Account / Till / Paybill number
  - Provider Timestamp and Processing Timestamp
  - Extracted Customer Reference / Memo (if present)
- **FR-3.5:** **Deduplication Engine:** A unique deduplication hash `SHA-256(org_id + provider + reference + amount + timestamp)` is computed. Replayed notifications are logged and flagged as `DUPLICATE_REJECTED` without mutating balances.

### Module 4: Invoicing & Reconciliation Engine
- **FR-4.1:** Businesses can create and manage invoices with line items, tax rates, total amount, due dates, and customer details.
- **FR-4.2:** Invoices can be imported or synchronized via external integrations (WHMCS, WooCommerce, CSV).
- **FR-4.3:** **Matching Algorithm:**
  - *Tier 1 (Exact Reference Match):* Transaction memo or payer phone matches invoice reference or customer account number exactly -> Transitions to `MATCHED`.
  - *Tier 2 (Time-Window & Amount Heuristic):* In checkout/paybill scenarios where memo is absent, matches pending invoice with identical expected amount created within an active 15-minute checkout window -> Transitions to `MATCHED` or `VERIFICATION_PENDING`.
  - *Tier 3 (Partial & Overpayments):*
    - If payment < invoice balance: Invoice status becomes `PARTIALLY_PAID`, remaining balance is adjusted, and an event is emitted.
    - If payment > invoice balance: Invoice status becomes `OVERPAID`, excess credit is credited to customer balance or flagged for refund review.
  - *Tier 4 (Unmatched Fallback):* Payments that cannot be matched deterministically are assigned state `UNMATCHED` and appear in the Accountant Review Queue.
- **FR-4.4:** **Manual Match Workflow:** An authorized accountant can manually link an `UNMATCHED` payment to an open invoice, supplying a mandatory audit reason.

### Module 5: Business Automation & Workflow Execution Engine
- **FR-5.1:** Rule-based event-action triggers configured per organization:
  - *Trigger:* `payment.verified`, `invoice.settled`, `payment.underpaid`, `device.offline`.
  - *Condition:* Provider equals `MPESA`, Amount >= 10,000, Customer Tag contains `VIP`.
  - *Action:* Execute MikroTik command, update WHMCS invoice, dispatch signed Webhook, or send customer SMS.
- **FR-5.2:** **MikroTik RouterOS Integration Adapter:**
  - Securely communicates with MikroTik RouterOS (v6 and v7) over RouterOS API (SSL) or encrypted SSH.
  - Automates PPPoE user enable/disable, profile assignment (rate limit change), and Hotspot user generation.
- **FR-5.3:** **WHMCS Integration Adapter:**
  - Communicates via WHMCS REST API to record transactions (`addInvoicePayment`) and apply transaction fees.
- **FR-5.4:** **Webhook Dispatcher:**
  - Delivers signed JSON payloads with an HMAC-SHA256 signature header (`X-BriskSMS-Signature`).
  - Supports automatic retries with exponential backoff (up to 5 attempts over 24 hours).
  - Webhook delivery logs with request/response headers and body inspection.

### Module 6: Bulk Messaging (Product B - Optional & Independent)
- **FR-6.1:** **Sender ID Management:** Organizations submit alphanumeric sender IDs for TCRA regulatory vetting with uploaded business documents (BRELA certificate, TIN, authorization letter).
- **FR-6.2:** **Prepaid Credit Ledger:** Bulk messaging operates on an isolated prepaid credit balance. Credits are deducted atomically at message dispatch time. Failed messages (permanent delivery failure) trigger automatic credit refunds to the organization ledger.
- **FR-6.3:** **Campaign Management:**
  - Single SMS dispatch via dashboard or REST API.
  - Bulk campaigns with CSV recipient import, variable tag replacement (`{{name}}`, `{{invoice_amount}}`), and scheduling for future date/time.
  - Night-time TCRA anti-spam compliance: Restricts promotional broadcasts between 20:00 and 07:00 East Africa Time (EAT).
- **FR-6.4:** **Aggregator Gateway & DLR:**
  - Multi-provider gateway routing (Beem Africa, DARSMS, eHUB) with automatic failover.
  - Real-time delivery report (DLR) webhook ingestion and status updates (`QUEUED`, `SENT`, `DELIVERED`, `FAILED`).

### Module 7: Commercial Billing & Quota Enforcement
- **FR-7.1:** Separate commercial billing systems:
  - Product A: Recurring subscription plans (Starter, Growth, Enterprise) based on connected Android devices, monthly reconciled transactions, and automation rules.
  - Product B: Pay-as-you-go prepaid SMS credit packages.
- **FR-7.2:** Quota enforcement: When an organization exceeds its Product A monthly transaction ceiling, the system continues to ingest payments safely without dropping data, but displays upgrade warnings and rate limits non-critical automation until upgraded.
- **FR-7.3:** Support for automated recurring subscription payment via M-Pesa / Tigo Pesa push USSD or credit card.

---

## 5. Non-Functional Requirements (NFR)

1. **Performance & Latency:**
   - Ingestion API response time: P99 < 150ms for raw payload receipt.
   - Normalization & Matching throughput: End-to-end processing (from Android relay receipt to webhook dispatch) < 2.0 seconds under normal load.
   - Bulk SMS dispatch rate: Scalable to 500 messages per second across aggregator channels.
2. **Reliability & Availability:**
   - 99.95% operational uptime for the ingestion gateway and reconciliation engine.
   - Zero data loss: All incoming payloads must be acknowledged only after durable persistence in PostgreSQL.
3. **Security & Cryptography:**
   - All network traffic encrypted with TLS 1.3.
   - Database encryption at rest (AES-256) for sensitive credentials (API secrets, RouterOS passwords).
   - Rate limiting on all public API endpoints (Token bucket algorithm).
4. **Auditability & Compliance:**
   - 100% audit trail coverage: Every financial transition, manual match, device registration, and user login must create an immutable audit log entry with actor ID, IP address, timestamp, and previous/new state diff.

---

## 6. Acceptance Criteria

| ID | Requirement Area | Acceptance Criteria |
|---|---|---|
| **AC-1** | Product Separation | An organization can actively reconcile payments and trigger automations with a zero SMS credit balance. |
| **AC-2** | Deduplication | Sending the identical raw SMS payload twice within any timeframe produces exactly one `NORMALIZED` record; the second returns code 200 with status `DUPLICATE_REJECTED` and does not affect balances or triggers. |
| **AC-3** | Ingestion Under Load | The backend processes 100 concurrent incoming device payloads without deadlocks, dropped messages, or inconsistent invoice balances. |
| **AC-4** | Device Revocation | An API request from a revoked Android device is rejected with HTTP 401 Unauthorized within 1 second of revocation in the dashboard. |
| **AC-5** | MikroTik Fulfillment | When a payment matching an active MikroTik rule is verified, the worker connects to the RouterOS API and enables the target user; if the router is unreachable, the action enters `FULFILLMENT_PENDING` with retry backoff without canceling payment verification. |
| **AC-6** | Data Privacy (PDPA) | The Android application strictly discards any incoming SMS that does not originate from an approved provider shortcode/sender before transmitting data to the backend. |

