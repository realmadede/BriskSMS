# Sender ID Registration: Merchant Steps

**Status:** Draft, 2026-11-17. Based on `COMPLIANCE_AND_FEASIBILITY.md` section 5. Have legal counsel confirm it against TCRA's current published procedure before sending it to merchants.

A Sender ID is the name shown as the sender of an SMS, for example `DUKALANGU` instead of a phone number. It applies only to Product B (bulk messaging). Payment reconciliation (Product A) never needs a Sender ID or messaging credits.

## Before you start: what the product does today

- **Registered Sender IDs are not used for delivery yet.** Bulk SMS is sent through the paired Android phone's SIM card (SMSGate relay), so recipients see that SIM's phone number. A SIM-based route cannot show an alphanumeric sender name.
- The database already tracks Sender IDs (`sender_ids` table, linked from `sms_campaigns.sender_id_id`), but nothing in the dispatch path reads that link.
- There is **no console screen or API endpoint** for requesting a Sender ID. Requests are handled manually by BriskSMS support, as described below.

Merchants can still prepare and register now, so the name is ready when an alphanumeric delivery route is added.

## 1. Choose the name

- At most **11 characters**, letters and digits. The database rejects anything longer.
- Use the business's trading name or brand. TCRA reviews every request, and approval is not guaranteed.

## 2. Prepare three documents

Scan each one as a clear PDF:

1. **Certificate of Incorporation** issued by BRELA
2. **Taxpayer Identification Number (TIN) certificate**
3. **Letter of authorization** on the company's official letterhead, signed by a company director

### Letter of authorization template

Draft wording, for legal to confirm before use:

```text
[Company letterhead]

Date: [DD Month YYYY]

To: BriskSMS

Subject: Authorization to register Sender ID "[SENDERID]"

We, [Registered company name] (BRELA registration no. [number], TIN [number]),
request registration of the SMS Sender ID "[SENDERID]" for messages sent on our
behalf to our customers.

We confirm that "[SENDERID]" represents our business, and we authorize BriskSMS
to submit this request and the attached documents for approval in accordance
with TCRA guidelines.

Signed: ______________________
Name: [Director's full name]
Title: Director
Company stamp:
```

## 3. Send the request

Email the three PDFs and the requested Sender ID to BriskSMS support at `enterprise@brisksms.app` (the support address shown in the Android app). Include the organization name exactly as it appears in the BriskSMS console.

## 4. What happens next

Each request moves through these states (`SenderIdStatus` in `packages/shared/src/enums/messaging.enum.ts`):

| State | Meaning | Merchant action |
| --- | --- | --- |
| `PENDING_DOCUMENTS` | Request recorded; documents missing or being checked | Send any missing documents |
| `SUBMITTED_TO_TCRA` | Submitted for whitelist approval | Wait |
| `APPROVED` | Approved and recorded against the organization | None |
| `REJECTED` | Not approved; the reason is stored in `rejection_reason` | Fix the issue, or choose another name, and resend |

## Open items for BriskSMS

These need decisions before this guide goes to merchants:

- [ ] Legal: confirm the document list, the letter wording and the submission channel (BriskSMS as aggregator, or directly to each network).
- [ ] Legal: confirm character rules (spaces, symbols, reserved or generic words) and typical approval time.
- [ ] Product: build the console request and upload flow, plus an admin action to move states. Today a state change needs a direct database update.
- [ ] Engineering: add an alphanumeric-capable delivery route and apply `sender_id_id` at dispatch. Until then, an approved Sender ID has no effect.
