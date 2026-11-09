# Deliverable E: Financial Integrity & Security Specification

**Document Version:** 1.0.0  
**Domain:** Financial Ledger, Reconciliation State Machine, and Cryptographic Invariants  
**Classification:** Critical Production Security Architecture  

---

## 1. Foundational Premise

In BriskSMS, an incoming SMS or device notification is treated as **unverified external evidence of a reported payment**, not self-executing proof of financial settlement. 

Because mobile telecommunications networks, SMS delivery mechanisms, and Android mobile devices operate across untrusted or semi-trusted channels, the financial engine must enforce strict mathematical and relational guarantees before any invoice is marked paid or any service is fulfilled.

---

## 2. Formal Transaction State Machine

The lifecycle of every payment received by BriskSMS follows a strict, deterministic state machine:

```
                                  [Raw Notification Received]
                                               |
                                               v
                                        +--------------+
                                        |   OBSERVED   |
                                        +--------------+
                                               |
                                               | (Parse & Deduplicate)
                                               v
                                        +--------------+
                       +----------------|  NORMALIZED  |----------------+
                       |                +--------------+                |
                       |                       |                        |
                       | (Parse Error /        | (Invoice Match         | (Duplicate
                       |  Tampered Format)     |  Evaluation)           |  Hash Detected)
                       v                       v                        v
                +--------------+        +--------------+        +----------------------+
                |   REJECTED   |        |   MATCHED    |        |  DUPLICATE_REJECTED  |
                +--------------+        +--------------+        +----------------------+
                                               |
                       +-----------------------+-----------------------+
                       |                                               |
                       | (Requires Manual Review:                      | (Criteria Met /
                       |  Partial, Overpay, Ambiguous)                 |  Auto-Verify)
                       v                                               v
             +--------------------+                         +----------------------+
             |  REVIEW_REQUIRED   |                         | VERIFICATION_PENDING |
             +--------------------+                         +----------------------+
                       |                                               |
                       | (Accountant Manual Approval)                  | (Verification Passed)
                       +-----------------------+-----------------------+
                                               |
                                               v
                                        +--------------+
                                        |   VERIFIED   |
                                        +--------------+
                                               |
                                               | (Enqueue Business Action)
                                               v
                                    +---------------------+
                                    | FULFILLMENT_PENDING |
                                    +---------------------+
                                               |
                       +-----------------------+-----------------------+
                       |                                               |
                       | (Action Succeeded)                            | (Max Retries Exhausted /
                       v                                               |  Target Unreachable)
                +--------------+                                       v
                |  FULFILLED   |                             +--------------------+
                +--------------+                             | FULFILLMENT_FAILED |
                                                             +--------------------+
```

### State Definitions & Permitted Transitions:

| State | Description | Invariants & Processing Rules | Permitted Next States |
|---|---|---|---|
| **`OBSERVED`** | Raw notification payload received from registered Android device. | Saved immutably in `raw_payment_evidence`. SHA-256 hash computed. No business logic executed yet. | `NORMALIZED`, `REJECTED`, `DUPLICATE_REJECTED` |
| **`NORMALIZED`** | Extracted canonical details (amount, provider, reference, sender, timestamp). | Parsed record valid; deduplication hash checked against organization index. | `MATCHED`, `REVIEW_REQUIRED`, `REJECTED` |
| **`DUPLICATE_REJECTED`** | Payload with identical deduplication hash already processed. | Terminal state. No invoice mutated; no automation triggered. Logged for fraud auditing. | None (Terminal) |
| **`MATCHED`** | Associated deterministically with an open invoice or customer account. | Invoice balance reserved. Awaiting verification check. | `VERIFICATION_PENDING`, `REVIEW_REQUIRED` |
| **`VERIFICATION_PENDING`** | Evaluating verification criteria (e.g., minimum settlement window, provider quorum). | Holds transaction while automated or secondary checks complete. | `VERIFIED`, `REJECTED`, `REVIEW_REQUIRED` |
| **`REVIEW_REQUIRED`** | Flagged for human review (underpayment, overpayment, ambiguous reference, unverified payer). | Routed to Accountant Review Queue. Must not fulfill until approved. | `VERIFIED`, `REJECTED` |
| **`VERIFIED`** | Confirmed authentic and approved for accounting credit. | Transactionally debits invoice balance; writes immutable audit record. | `FULFILLMENT_PENDING` |
| **`REJECTED`** | Flagged fraudulent, invalid, or rejected by accountant. | Terminal state. Invoice remains unpaid. Audit reason recorded. | None (Terminal) |
| **`FULFILLMENT_PENDING`** | Enqueued for downstream external execution (MikroTik / WHMCS / Webhook). | Holds unique idempotency key. Safe for retries. | `FULFILLED`, `FULFILLMENT_FAILED` |
| **`FULFILLED`** | External business action completed and confirmed. | Terminal operational state. External transaction ID stored. | None (Terminal) |
| **`FULFILLMENT_FAILED`** | Downstream action failed after maximum retries (e.g., router offline). | Payment remains **VERIFIED**; only the external action failed. Alerts admin for manual retry. | `FULFILLMENT_PENDING` (Manual re-trigger) |

