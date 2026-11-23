# BriskSMS Tasks

Open work for BriskSMS, collected from the files in `docs/` on 2026-11-16.

**Where the project stands:** Phases 0 to 7 are built and pass their tests on a local machine. What is left is Phase 8: getting outside approvals, setting up a staging server, testing on real phones, and launching. A few features were also put off for later.

**How to read this file**

- `[ ]` means not done. Change it to `[x]` when finished.
- Tasks are in order. Finish section 1 before section 2, and so on.
- **(outside)** means the task depends on another company or office, not on code.
- The file name after each task shows where the details are.

---

## 1. Save and check the code (do first)

- [ ] Commit all the uncommitted work in the working tree, signed with the registered SSH key. *(roadmap, Phase 8 item 1; hard audit, section 7 item 6. Committed 2026-11-17 as local commits after `7b094a9`, unsigned because no SSH signing key is configured on this machine. Re-sign before pushing: `git rebase --exec "git commit --amend --no-edit -S" origin/main`.)*
- [ ] Push to `origin/main`. *(staging readiness audit, gate 3)*
- [ ] Confirm both GitHub Actions jobs pass: `verify` and `android-verify`. *(roadmap, Phase 8 item 1)*
- [ ] Fix the local dev database checksum mismatch for migration `20261112000000`. Either recreate the dev database or run the `repair-checksums` command. Do not edit the migration file. *(MIGRATION_CHECKSUM_INVESTIGATION.md. 2026-11-17: a fresh PostgreSQL 18 database applies all 15 migrations with `STRICT_MIGRATION_CHECKSUMS=true`, so the files are fine. The old dev database on port 54322 was not running and could not be repaired.)*

## 2. Outside accounts and agreements

- [ ] **(outside)** Create a Google Cloud OAuth Web Client ID, with `https://staging-console.brisksms.app` as an allowed origin. *(staging readiness audit, gate 5)*
- [ ] **(outside)** Get a Resend API key and set up DKIM, SPF, and DMARC DNS records for `staging.brisksms.app`. *(staging readiness audit, gate 6)*
- [ ] **(outside)** Get merchant agreements and API documents from each mobile-money carrier: *(CARRIER_STK_INTEGRATION_READINESS.md, section 2)*
  - [ ] Vodacom M-Pesa
  - [ ] Mixx by Yas
  - [ ] Airtel Money
  - [ ] HaloPesa
- [ ] **(outside)** Find out whether TTCL Pesa offers a merchant gateway at all. *(CARRIER_STK_INTEGRATION_READINESS.md, section 2)*
- [ ] Buy test hardware: one Android phone for the Companion app, one dual-SIM Android phone for the SMS gateway, and active SIM cards for Vodacom, Mixx by Yas, Airtel, and Halotel. *(STAGING_VALIDATION_PLAN.md, section 5)*

## 3. Staging server setup

- [ ] Set up a staging server (compute VM). *(STAGING_VALIDATION_PLAN.md, section 8)*
- [ ] Set up PostgreSQL 16+ and apply all 15 migrations with strict checksums on. *(staging readiness audit, gate 8)*
- [ ] Set up Redis 7+ inside a private network, not reachable from the internet. *(staging readiness audit, gate 7)*
- [ ] Point DNS for `staging-api.brisksms.app` and `staging-console.brisksms.app` to the server, with TLS 1.3 certificates. *(staging readiness audit, section 1)*
- [ ] Set up the reverse proxy (Nginx or Cloudflare): *(staging readiness audit, section 5)*
  - [ ] Overwrite `X-Forwarded-For` with the real client address, then set `TRUST_PROXY=true`.
  - [ ] Block direct access to API port 3000.
  - [ ] Add the Content-Security-Policy header. The app does not send one itself.
  - [ ] Forward `X-Forwarded-Proto: https` only from the trusted proxy.
- [ ] Create staging secrets. Each one must be generated separately. *(STAGING_DEPLOYMENT_RUNBOOK.md, step 3)*
- [ ] Deploy the API, worker, and web portal by following the runbook, then run its health checks and smoke tests. *(STAGING_DEPLOYMENT_RUNBOOK.md, sections 2 and 4)*

## 4. Live tests on staging

**Sign-in and email** *(STAGING_VALIDATION_PLAN.md, section 9)*

