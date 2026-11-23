# Nexus Operations Console Plan

Status: Phases 0 and 1 are built. Phases 2 to 6 and the billing items under "Unfinished work" are not. Last updated 22 November 2026.
Route: `/nexus` (typed by hand, never linked, noindex). API: `/v1/admin/*`, platform admin only.

Basis: a read of the Prisma schema, device, messaging, webhook and subscription modules. Items marked "to confirm" were not read in full.

## Unfinished work (kept current)

Built and committed: the platform audit log and Audit tab (Phase 0); the Billing tab with the billing workspace and the payment instructions field; the tenant directory, kill switches and Workspaces tab (Phase 1).

Not built yet, in the order planned:

| Item | State |
|---|---|
| Credit packs tab on `/nexus` (create, edit, switch off packs) | Built (23 November 2026). Checked in headless Chrome against a stubbed API; not yet against the live API with a real admin session |
| Phase 2: fleet command center | Not started |
| Phase 3: early warning alerts (`ops_alerts`, worker, thresholds) | Not started |
| Phase 4: per-organization overrides, manual credit adjustments, read-only support view | Not started |
| Phase 5: blocklists and abuse detection | Not started |
| Phase 6: infrastructure health panel, Android telemetry expansion, auto-failover | Not started. Needs Android client work |
| STK aggregator settings and routing table (billing plan step 6) | Not started. Waits for the aggregator contract |
| OTP and message-body redaction in platform views (rule 2) | Not started. Applies once any platform view shows message content |

Before `/nexus` is used in production:
- Set `PLATFORM_ADMIN_SECRET` (at least 24 characters) in the real environment.
- Add a named allow-list of platform admins and require two-factor for them (see Risks).
- Restart any long-running API process so it serves the new admin routes.

## 1. What exists today

| Area | Exists | Missing |
|---|---|---|
| Merchant directory | `apps/api/src/modules/admin/admin.service.ts` already has merchant summary and detail (members, devices). It is not imported by any route yet. To confirm what else it does before Phase 1 | Routes, audit entries, tests |
| Admin access | Signed-in human session plus `X-Platform-Admin-Key` (`assertPlatformAdmin`) | A named list of platform admins, a platform-level audit log |
| Audit | `audit_logs`, append-only (trigger), but requires an organization and an `organization_id` | A platform audit log with admin id, IP, optional target organization |
| Devices | `devices` (model, Android and app version, status, `last_sync_at`), `device_telemetry` (battery, charging, network type, signal dBm, pending offline count) | Temperature, storage, SIM slots, carrier name, roaming, per-SIM send counts, uptime, IP |
| Remote actions | `device_commands` with `PAUSE_RELAY`, `RESUME_RELAY`, `SWITCH_SIM`, `WIPE_AND_REVOKE`, leases, acks, expiry | Force heartbeat, clear queue, push config. Android must implement any new type |
| Kill switches | `organizations.is_active` (enforced), `api_keys.revoked_at`, `DeviceStatus.QUARANTINED` and `REVOKED` | A platform-side action path with audit, SIM-level quarantine |
| Queues | `sms_messages`, `outbound_sms_jobs` (status, lease, attempts, failure code, radio result code), `outbox_events` | Cross-tenant stuck-message query and alert thresholds |
| Webhooks | `webhook_deliveries` (status, response status, attempts) | Per-endpoint health summary, API 4xx and 5xx counters |
| Billing | Plans, versions, entitlements, feature defaults, billing workspace setting | Per-organization overrides for device caps and rate limits, manual credit adjustment entries |
| Abuse | Nothing | Blocklists, keyword rules, volume and failure-rate detection |
| Support access | Nothing | Support view |
| Infra health | `/v1/health`, `/v1/health/ready` | Worker, Redis and certificate-expiry summary for the console |
| Message privacy | `sms_messages.message_text` is stored in clear | Redaction of OTP-like text in platform views |

## 2. Rules for everything below