---

## 3. Financial Invariants (Non-Negotiable Rules)

1. **Evidence Immutability:**
   - Raw records in `raw_payment_evidence` must never be updated, edited, or deleted under any circumstances.
2. **Deterministic Deduplication:**
   - Deduplication key:
     $$\text{Hash} = \text{SHA256}(\text{org\_id} \parallel \text{provider} \parallel \text{provider\_reference} \parallel \text{amount\_cents} \parallel \text{provider\_timestamp})$$
   - A unique constraint in PostgreSQL enforces that no duplicate payment record can ever be committed within the same tenant.
3. **Atomicity of Reconciliation:**
   - Updating invoice status from `UNPAID` to `PAID` or `PARTIALLY_PAID` must execute within a database transaction with row-level locks on the invoice row:
     ```sql
     BEGIN;
     SELECT id, total_amount, balance FROM invoices WHERE id = :invoiceId FOR UPDATE;
     -- Calculate remaining balance
     UPDATE invoices SET balance = :newBalance, status = :newStatus WHERE id = :invoiceId;
     INSERT INTO invoice_payments (id, invoice_id, payment_id, applied_amount, created_at) ...;
     UPDATE normalized_payments SET state = 'VERIFIED' WHERE id = :paymentId;
     COMMIT;
     ```
4. **Fulfillment Separation:**
   - External automation failure (e.g., MikroTik router unreachable or WHMCS server 500 error) must **never** reverse or invalidate a verified payment. 
   - The payment remains in `VERIFIED`, while the action transitions to `FULFILLMENT_FAILED`. Fulfillment can be retried independently without affecting financial records.
5. **Ledger Segregation (Product A vs Product B):**
   - **Product A (SaaS Subscriptions):** Tracked in `tenant_subscriptions` and `subscription_invoices`.
   - **Product B (Bulk Messaging Credits):** Tracked in an append-only immutable credit transaction ledger `messaging_credit_ledger`:
     ```sql
     CREATE TABLE messaging_credit_ledger (
       id UUID PRIMARY KEY,
       organization_id UUID NOT NULL,
       entry_type VARCHAR(20) NOT NULL, -- 'PURCHASE', 'USAGE_DEDUCTION', 'REFUND'
       amount_credits INTEGER NOT NULL,  -- Positive for credit, negative for debit
       balance_after INTEGER NOT NULL,
       reference_id VARCHAR(100),       -- Campaign ID, Top-up Invoice ID
       created_at TIMESTAMPTZ NOT NULL
     );
     ```
   - Messaging credits can never be used to pay for SaaS subscriptions, and SaaS subscription fees can never be converted into messaging credits.

---

## 4. Multi-Tier Matching Algorithm

When a payment is `NORMALIZED`, the reconciliation engine executes a hierarchical matching waterfall:

```
[Normalized Payment]
        |
        v
[Tier 1: Exact Memo / Invoice Number Match]
Is there an open invoice with `reference_number == payment.extracted_memo`?
  ├── YES -> Check Amount -> Exact? -> [MATCHED]
  │                       -> Less?  -> Flag Underpaid -> [REVIEW_REQUIRED]
  │                       -> More?  -> Flag Overpaid  -> [REVIEW_REQUIRED]
  └── NO  -> Proceed to Tier 2
        |
        v
[Tier 2: Customer Account / Phone Identifier Match]
Does `payment.sender_phone` or `payment.sender_name` uniquely map to a Customer with 1 open invoice?
  ├── YES -> Check Amount -> Exact? -> [MATCHED]
  │                       -> Discrepancy -> [REVIEW_REQUIRED]
  └── NO (0 or >1 open invoices) -> Proceed to Tier 3
        |
        v
[Tier 3: Active Checkout Session (Time-Window Match)]
Is there an active checkout session with identical amount created within the last 15 minutes?
  ├── YES -> [MATCHED (Checkout Session)]
  └── NO  -> Proceed to Tier 4
        |
        v
[Tier 4: Unmatched Fallback]
Mark as [UNMATCHED] -> Move to Accountant Review Queue
```

---

## 5. Security & Threat Modeling

| Threat Vector | Attack Scenario | Architectural Defense & Mitigation |
|---|---|---|
| **Forged SMS Ingestion** | Attacker sends malicious HTTP payload to `/v1/ingest/notifications` pretending to be an Android device. | Device tokens are bound to Android Keystore public keys. Payloads must be signed with ECDSA (P-256) on-device; requests with invalid signatures are rejected with HTTP 401. |
| **Replay Attack** | Attacker intercepts a valid signed payload and replays it multiple times. | Every payload includes a unique monotonic sequence number, device timestamp, and a random cryptographic nonce. Timestamps older than 300 seconds are rejected; nonces are cached in Redis with a 10-minute TTL. |
| **Cross-Tenant Bleed** | Tenant A queries API or crafts ID parameter to read Tenant B's invoices or payments. | Tenant ID is extracted strictly from the validated JWT claims. Prisma queries use an organization middleware filter. Direct ID lookups include `WHERE id = :id AND organization_id = :orgId`. |
| **Cashier Collusion** | Rogue cashier marks a friend's unpaid invoice as paid without a valid payment reference. | Manual reconciliation requires the `Finance Manager` or `Owner` role. Every manual override requires entering an audit reason and creates an immutable entry in `audit_logs` capturing actor ID, timestamp, and IP address. |
| **Stolen Android Device** | Physical device running the relay is stolen or compromised. | The organization owner can click "Revoke Device" in the web dashboard. The device's public key is immediately marked revoked in PostgreSQL and blacklisted in Redis. All future requests from that device fail instantly. |
| **Webhook Spoofing** | Attacker attempts to impersonate BriskSMS when notifying an external merchant server (WHMCS). | All webhooks include the `X-BriskSMS-Signature` header containing `HMAC-SHA256(webhook_secret, payload_body)`. Merchants verify the signature using their private endpoint secret. |

---

## 6. Audit Trail Specifications

Every security-sensitive or financial operation produces an append-only audit event in `audit_logs`:

```json
{
  "id": "018f2d5e-4a1b-7890-a1b2-c3d4e5f6a7b8",
  "organization_id": "018f2d50-1234-7890-b2c3-d4e5f6a7b8c9",
  "actor_id": "018f2d4f-9876-7890-c3d4-e5f6a7b8c9d0",
  "actor_type": "USER", // "USER", "DEVICE", "SYSTEM", "API_KEY"
  "action": "payment.manual_match_approved",
  "resource_type": "normalized_payments",
  "resource_id": "018f2d5b-5555-7890-d4e5-f6a7b8c9d0e1",
  "previous_state": { "state": "UNMATCHED", "matched_invoice_id": null },
  "new_state": { "state": "VERIFIED", "matched_invoice_id": "018f2d5c-7777-7890-e5f6-a7b8c9d0e1f2" },
  "metadata": {
    "ip_address": "197.250.45.12",
    "user_agent": "Mozilla/5.0 ... Chrome/130.0",
    "reason": "Customer provided M-Pesa reference over WhatsApp phone call; verified against merchant statement"
  },
  "created_at": "2026-11-05T14:45:10.123Z"
}
```

Audit records are strictly read-only and indexed by `organization_id`, `resource_id`, and `created_at`.