- [ ] Sign in with a real Google account.
- [ ] Check that a forged or replayed Google token is rejected.
- [ ] Register with a real email and check the message arrives within 10 seconds.
- [ ] Check the verification link works once and is rejected the second time.
- [ ] Check the 4th resend request in 15 minutes is blocked.

**Android Companion on a real phone** *(ANDROID_INTEGRATION.md, section 13)*

- [ ] Install the debug APK and pair it by scanning the QR code.
- [ ] Grant notification access and confirm the app shows it as active.
- [ ] Capture a real payment alert from each provider app: M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, CRDB.
- [ ] Confirm personal messages (WhatsApp, normal SMS) are never saved or uploaded.
- [ ] Confirm the hardware keystore (StrongBox) works on a phone that supports it.
- [ ] Confirm both SIM slots are detected on a dual-SIM phone.
- [ ] Send a real SMS and confirm the sent and delivered reports come back.
- [ ] Leave the phone unplugged with the screen off for over an hour and confirm the service is still running.
- [ ] Turn on airplane mode, then turn it off, and confirm queued records upload.
- [ ] Check battery settings on Samsung, Xiaomi, and Tecno/Infinix phones so the app is not killed in the background.

**SMS gateway** *(roadmap, Phase 5)*

- [ ] Pair the gateway phone with staging.
- [ ] Run a long sending test and confirm the system handles carrier rate limits (HTTP 429) safely.

**Browser tests** *(roadmap, Phase 8 item 3)*

- [ ] Write Playwright browser tests for the main console flows and run them against staging.

## 5. Carrier payment push (STK), after agreements arrive

Do these for each carrier, one at a time. Both parts must go live together. *(CARRIER_STK_INTEGRATION_READINESS.md, section 3)*

- [ ] Build the real outgoing adapter (replaces the "not configured" one).
- [ ] Build the real callback verifier (replaces the disabled one).
- [ ] Load the carrier's signing secrets or certificates into the validated config.
- [ ] Provide a public staging address with TLS 1.3 for carrier callbacks.
- [ ] Test a real payment push and callback on staging.

## 6. Legal and compliance