1. Every platform action that changes state writes a platform audit entry with admin user id, source IP, action, target, previous and new state, and a reason. The reason is required for destructive or sensitive actions (freeze, revoke, quarantine, reveal, credit changes, support view) and optional for catalog edits. The audit table is append-only.
2. Platform views of message content are masked by default. OTP-like digits and message bodies are hidden. Metadata (time, status, carrier error, counts) stays visible. A reveal needs a stated reason and writes an audit entry.
3. Support view is read-only. It does not create a session as the customer and never shows credentials, tokens or key hashes. Each view needs a reason, is time-limited, is audited, and is visible to the customer in their activity log. A "login as" that can act as the customer is not built.
4. No automated guesswork on money. Alerts and abuse scores flag and hold. They never settle, refund or verify payments.
5. Auto-failover only reroutes jobs that have not been handed to a device (`QUEUED`). It never reroutes a job that is dispatching, submitted or `UNCERTAIN`, because that can send a customer's SMS twice.
6. Thresholds, limits, blocklists and carrier rules are data on `/nexus`, never constants in code.
7. Tenant isolation: tenant APIs stay scoped by `organization_id`. Cross-tenant reads exist only behind platform-admin routes.
8. Product A and Product B ledgers stay separate. A credit adjustment is an append-only ledger entry with a reason.

## 3. Phases

Each phase is its own set of commits with tests, and nothing is mixed with infrastructure changes.

### Phase 0: Foundation (first)
- `platform_audit_logs` table, append-only, plus a recorder used by every admin route.
- Existing admin routes (plans, versions, feature defaults, billing workspace) write platform audit entries.
- `/nexus` Billing tab: the billing workspace field (step 2 of the billing plan).
- Platform audit tab: filterable list.

### Phase 1: Tenant directory and kill switches
- Search organizations and users, with devices, active API keys, plan and last activity.
- Freeze or unfreeze an organization (`is_active`), revoke an API key, quarantine a device. All need a reason and are audited.

### Phase 2: Fleet command center (existing data only)
- Cross-tenant device grid: status, app and Android version, last sync, battery, charging, network, signal, pending queue.
- Outdated app version highlight against a minimum version setting.
- Remote actions that already exist: pause, resume, switch SIM, wipe and revoke.

### Phase 3: Early warning
- A worker computes alerts into an `ops_alerts` table: heartbeat drift, low battery, stuck `QUEUED` or `PENDING` messages, silent failure (device online with repeated job failures and no successes), webhook endpoint failures, API error spikes. Thresholds come from settings.
- Console shows open alerts with acknowledge and resolve, both audited.

### Phase 4: Governance
- Per-organization overrides for device cap, rate limit and plan, as audited records.
- Manual credit top-up or deduction as append-only ledger entries with a reason.
- Read-only support view.

### Phase 5: Abuse and compliance
- Blocklists (destination numbers, prefixes, countries, keywords) enforced in the send path, managed on `/nexus`.
- Deterministic detection: volume spikes, failure rate to invalid numbers, flagged keywords and URLs. It raises an alert and can hold a campaign for review.

### Phase 6: Infrastructure and telemetry expansion
- Worker, Redis, database and certificate-expiry health panel.
- Android telemetry extension (temperature, storage, SIM slots, carrier, roaming, per-SIM counts, uptime) with new columns and new command types (force heartbeat, clear queue, push config). This needs Android app work and a compatible-version gate.
- Auto-failover, built last and under rule 5.

## 4. Needs from outside this repo
- Android: any new telemetry field and command type is a client change. The console shows "not reported" until a device sends it.
- Per-SIM and carrier fields depend on what Android allows with the app's granted permissions. Roaming and signal are available on most devices, and per-SIM counts depend on the app tracking its own sends.

## 5. Risks
- The platform admin gate is one shared secret plus any signed-in user who knows it. Audit entries identify the signed-in user. A named allow-list of platform admin user ids, and required two-factor authentication for them, should come before Phase 1 goes to production. To confirm how two-factor is enforced today.
- Support view and message reveal are the most sensitive features. They stay behind a reason, a time limit and an audit entry, and can be left out of an early release.
- Alert thresholds need real traffic to tune. Defaults ship conservative and are editable.
