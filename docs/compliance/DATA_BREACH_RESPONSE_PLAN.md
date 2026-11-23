# Personal Data Breach Response Plan

**Status:** Draft, 2026-11-17. Must be reviewed by legal counsel and the Data Protection Officer (DPO) before production launch. The DPO is not yet named; one must be designated for PDPC registration (`TASKS.md` section 6).

**Legal basis:** Personal Data Protection Act No. 5 of 2022 and the PDPC Regulations of 2023 (`COMPLIANCE_AND_FEASIBILITY.md` section 4). A breach affecting personal data must be reported to the Personal Data Protection Commission (PDPC) **within 72 hours** (`SECURITY.md` section 5).

## 1. Personal data BriskSMS holds

| Category | Where | Notes |
| --- | --- | --- |
| Payer details from payment alerts: phone number, name, transaction reference, amount, time | `raw_payment_evidence` (append-only) and reconciliation tables | Merchants' customers' data |
| Bulk SMS recipients: phone numbers and message text | Messaging tables; Android phone (Room database) until uploaded | Merchants' customers' data |
| Account users: name, email, password hash (`scrypt`) | `users` | BriskSMS's own customers |
| Credentials: refresh tokens, API keys, device tokens | `refresh_tokens`, `api_keys`, devices (SHA-256 hashes only) | Plaintext never stored |
| Integration secrets | `webhook_endpoints.secret`, `messaging_accounts.encrypted_api_token`, `smsgate_signing_keys` | AES-256-GCM under `ENCRYPTION_MASTER_KEY` |

Every tenant table carries `organization_id`, so affected merchants can be identified by query.

**For legal to confirm:** BriskSMS likely acts as a *data processor* for the merchants' customer data and as a *data controller* for its own account data. That determines who notifies the PDPC and the affected people for each category.

## 2. Roles

| Role | Responsibility | Person |
| --- | --- | --- |
| Incident lead | Runs the response, keeps the incident log | On-call engineer (to name) |
| DPO | Decides notifiability, files the PDPC report | To be designated |
| Legal counsel | Confirms obligations and wording | To name |
| Customer contact | Notifies affected merchants | To name |

## 3. Timeline

The 72-hour clock starts when BriskSMS becomes aware of a breach affecting personal data. Legal counsel should confirm the exact statutory trigger. Record that time in the incident log.

### Hour 0 to 1: confirm and record

- [ ] Open an incident log: time detected, who reported it, systems involved, what is known.
- [ ] Assign the incident lead and inform the DPO.
- [ ] Preserve evidence. Do not delete logs or data. `audit_logs` is append-only and records authentication, device pairing and revocation, and manual financial overrides.

### Hour 1 to 4: contain

Use the controls that exist today:

| Threat | Action | Control |
| --- | --- | --- |
| Lost or compromised Android phone | Revoke the device; it then fails closed with `403 DEVICE_REVOKED` | `POST /v1/devices/:id/revoke` |
| Leaked developer API key | Rotate or delete the key | `POST /v1/developer/api-keys/:id/rotate`, `DELETE /v1/developer/api-keys/:id` |
| Leaked OAuth token | Revoke the token | `POST /v1/oauth/revoke` |
| Compromised user account | Force a password reset; completing it revokes every session family for that user | `auth.service.ts` password reset flow |
| Leaked SMSGate signing key | Rotate it using the grace-period procedure | `SECURITY.md` section 6.3 |
| Hijacked webhook endpoint | Delete the endpoint | `DELETE /v1/developer/webhooks/:id` |
| Leaked platform secrets | Rotate `JWT_ACCESS_SECRET`, `CSRF_SECRET`, `PLATFORM_ADMIN_SECRET` and database or Redis passwords, then redeploy | Environment config |

### Hour 4 to 24: assess

- [ ] Which data categories (section 1) were exposed, and was it encrypted?
- [ ] How many people and records, and which organizations (`organization_id`)?
- [ ] What are the likely consequences for the people affected (fraud, phishing, exposure of payment history)?
- [ ] Is the breach still ongoing?

### Hour 24 to 72: notify

- [ ] **PDPC:** the DPO files the report. Legal must confirm the submission channel, since the RCMIS portal is documented here only for registration. Expected contents, also to be confirmed by legal:
  - what happened and when it was discovered
  - categories and approximate numbers of people and records affected
  - likely consequences
  - measures taken and planned
  - DPO contact details
- [ ] **Affected merchants:** tell each affected organization without delay, with the same facts limited to their data, so they can meet their own obligations.
- [ ] **Affected individuals:** legal decides whether and how they must be told directly.
- [ ] If the full facts are not known by hour 72, file what is known and send updates as they come in. Legal to confirm that phased reporting is acceptable.

### After the incident

- [ ] Hold a post-incident review within two weeks: root cause, timeline, what worked, and fixes with owners.
- [ ] Keep a record of every breach, including ones judged not notifiable, with the reasoning.
- [ ] Update this plan.

## 4. Known gaps

Found while writing this plan; each weakens the response today:

1. **No master key rotation.** There is no tooling to re-encrypt secrets under a new `ENCRYPTION_MASTER_KEY`. If the key leaks, every integration secret must be rotated at its source (webhook secrets, SMSGate tokens and keys).
2. **No automated anomaly quarantine.** `SECURITY.md` section 5 describes automatic device quarantine and owner email alerts on rate anomalies, but this is not in the code. Detection depends on people noticing.
3. **No organization-wide session kill.** Sessions can be ended per user (logout or password reset) but not for a whole organization in one action.
4. **No user deactivation endpoint.** Deactivated users are rejected at login, but deactivating one needs a direct database change.
5. **No DPO and no named responders yet.**