- [ ] **(outside)** Register with the Personal Data Protection Commission (PDPC) on the RCMIS portal. This needs the BRELA certificate, TIN certificate, an audited financial report, and a named Data Protection Officer. *(COMPLIANCE_AND_FEASIBILITY.md, section 4)*
- [ ] **(outside)** Ask a lawyer to confirm the exact TCRA rule for the promotional SMS curfew (20:00 to 07:00). The code enforces it, but no official rule is cited. *(staging readiness audit, section 4)*
- [x] Add this statement to the marketing pages, contracts, and terms of service: BriskSMS is not a bank, e-money issuer, or payment service provider licensed by the Bank of Tanzania. *(COMPLIANCE_AND_FEASIBILITY.md, section 3; added to the landing page terms in `apps/web/src/index.html`, which the Android app's "Terms of service" link opens, with a regression test in `apps/web/test/web-server.test.ts`)*
  - [ ] **(outside)** Add the same statement to customer contracts when they are drafted. No contract exists in the repo.
- [x] Prepare the Sender ID registration steps for merchants (BRELA certificate, TIN, signed authorization letter). *(COMPLIANCE_AND_FEASIBILITY.md, section 5; draft in `docs/compliance/SENDER_ID_REGISTRATION.md`, needs legal review. Note: approved Sender IDs are not used for delivery yet.)*
- [x] Write a data breach plan that covers telling the PDPC within 72 hours. *(COMPLIANCE_AND_FEASIBILITY.md, section 4; draft in `docs/compliance/DATA_BREACH_RESPONSE_PLAN.md`, needs legal and DPO review)*
- [ ] Decide how the Android app will be distributed: Google Play with the policy declaration, or private APK. *(ANDROID_INTEGRATION.md, section 12)*

## 7. Before production launch

- [ ] **(outside)** Get an independent penetration test and fix what it finds. *(roadmap, Phase 8 item 4)*
- [ ] Set up production PostgreSQL across multiple zones, with daily snapshots kept for 30 days and point-in-time recovery. *(DEPLOYMENT.md, section 5)*
- [ ] Run a recovery drill on staging. Targets: lose under 5 minutes of data, be back within 30 minutes. *(DEPLOYMENT.md, section 5)*
- [ ] Set up container image publishing and an automated deployment pipeline. *(DEPLOYMENT.md, section 4)*
- [ ] Provision the production master encryption key by following the key policy. *(SECURITY.md, section 7)*
- [ ] Build a way to rotate the master encryption key (re-encrypt stored secrets under a new key). None exists today, so a leaked key cannot be replaced. *(DATA_BREACH_RESPONSE_PLAN.md, section 4)*

## 8. Features put off for later

- [ ] Two-factor login (TOTP). The database columns exist, but login does not ask for a code yet. *(SECURITY.md, section 2.1)*
- [ ] NMB Bank message parser. *(roadmap, Phase 4)*
- [ ] Verify the HaloPesa and NMB parsers against real messages. Both are still provisional. *(ANDROID_INTEGRATION.md, section 14)*
- [ ] Add more real, anonymized sample messages to the parser tests. *(roadmap, Phase 4)*
- [ ] Direct MikroTik RouterOS and WHMCS workers. Today these work only through webhooks and Zapier. *(roadmap, Phase 6)*
- [ ] OAuth consent screen in the web portal. *(roadmap, Phase 6)*
- [ ] Excel `.xlsx` import for recipients. Today only CSV and XML work. *(PRD.md, alignment note)*
- [ ] Rebuild the web portal as an Angular 19+ app with component tests. *(roadmap, Phase 7)*
- [ ] Android tests that run on a real device (instrumented tests). *(roadmap, Phase 3)*
- [ ] Enterprise Android build that reads SMS directly (Mode 2). Kept out of the Play Store build on purpose. *(roadmap, Phase 3)*
- [x] Automatic clean-up of old device command and SMS job history. (Worker `purgeOldRelayHistory`, 90 days by default, batched and index-backed.) *(ANDROID_COMPANION_AND_RELAY_TOPOLOGY.md, known limitations)*
- [ ] Automatic device quarantine and owner alerts when a device's payment rate looks abnormal. SECURITY.md described this, but it was never built. *(DATA_BREACH_RESPONSE_PLAN.md, section 4)*
- [ ] Sender IDs end to end: console request and upload, an admin action to change status, and a delivery route that can show an alphanumeric sender. *(SENDER_ID_REGISTRATION.md, open items)*
- [x] Remove the unused `MOCK_TEST_GATEWAY` enum value. *(hard audit, section 6; already removed with `SmsGatewayProvider` in the uncommitted work)*

## 9. Fix documents that disagree

Found while reading. Check the real numbers first, then update.

- [x] Test counts differ: README says 532 tests in 39 files, the roadmap says 543 in 41, and the hard audit table says 537 in 40. *(Verified 2026-11-17: 544 pass, 0 fail, 41 files; 543 plus the new disclaimer test. README and TESTING_STANDARDS updated; dated run records left as written.)*
- [x] Android test counts differ: 10 classes with 41 tests, 10 with 47, and 11 with 52 all appear. *(Verified 2026-11-17: 10 classes, 41 tests, 0 failures. 52 predates the parser test removal in `7b094a9`; 47 was a miscount. Dated run records left as written.)*
- [x] `STAGING_READINESS_AUDIT.md` still says 6 migrations and 342 tests in places. The current number of migrations is 15. *(Migration count fixed. The remaining "342" mentions are dated baseline records for commit `5f590ac`, kept as history.)*
- [x] Redis TLS: the staging audit and roadmap say it is not supported, but hard audit item AUD-30 says `rediss://` support was added. Confirm which is true. *(Supported: `packages/db/src/redis.ts` uses `tls.connect` for `rediss://`. Docs updated.)*
- [x] `STAGING_DEPLOYMENT_RUNBOOK.md` section 7 says Google Sign-In and email delivery do not exist in the code. Other documents say both are built. *(Both are built; only credentials are missing. Runbook updated.)*
- [x] The hard audit names two different `HEAD` commits (`7b094a9` at the top, `e6c593d` in section 7). *(`HEAD` is `7b094a9`.)*
- [x] `STAGING_VALIDATION_PLAN.md` uses the old name `TIGO_PESA`; the rest of the project uses `MIXX`.
- [x] `SECURITY.md` section 5 said rate anomalies trigger automatic device quarantine and owner email alerts. No such code exists. *(Found 2026-11-17; now marked as not implemented, and added to section 8.)*
