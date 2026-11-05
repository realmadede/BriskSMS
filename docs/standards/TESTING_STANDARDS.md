# Testing Standards & Quality Assurance Strategy

**Test Frameworks:** Jest / Vitest (Backend & Shared Packages), JUnit 5 / Espresso (Android), Playwright (E2E)  
**Target Coverage:** Minimum 85% branch coverage on core financial, parsing, and authentication paths.  

---

## 1. Testing Pyramid

```
           / \
          /   \
         / E2E \         Playwright User Journeys (Signup -> Pair -> Pay -> Reconcile)
        /-------\
       /  Integ  \       NestJS TestContainers (Postgres, Redis, Real DB Queries)
      /-----------\
     /    Unit     \     Parser Corpus, Deduplication Math, State Transitions, Validators
    /---------------\
```

---

## 2. Unit Testing Standards

1. **Parser Test Corpus:**
   - Every payment provider adapter (`packages/parser-engine`) must have a corresponding test suite validating real-world, anonymized SMS notifications.
   - Tests must include:
     - Standard successful payment notification.
     - Notifications with non-standard formatting, extra whitespace, or localized characters (Swahili/English).
     - Paybill/Till transactions with and without customer reference memos.
     - Reversal / cancellation notifications.
     - Malformed or incomplete strings (ensuring parser fails safely without throwing unhandled exceptions).
2. **Financial State Machine:**
   - Explicit tests for every transition in `docs/financial/FINANCIAL_INTEGRITY.md`.
   - Invariant tests: Submitting duplicate payloads, underpayments, and overpayments.

---

## 3. Integration Testing Standards

1. **Database Integration:**
   - Integration tests execute against real PostgreSQL test databases (run via Docker).
   - Verify that Prisma middleware and repository queries strictly filter by `organization_id`.
   - Test race conditions: Concurrently attempting to settle an invoice using two worker threads.
2. **Queue & Worker Integration:**
   - Verify that messages pushed to BullMQ queues are picked up and processed by workers with correct backoff retry behavior on failure.

---

## 4. End-to-End (E2E) Testing Standards

1. **Critical User Journeys:**
   - Journey 1: New merchant registration -> Create organization -> Generate device QR code.
   - Journey 2: Android device pairs -> Relays M-Pesa payment -> Backend parses -> Auto-matches open invoice -> Invoices marked PAID -> Webhook dispatched.
   - Journey 3: Merchant buys bulk SMS credits -> Launches campaign -> Messages queued -> Delivery reports update credit ledger.
2. **Execution Environment:** E2E tests run automatically in GitHub Actions on every pull request to `main`.

