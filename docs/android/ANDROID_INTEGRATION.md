# BriskSMS Android Application Integration Specification

## 1. Executive Summary & Dual-Product Architecture

The BriskSMS Android application is a mission-critical, enterprise companion operating two strictly decoupled commercial products on a single device:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       BriskSMS Android Companion                            │
├──────────────────────────────────────┬──────────────────────────────────────┤
│ Product A: Payment Intelligence      │ Product B: Bulk Messaging (SMSGate)  │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ • Scoped Notification Ingestion      │ • SMSGate Cellular Gateway           │
│ • Local Regex Normalization          │ • Dual-SIM Slot Selection (1 vs 2)   │
│ • Keystore AES-256-GCM Encryption    │ • Android Foreground Service         │
│ • WorkManager Offline Queue          │ • Paced Cellular Radio Dispatch      │
│ • Evidence Observation API (v1)      │ • Carrier Sent & Delivery ACKs       │
│ • Strictly Non-Authoritative         │ • Zero 3rd-Party Telco Aggregators   │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

These capabilities have separate services, Room databases/tables, queues, permission flows, and operational lifecycles. A failure in one product never impairs the other.

---

## 2. Core Security & Cryptographic Foundation

### 2.1 Hardware-Backed Device Identity (Asymmetric EC P-256)
- **Engine:** `tz.co.brisksms.security.KeystoreManager`
- **Key Storage:** Android Keystore with StrongBox Keymaster hardware security module (fallback to hardware TEE).
- **Asymmetric Curve:** Elliptic Curve NIST P-256 (`secp256r1`, `ECGenParameterSpec("secp256r1")`).
- **Signing Algorithm:** `SHA256withECDSA` (`SHA256_ECDSA` / `EC_P256`).
- **Private Key Isolation:** The private key never leaves secure silicon and cannot be exported (`PRIVATE_KEY_SUBMISSION_FORBIDDEN` if a client ever submits private-key PEM material).
- **Public Key Format & Fingerprint:** Canonical X.509 SubjectPublicKeyInfo (SPKI) PEM (`getPublicKeyPem()`) and lowercase hex SHA-256 of canonical 91-byte SPKI DER (`getPublicKeyFingerprintHex()`).
- **Two-Step Proof-of-Possession Registration:** Android executes `DevicePairingCoordinator` + `DevicePairingProtocol` against `POST /v1/devices/pairing-challenge` followed by signing the canonical binary transcript and completing `POST /v1/devices/pair`. Direct public-key-only registration without a valid server challenge signature is rejected (`PROOF_OF_POSSESSION_REQUIRED`).

### 2.2 Modern Keystore AES-256-GCM Secure Storage
- **Engine:** `tz.co.brisksms.core.storage.KeystoreSecureStorage`
- **Purpose:** Replaces deprecated `EncryptedSharedPreferences` with explicit, non-deprecated Keystore cryptography:
  - 256-bit AES master key stored in Android Keystore.
  - Unique 12-byte randomized Initialization Vector (IV) generated via `SecureRandom` per encryption operation.
  - 128-bit Galois/Counter Mode (GCM) authentication tag verifying ciphertext integrity against tampering.
  - Compound base64 serialization format: `base64(iv):base64(ciphertext)`.
- **Persisted Secrets:** Device bearer tokens (`bsk_dev_...`), SMSGate API tokens, organization ID, and device ID.

### 2.3 Backend Device Authentication Contract
- **Guard:** `apps/api/src/core/guards.ts` (`authenticateDevice`)
- **Header:** `Authorization: Bearer bsk_dev_<random32>`
- **Verification:**
  1. Token hash calculated via SHA-256: `hashToken(rawToken)`.
  2. Device lookup in PostgreSQL database (`devices` table).
  3. Constant-time comparison using `crypto.timingSafeEqual` prevents timing attacks.
  4. Device status check: active devices pass; `REVOKED` devices explicitly return HTTP `403 DEVICE_REVOKED`.
  5. Organization status check: verifies tenant active state.
  6. Context clearance: sets trusted `req.context.deviceId` and `req.context.organizationId` while clearing `req.context.userId` and `req.context.role` to prevent privilege confusion between human users and background relay devices.

---

## 3. Product A: Payment Intelligence Integration

### 3.0 How payment texts reach the app (decision of 22 November 2026)
The product owner reports that the provider apps (CRDB, NMB, Vodacom and others) do not post a notification when money arrives, so payment capture cannot rely on those apps. The payment SMS is the evidence, and the app has two ways to read it:

| Build | Mechanism | Permission | Status |
| :--- | :--- | :--- | :--- |
| `play` | `BriskNotificationListenerService` reads the notification the Messages app shows for a payment SMS (sender shortcode in the title plus an incoming-credit text). | Notification access only. No SMS permission. | Code exists. Not yet verified on a physical phone. Limits: truncated or grouped notifications, a contact name instead of the shortcode, Messages notifications switched off, OEM or Android 15 redaction. |
| `direct` | `tz.co.brisksms.payment.sms.PaymentSmsReceiver` receives `SMS_RECEIVED` and keeps a message only if `PaymentProviderRegistry.isEligibleSmsSource` accepts it. Everything else is dropped on the phone, unread and unstored. The notification path stays on as a fallback. | `RECEIVE_SMS` (not `READ_SMS`). | Built. Not yet verified on a physical phone. |

Both paths end in `tz.co.brisksms.payment.PaymentEvidenceRecorder` (sign, encrypt, store, upload). A payment seen by both paths is de-duplicated on the server (organization, provider, reference), not on the phone. The `direct` build is the one offered for download from the website. The APK is hosted in a Cloudflare R2 bucket, not on the public GitHub releases page, because that page exposes the source code (planned; the website link is a placeholder address until the bucket has a public domain); the `play` build waits for Google's decision on the permission declaration (see `docs/compliance/PLAY_STORE_SMS_POLICY_STUDY.md`).

### 3.1 Scoped Notification Ingestion
- **Service:** `tz.co.brisksms.service.BriskNotificationListenerService`
- **Registry:** `tz.co.brisksms.payment.provider.PaymentProviderRegistry`
- **Permission:** `android.permission.BIND_NOTIFICATION_LISTENER_SERVICE`
- **Scoped Whitelist:** Inspects notifications from the authorized Tanzanian financial application packages below, and from any other app (except blocked personal apps) only when the notification title is a supported shortcode and the text is an incoming credit. These packages are kept for the case where a provider app does post a notification; see 3.0 for what is observed today:
  - **Verified Google Play Store Packages:**
    - `com.vodacom.mpesa` (Vodacom M-Pesa Tanzania)
    - `tz.tigo.mfsapp` (Mixx by Yas / Tigo Pesa Tanzania)
    - `com.airtel.africa.selfcare` (My Airtel Africa / Tanzania)
    - `com.halopesa.eu` (HaloPesa Tanzania)
    - `com.crdb.simbanking` (CRDB SimBanking)
    - `com.nmb.mkononi` (NMB Mkononi)
  - **Provisional & Legacy Aliases:**
    - `com.vodafone.vodapay`, `tz.co.vodacom.mpesa`, `com.mpesa.tz`
    - `com.yas.mixx`, `com.tigo.pesa.tz`
    - `com.airtel.africa.money`
    - `com.halotel.halopesa`
    - `com.crdb.mobile`
    - `com.nmb.mobile`, `com.nmb.direct`
- **Zero Personal Message Leakage:** Personal SMS, chats (WhatsApp, Telegram), and personal banking notifications outside the whitelist are immediately dropped in memory.

### 3.2 Purpose-Limited Relay & Authoritative Server Parsing
- **Filter:** `tz.co.brisksms.payment.provider.PaymentProviderRegistry`
- Filters strictly for authorized Tanzanian financial app packages and carrier shortcodes while rejecting outgoing transfer notifications and personal chats/SMS in memory.
- **Payment-message check (23 November 2026):** a text from a supported shortcode is kept only if it also contains an incoming-credit phrase (the same phrases the server parser accepts), an amount (`Tsh`/`TZS` followed by a digit) and a transaction reference (a leading code such as `QA12BC34DE Imethibitishwa`, or a label such as `Kumbukumbu`, `Ref`, `Txn`, `Transaction ID`, `Namba ya muamala`). It only checks that each is present; reading the values stays on the server. Promos, balances, one-time codes and outgoing money are dropped. The check is meant to be no stricter than the server parsers, so a message the server could parse is never dropped on the phone. A new provider format or a changed wording must be added to both sides.
- **One notification, several texts:** `NotificationTextExtractor` judges the notification title text, the structured message list, the inbox lines and the conversation title separately, so a payment grouped with another message is not lost. A text from a saved contact name or a phone number is still dropped; the filter is deliberately not relaxed for messaging apps, because that would let personal messages in.
- **Zero Client-Side Regex Exposure:** Authoritative carrier regex extraction and E.164/amount normalization occur exclusively on the backend in `packages/parser-engine`, so proprietary carrier parsing patterns are never shipped inside the APK.

### 3.3 Local Evidence Encryption
- **Engine:** `tz.co.brisksms.payment.crypto.EvidenceEncryptor`
- Raw incoming notification payloads are encrypted via Keystore AES-256-GCM with a `bsk_enc_v1:` prefix before persisting in local Room SQLite storage (`OfflineEvidenceEntity`).
- Zero plaintext financial notifications reside in device storage.

### 3.4 WorkManager Offline Synchronization & Non-Settlement Invariant
- **Worker:** `tz.co.brisksms.worker.EvidenceUploadWorker`
- Guarantees at-least-once delivery with exponential backoff.
- Decrypts payload in memory immediately before HTTPS transmission to `POST /v1/ingestion/evidence`.
- **Fundamental Financial Invariant:** Ingesting an evidence notification records observation only (`RawPaymentEvidence`). Ingestion **never** settles invoices, mutates balances, or verifies payments on its own. Reconciled settlement requires independent matching against invoices and settlement ledger rules.

---

## 4. Product B: Bulk Messaging through SMSGate Cellular Relay

### 4.1 Official SMSGate Architecture, Protocol & Schema Invariants
BriskSMS Product B integrates strictly with the official SMSGate architecture (`android-sms-gateway` / `sms-gate.app`). Traditional telco aggregators (Beem, DARSMS, eHUB) and httpSMS are strictly excluded.

#### Base Paths & Upstream Modes:
1. `GatewayMode.MANAGED_GATEWAY`: Connects to an organization's private self-hosted SMSGate server on a VPS (`/api/3rdparty/v1`).
   - *Reverse-Proxy Notice:* The path `/api/v1` is an unverified alias. It is only functional if an external reverse-proxy rewrite rule (e.g. NGINX `rewrite ^/api/v1/(.*)$ /api/3rdparty/v1/$1 break;` or Cloudflare Tunnel) is explicitly deployed and verified. Without this rewrite, native SMSGate servers will return HTTP 404.
2. `GatewayMode.EXTERNAL_RELAY`: Connects to the official SMSGate cloud relay (`https://api.sms-gate.app/3rdparty/v1`) or tenant-provided endpoint.

#### Endpoint Normalization & SSRF Protection Rules:
The backend `SmsGateProvider.resolveEndpoint()` validates and normalizes base URLs dynamically:
- Validates URL scheme: requires `http://` or `https://`.
- Prevents Server-Side Request Forgery (SSRF): blocks destination hostnames resolving to loopback (`127.0.0.1`, `localhost`, `::1`), link-local / cloud metadata (`169.254.169.254`, `metadata.google.internal`), and RFC 1918 private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), unless local development testing explicitly enables `ALLOW_PRIVATE_GATEWAY_NETWORKS=true`.
- Strips trailing slashes: `https://sms.example.com/api/3rdparty/v1/` → `https://sms.example.com/api/3rdparty/v1`.
- Appends `/messages` unless already suffixed with `/messages` or `/message`.

#### Schema Mutual Exclusivity Invariant:
Official SMSGate documentation ([docs.sms-gate.app/features/sending-messages](https://docs.sms-gate.app/features/sending-messages/)) mandates that the message body specifiers are **strictly mutually exclusive**:
- `textMessage`
- `dataMessage`
- `mmsMessage`
- Deprecated `message`

Providing both `textMessage` and `message` is invalid and results in an HTTP 400 Bad Request error. BriskSMS strictly enforces single-field formatting:
```json
{
  "textMessage": {
    "text": "Your message content here"
  },
  "phoneNumbers": ["+255754123456"],
  "simNumber": 1,
  "withDeliveryReport": true
}
```

#### Explicit Credential Configuration:
`SmsGateProvider.buildAuthHeader()` strictly requires explicit credential objects and never guesses from string patterns:
- **HTTP Basic Authentication:** `{ type: 'BASIC', username: '...', password: '...' }` → validates non-empty strings and formats to `Authorization: Basic <base64>`.
- **JWT / Bearer Token:** `{ type: 'BEARER', token: '...' }` → validates non-empty token, decodes JWT structure, verifies that expiration (`exp`) has not passed, and formats to `Authorization: Bearer <token>`.
- **Rejection Policy:** Ambiguous raw strings (such as un-typed colons or random strings) and unknown credential types are rejected with explicit validation errors.

#### Official Webhook Contract, Signing & Replay Defense:
SMSGate delivers delivery reports and status updates via HTTP POST webhooks with nested payloads:
```json
{
  "deviceId": "device_huawei_001",
  "event": "sms:delivered",
  "payload": {
    "messageId": "msg_prov_01J...",
    "recipient": "+255754123456",
    "simNumber": 1,
    "receivedAt": "2026-11-06T15:00:00.000Z"
  }
}
```

- **Official Signing Algorithm:**
  - Header: `X-Signature` contains hexadecimal HMAC-SHA256 signature.
  - Header: `X-Timestamp` contains Unix epoch timestamp in seconds.
  - Signing Input: The exact raw HTTP request body string concatenated directly with the timestamp string: `signingInput = rawBody + timestamp`.
  - Byte-Level Integrity: Raw request bytes must be verified before JSON parsing or reserialization; altered formatting or re-serialization fails verification.
- **Timestamp Validation & Replay Prevention:**
  - Requires integer `X-Timestamp` header.
  - Rejects expired timestamps (> 300 seconds old).
  - Rejects future timestamps outside clock-skew allowance (> 60 seconds in future).
  - Maintains an in-memory replay cache of seen `${signature}:${timestamp}` pairs, rejecting duplicate replays.
- **Per-Device & Per-Organization Key Management:**
  - Managed by `SmsGateKeyService`.
  - Keys are partitioned by `${organizationId}:${deviceId}` or organization gateway.
  - Device keys from Organization A can never verify webhooks for Organization B.
  - Supports key rotation: allows verification against an active `currentKey` and an expiring `previousKey` during a 24-hour transition grace period.
- **Event Lifecycle Mapping:**
  - `sms:sent` → Radio transmission acknowledged by carrier SMSC; mapped to `SUBMITTED`. Does NOT mark message as delivered (`deliveredAt` remains `null`).
  - `sms:delivered` → Handset delivery confirmation receipt; mapped to `DELIVERED`. Sets `deliveredAt = carrierTimestamp`.
  - `sms:failed` → Radio transmission or carrier failure; mapped to `FAILED`.
- **Delivery State Machine & Invariants:**
  1. **Transactional Row-Locking:** `handleDeliveryEvent` executes inside an ACID transaction (`withTransaction`) with row-level locks (`SELECT ... FOR UPDATE`), preventing race conditions.
  2. **Terminal State Immutability:** Once a message reaches `DELIVERED`, it can never transition back to `FAILED`, even if a late or out-of-order `sms:failed` event arrives.
  3. **Exactly-Once Refund Guarantee:** Reserved credits committed upon dispatch are refunded atomically if and only if the message permanently fails (`FAILED`). Delivered messages are never refunded. Out-of-order or duplicate `sms:failed` reports never trigger secondary credit refunds.
  4. **Graceful Handling of Unknown Messages:** If a webhook references an unknown `providerMessageId`, it returns `null` and logs the observation without throwing a 500 server error.

### 4.2 Operating Deployment Models
1. **Model A (Dedicated SMSGate Android Gateway):** The operator runs the official open-source SMSGate Android application (`android-sms-gateway` by capcom6) on the gateway handset. The app synchronizes directly with the SMSGate server via WebSocket/Push. BriskSMS backend orchestrates campaigns and accounting via the SMSGate REST API.
2. **Model B (Integrated Companion Relay):** For single-app operational deployments, the BriskSMS Android Companion embeds `SmsGateRelayService`, executing telephony dispatches locally via Android `SmsManager` with strict idempotency and SIM routing.

### 4.3 Dual-SIM Carrier Management
- **Engine:** `tz.co.brisksms.messaging.sim.SimManager`
- Uses `SubscriptionManager` to detect active SIM cards.
- Normalizes carrier names: `Vodacom`, `Mixx by Yas`, `Airtel`, `Halotel`, `TTCL`.
- Routes outbound messages to designated physical SIM slots: `simSlot: 1` vs `simSlot: 2`.
- Graceful fallback: if a requested slot is empty, falls back to the active cellular subscription.

### 4.4 Foreground Service & Radio Dispatch Engine
- **Service:** `tz.co.brisksms.messaging.service.SmsGateRelayService`
- **Foreground Type:** `connectedDevice` (`ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`).
- **Coordinator & Offline Result Store:** `tz.co.brisksms.messaging.OutboundSmsJobCoordinator` & `tz.co.brisksms.messaging.PendingSmsJobResultStore`
- **Dispatcher:** `tz.co.brisksms.messaging.dispatcher.SmsDispatcher` (Room `BriskDatabase` v3 `SmsDispatchEntity` with `jobId` & `leaseToken`)
- Executes durable Model B job acquisition (`POST /v1/messaging/device-jobs/acquire`), validates destination/SIM hardware capability (without recipient prefix lock-in), persists the local idempotency record, and commits `POST /v1/messaging/device-jobs/:jobId/dispatching` **before** calling `SmsManager`.
- `SmsDispatcher` preserves `DISPATCHING` until `ACTION_SMS_SENT` fires (never fabricating `"cell_..."` provider IDs or prematurely marking `SUBMITTED`/`DELIVERED`).
- Attaches unique `PendingIntent` callbacks for sent and delivery receipts, submitting/persisting reports via Keystore AES-256-GCM (`pendingSmsJobResultsJson`) so outcomes survive process death and flush without re-sending SMS:
  - `ACTION_SMS_SENT`: Carrier radio ACK/NACK verification (`SUBMITTED` or `FAILED`).
  - `ACTION_SMS_DELIVERED`: Handset delivery receipt (`DELIVERED`).
- Internal Pacing Delay: Configurable 1,500ms safety delay between consecutive dispatches to prevent mobile carrier radio throttling.
- Idempotency: Deduplication checks (`jobId`, `idempotencyKey`, and pending result queue) prevent duplicate radio transmissions across `DISPATCHING`, `SUBMITTED`, `DELIVERED`, and `UNKNOWN`.

---

## 5. Device Telemetry & Durable Fleet Command Acquisition

- **Worker:** `tz.co.brisksms.worker.TelemetryWorker`
- **Schedule:** Periodic WorkManager job executed every 15 minutes (plus manual UI triggers).
- **Endpoints:**
  - `POST /v1/devices/:id/telemetry`: Reports telemetry and optional pending `commandAcknowledgements[]`; atomically claims eligible commands (`PENDING` or expired-lease `DELIVERED`) via `FOR UPDATE SKIP LOCKED` and returns them with `leaseToken`.
  - `POST /v1/devices/:id/commands/:commandId/ack`: Immediately acknowledges execution outcome (`ACKNOWLEDGED` or `FAILED`, plus `leaseToken` / `failureReason`). If this immediate ACK fails transiently, `KeystoreSecureStorage.pendingCommandAcksJson` persists it encrypted for inline delivery on the next telemetry poll (and `DeviceCommandProcessor` prevents duplicate local execution while ACK confirmation is pending).
  - `POST /v1/devices/:id/command`, `GET /v1/devices/:id/commands`, `POST /v1/devices/:id/commands/:commandId/cancel`: Owner/Admin fleet command management with payload validation (`PAUSE_RELAY`, `RESUME_RELAY`, `SWITCH_SIM`, `WIPE_AND_REVOKE`), org-scoped `Idempotency-Key`, and explicit cancellation/history.
- **Telemetry Payload:**
  - `batteryPercentage`: Current battery charge (0–100%).
  - `isCharging`: AC or USB charging indicator.
  - `networkType`: `WIFI`, `CELLULAR`, or `NONE`.
  - `pendingOfflineCount`: Sum of unsynced payment evidence and pending SMS dispatches.
  - `commandAcknowledgements` (optional): Deferred `ACKNOWLEDGED`/`FAILED` command outcomes when an immediate `/ack` call failed due to connectivity loss.
- **Revocation & Battery Protection:** If `403 DEVICE_REVOKED` is returned during telemetry, `BriskApiClient` clears local credentials/paired state and `TelemetryWorker` returns `Result.failure()` (halting retries). UI warns operator if battery drops below 20% and device is unplugged.

### 5.1 Relay Alerts (local, no network)

- **Worker:** `tz.co.brisksms.worker.RelayHealthWorker` (WorkManager unique periodic work `BrisksmsRelayHealth`, every 30 minutes, started with the other background workers once the phone is paired). It reads only local counts, so it still works when the network is the problem.
- **Rules (`RelayHealth.problems`, unit-tested):** bulk messaging on and no SIM ready (only when `READ_PHONE_STATE` is granted); bulk messaging on and queued messages older than 30 minutes; payment texts not uploaded for over an hour. A revoked phone stays quiet, and a queue that is meant to wait while messaging is paused is not reported.
- **Notification:** one `relay_alerts` notification (id 4108, "BriskSMS needs attention") updated in place without re-alerting, and removed on the next check that finds nothing wrong. No message text or phone numbers are shown.

### 5.2 Daily Summary (optional)

- **Worker:** `tz.co.brisksms.worker.DailySummaryWorker` (unique periodic work `BrisksmsDailySummary`, every 24 hours, first run at the next 18:00 on the phone's clock). It exists only while the owner has switched on Settings, Notifications, "Daily summary at 18:00" (`KeystoreSecureStorage.isDailySummaryEnabled`, default off), and is cancelled when it is switched off or the phone is unpaired.
- **Content (`DailySummary.lines`, unit-tested):** from local counts for today, "N payment texts captured, M sent to your account" and "N messages sent, M delivered". A day with nothing to report posts nothing. Never message text, phone numbers or amounts.

---

## 6. Jetpack Compose Operator Interface

Adheres to the BriskSMS design system (Stitch warm palette, geometric typography, and optical surfaces).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                Main Screen                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Overview Screen:                                                         │
│    • Device identity, Org ID, truncated Device ID                           │
│    • Operational status (ACTIVE / OFFLINE / REVOKED)                        │
│    • Product A & Product B status badges                                    │
│    • Today's metrics (Captured, Forwarded, Sent, Delivered)                 │
│    • "Sync & Force Upload Now" quick action                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. Payment Intelligence Screen (Product A):                                 │
│    • Notification listener permission banner and direct settings shortcut   │
│    • Monitored provider package badges (M-Pesa, Mixx, Airtel, CRDB, NMB)    │
│    • Offline queue depth metric & AES-256-GCM encryption status             │
│    • Captured notifications feed with masked account digits                 │
│    • "Clear Processed Evidence" button with confirmation                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. Bulk Messaging Screen (Product B):                                       │
│    • Gateway mode badge (MANAGED_GATEWAY vs EXTERNAL_RELAY)                 │
│    • Endpoint URL display                                                   │
│    • Dual-SIM cards (carrier, sent today of the 400-a-day SIM limit)        │
│    • Queue status (Queued, In-Flight, 1.5s / SIM safety pacing)             │
│    • Outbound dispatch feed with masked phone numbers                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Device Health Screen:                                                    │
│    • Cryptographic isolation badge (Hardware TEE vs Standard Keystore)      │
│    • Battery level & charging status (with <20% critical warning)           │
│    • Network interface (Wi-Fi vs Cellular)                                  │
│    • Local database size (KB/MB) and total pending queue                    │
│    • "Send Health Heartbeat Now" force telemetry trigger                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. Settings Screen:                                                         │
│    • Account name and type (Personal / Business), Device attributes         │
│    • Android OS version, companion version, hardware model                  │
│    • Servers card only for a custom API or an external relay                │
│    • Permission shortcuts (Notification, App Permissions, Battery Exemption)│
│    • "Keep running in the background" steps (Samsung, Xiaomi, Tecno family) │
│    • "Lock with screen lock" (phone's PIN/pattern/password; off by default) │
│    • "Daily summary at 18:00" (counts only; off by default)                 │
│    • "Share diagnostics with support" (settings and counts only)            │
│    • "Unpair this phone" (tells the server, then wipes the phone)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6A. App Updates

How the phone learns about and installs a new version depends on the build flavor.

- **`play`:** Google Play delivers updates. Settings has one row, "Check for updates in Google Play", that opens the Play listing (`market://`, with an `https://play.google.com` fallback). The app makes no update request of its own and holds no install permission.
- **`direct`:** `tz.co.brisksms.update.UpdateEngine` is a process-wide engine (state in a `StateFlow`, so a download survives leaving Settings). Settings, section "App updates", drives it:
  1. **Check:** `GET {apiBaseUrl}/v1/app/releases/latest?versionCode=<installed>`. The endpoint is public, rate limited per IP, and reads the published release from the `APP_RELEASE_*` variables (see `docs/reports/ENVIRONMENT_VARIABLE_INVENTORY.md`). It returns `updateAvailable`, `required` (installed version below `APP_RELEASE_MIN_SUPPORTED_VERSION_CODE`) and the release (`versionCode`, `versionName`, `apkUrl`, `sha256`, `notes`). The phone does not trust `updateAvailable`: it re-compares the version code and rejects a release whose URL is not `https` or whose checksum is not 64 hex characters.
  2. **Download:** the APK is streamed to `cacheDir/updates` and hashed as it arrives. The file is deleted unless it is complete, at most 150 MB, and matches the published SHA-256. Package name and version code are then read from the archive and must be this app at the promised version.
  3. **Install:** the file goes to the system installer through a `FileProvider`. If Android has not allowed installs from BriskSMS yet, the "Install unknown apps" screen opens first. Android refuses the APK unless it is signed with the same key as the installed app.
  
  4. **Update window:** `UpdatePromptHost` (in `MainActivity`) calls `UpdateEngine.autoCheck()` whenever the app opens or returns to the front (quietly, at most once an hour, and a failed check shows nothing). When a newer release exists it opens a window with the new version, what is new (`notes`) and two buttons, **Update now** (download, then Install) and **Not now**. "Not now" is stored in the app's private preferences (`UpdateReminder`: release version code and a time 24 hours ahead); the window opens again on the first launch or resume after that time. A newer release, a required update, or a phone clock set back past the snooze open it immediately. A required update (installed version below `APP_RELEASE_MIN_SUPPORTED_VERSION_CODE`) has no **Not now** and cannot be dismissed. The window is held back while the welcome screen or the SMS disclosure is showing.

  5. **Background check and reminder:** `UpdateCheckWorker` (WorkManager, unique periodic work `BrisksmsUpdateCheck`, every 12 hours, network required) runs the same check without the app open. On an unmetered network (Wi-Fi) it also downloads and verifies the APK, so the owner needs one tap to install; on mobile data it only checks, because customers pay for their bundles. If a release is waiting it posts one notification on the `app_updates` channel, at most once every 24 hours per release (a newer release notifies at once). The notification says "available" or "ready to install" and shows the notes. Tapping it opens the app and the update window even when "Not now" is still active (the snooze is cleared). It is removed when the phone is up to date. A verified download of the same release is reused instead of fetched again, and any other file in `cacheDir/updates` is deleted.

  Android always asks the owner to confirm an install of an app that is not a system app, so there is no silent update: the background download removes the wait, not the confirmation.

  The engine uses its own HTTP client, not `BriskApiClient`, so the device token is never sent to the download host.

Publishing a release today means setting the `APP_RELEASE_*` variables and redeploying the API.

---

## 7. Setup & Pairing Workflow

### 7.1 Web Admin Enrollment
1. Administrator navigates to Organization Settings > Devices in BriskSMS Web Console.
2. Clicks "Pair Android Companion".
3. Backend generates single-use token (`bsk_pair_...`, TTL: 300s) and QR code containing:
   ```json
   {
     "token": "bsk_pair_...",
     "org": "org_cly...",
     "endpoint": "https://api.brisksms.app"
   }
   ```

### 7.2 Android Device Enrollment (Challenge-Response Proof-of-Possession)
0. **First launch only:** before `PairingScreen`, the companion shows a four-page swipeable onboarding carousel (`ui/onboarding/WelcomeScreen.kt`) with illustrations, a page indicator, Skip and Get started. The pages cover payment alert matching, what the listener reads and ignores, bulk SMS from the SIM, and the runtime permissions Android is about to request. Those permissions (§9.1) are requested when the operator taps Get started or Skip, not at startup. Once the pages are dismissed, a plain `brisksms_welcome` SharedPreferences flag records it (not secure storage, so unpairing does not bring the pages back). Already-paired installs never see them. On later launches, permissions are requested at startup as before.
1. Operator opens BriskSMS Relay companion (`PairingScreen`) and scans or pastes the QR payload (`token`, `org`, `endpoint`, `exp`).
2. Companion ensures or generates a hardware EC P-256 (`secp256r1`) key pair in Android Keystore (`KeystoreManager.ensureDeviceKeyPair()`), exports canonical X.509 SPKI PEM (`getPublicKeyPem()`), and computes its SHA-256 DER fingerprint (`getPublicKeyFingerprintHex()`).
3. **Step 1 (`POST /v1/devices/pairing-challenge`):** Companion submits `enrollmentToken`, `publicKeyPem`, optional `organizationId`, `keyAlgorithm: "EC_P256"`, and `signatureAlgorithm: "SHA256_ECDSA"`.
   - Backend validates the token (`FOR UPDATE`), curve/key encoding (`EC_P256`), key uniqueness (`PUBLIC_KEY_ALREADY_REGISTERED`), and org quota, then issues a single-use challenge (`challengeId`, `enrollmentId`, 256-bit `challenge` nonce, `publicKeyFingerprint`, `expiresAt`) persisted in `device_pairing_challenges` (`PENDING`, TTL `PAIRING_CHALLENGE_TTL_SECONDS`, default `120s`, capped by pairing token expiry).
4. **Canonical Signing (`DevicePairingProtocol.buildPairingChallengeTranscript`):** Companion verifies the challenge metadata (`protocolVersion == "BRISKSMS-DEVICE-PAIRING-POP-V1"`, matching `organizationId`, matching `publicKeyFingerprint`, non-expired `expiresAt`), constructs the length-prefixed binary transcript (`uint32be(byteLength) || utf8(field)` over the 10 ordered fields: `protocolVersion`, `challengeId`, `enrollmentId`, `organizationId`, `sha256Hex(enrollmentToken)`, `publicKeyFingerprint`, `keyAlgorithm`, `signatureAlgorithm`, `challengeNonce`, `expiresAtIso`), and signs it with the Keystore EC P-256 private key (`SHA256withECDSA`).
5. **Step 2 (`POST /v1/devices/pair`):** Companion submits `enrollmentToken`, `challengeId`, `enrollmentId`, `organizationId`, `publicKeyPem`, `keyAlgorithm`, `signatureAlgorithm`, `challengeSignature`, and device metadata.
   - Backend acquires locks in strict order (`pairing_tokens -> device_pairing_challenges -> devices`), verifies token/challenge state, binding, expiry, key fingerprint, ASN.1 DER ECDSA signature, and quota, rejects silent key replacement (`DEVICE_KEY_REPLACEMENT_FORBIDDEN`, `PUBLIC_KEY_ALREADY_REGISTERED`), atomically marks the challenge `CONSUMED` and token used, and registers the device with its normalized PEM and unique `publicKeyFingerprint`.
   - The 200 reply carries `deviceId`, `organizationId`, `deviceToken`, `publicKeyFingerprint`, `keyAlgorithm`, `syncIntervalSeconds` and, for display only, `organizationName` and `accountType` (`PERSONAL` or `ORGANIZATION`). The phone shows the name and a Personal/Business type instead of the raw ID. A phone paired before these fields existed has neither and shows the short organization ID until it is paired again.
   - Failed challenge verification transitions `device_pairing_challenges` to `REJECTED` or `EXPIRED` with an audit log without creating a device.
   - **Key Error Codes:** `PROOF_OF_POSSESSION_REQUIRED`, `CHALLENGE_EXPIRED`, `CHALLENGE_ALREADY_CONSUMED`, `CHALLENGE_BINDING_MISMATCH`, `PUBLIC_KEY_MISMATCH`, `INVALID_CHALLENGE_SIGNATURE`, `PUBLIC_KEY_ALREADY_REGISTERED`, `DEVICE_KEY_REPLACEMENT_FORBIDDEN`, `UNSUPPORTED_PUBLIC_KEY`, `UNSUPPORTED_CRYPTO_ALGORITHM`, `INVALID_PUBLIC_KEY`, `PRIVATE_KEY_SUBMISSION_FORBIDDEN`.
6. **Commit Local State Only After Server 200 OK:** Companion stores `bsk_dev_...` and device metadata in Keystore AES-256-GCM storage (`KeystoreSecureStorage`) only after HTTP 200 OK, and deletes both secure storage and the Keystore key alias on disconnect (`SettingsScreen`).
7. **Unpair Frees the Plan Slot:** "Unpair this phone" first calls `POST /v1/devices/:id/disconnect` with the device token (`BriskApiClient.disconnectDevice`). The server sets the device `REVOKED` (reason "Unpaired from the phone", audit action `DEVICE_DISCONNECTED` with actor type `DEVICE`), cancels its pending commands, and it stops counting against the plan's device limit. A `401` or `403` reply means the server already forgot the device and counts as done. If the server cannot be reached the dialog stays open with **Try again** and **Unpair anyway**; unpairing anyway only wipes the phone, and the owner must then revoke the device from the web console (`POST /v1/devices/:id/revoke`) to free the slot.


---

## 8. Android Toolchain & Build Instructions

### 8.1 Toolchain Requirements
- **JDK:** Java 17 (LTS) - required by AGP 8.3.1.
- **Gradle:** Gradle 8.14.3 (cached distribution available in monorepo wrapper).
- **Android Gradle Plugin:** AGP `8.3.1`.
- **Kotlin:** Kotlin `1.9.23` with Compose Compiler Extension `1.5.11`.
- **Android SDK:**
  - `compileSdk`: `34` (Android 14)
  - `targetSdk`: `34` (Android 14)
  - `minSdk`: `26` (Android 8.0 Oreo - required for NotificationListenerService and modern Keystore features)

### 8.2 Building the Companion Application
To compile and assemble the debug APK:
```bash
cd apps/android
./gradlew assembleDebug
```
Output artifact: `apps/android/app/build/outputs/apk/debug/app-debug.apk`

To execute Android JVM unit test suites:
```bash
cd apps/android
./gradlew testDebugUnitTest
```

### 8.3 CI Automation & Local Environment Isolation
The repository includes automated CI verification for Android via GitHub Actions (`.github/workflows/ci.yml`):
- **Job:** `android-verify` on `ubuntu-latest`.
- **JDK:** OpenJDK 17 (`temurin` distribution) with Gradle dependency caching.
- **Android SDK:** Configured with API level 34 (`platforms;android-34`) and Build Tools `34.0.0`.
- **Tasks Executed in CI:**
  1. `chmod +x ./gradlew` (ensures execution bit `100755` tracked in Git).
  2. `./gradlew testDebugUnitTest --no-daemon --stacktrace`
  3. `./gradlew assembleDebug --no-daemon --stacktrace`
- **Local Host vs CI Environment Note:**
  Local Linux developer workstations often install bleeding-edge Java (e.g. OpenJDK `25-ea`), which Gradle 8.14.3 deliberately halts on with `What went wrong: 25.0.5-ea`. Reproducible builds and unit tests are guaranteed via the standardized JDK 17 CI runner or local JDK 17 environment (`sdk use java 17-tem`).

---

## 9. Permissions & Telephony Management

### 9.1 Required Android Permissions
| Permission | Product Scope | Justification & Policy |
| :--- | :--- | :--- |
| `android.permission.INTERNET` | Shared | Communicating with BriskSMS API and SMSGate relay server over HTTPS. |
| `android.permission.ACCESS_NETWORK_STATE` | Shared | Network type detection (Wi-Fi vs Cellular) for telemetry and WorkManager constraints. |
| `android.permission.RECEIVE_BOOT_COMPLETED` | Shared | Automatically resurrecting synchronization workers and foreground gateway on device boot. |
| `android.permission.POST_NOTIFICATIONS` | Shared | Android 13+ requirement to display the ongoing SMSGate cellular gateway foreground notification. |
| `android.permission.BIND_NOTIFICATION_LISTENER_SERVICE` | Product A | Required to intercept financial notifications from whitelisted payment apps. |
| `android.permission.RECEIVE_SMS` | Product A (`direct` build only) | Receive payment texts from supported shortcodes. Not `READ_SMS`. Anything else is dropped on arrival. Absent from the `play` build. |
| `android.permission.REQUEST_INSTALL_PACKAGES` | Shared (`direct` build only) | Hand a downloaded, checksum-verified update to the system installer. Absent from the `play` build, which updates through Google Play. |
| `android.permission.SEND_SMS` | Product B | Telephony radio access to transmit cellular SMS messages via `SmsManager`. |
| `android.permission.READ_PHONE_STATE` | Product B | Enumerate active SIM subscriptions, carrier names, and dual-SIM slots via `SubscriptionManager`. |
| `android.permission.FOREGROUND_SERVICE` | Product B | Keep the SMSGate cellular gateway listening and dispatching reliably in background. |
| `android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE` | Product B | Android 14+ compliant foreground service type for cellular peripheral gateway operations. |
| `android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Product B | Prevent OS Doze mode from killing carrier keepalive connections during unattended operation. |

---

## 10. Product Entitlement Behavior & Authorization

The Android companion dynamically queries and respects the organization's backend entitlements:

1. **Payment Intelligence Entitlement (`isPaymentIntelligenceEnabled`):**
   - When enabled: `BriskNotificationListenerService` actively captures and encrypts payment notifications. `EvidenceUploadWorker` uploads records.
   - When disabled: Ingestion is halted in memory; all incoming notifications are dropped; no evidence is persisted or uploaded.
2. **Bulk Messaging Entitlement (`isBulkMessagingEnabled`):**
   - When enabled: `SmsGateRelayService` runs as a foreground service and executes carrier dispatches from `sms_dispatch_queue`.
   - When disabled: Foreground service terminates immediately; queue polling ceases; no SMS messages are dispatched via cellular radio.
3. **Revocation Invariant (`isRevoked`):**
   - If an administrator revokes a device via the Web Console, the backend returns HTTP `403 DEVICE_REVOKED`.
   - Both Product A and Product B background loops immediately terminate, and local credentials are invalidated.

---

## 11. Testing & Verification Guide

### 11.1 Backend Device Authentication & Ingestion Tests
Executed using Bun / Node test runner:
```bash
bun test apps/api/test/device-auth-and-ingestion.test.ts
```
Covers:
- Valid bearer token authorization.
- Token hashing verification using `crypto.timingSafeEqual`.
- Revoked device rejection (`403 DEVICE_REVOKED`).
- Ingestion endpoint `POST /v1/ingestion/evidence`.
- Idempotent handling of duplicate payment notifications.
- Financial settlement separation (notification ingestion NEVER settles invoices).

### 11.2 Android Unit Tests
Located in `apps/android/app/src/test/java/tz/co/brisksms/`:
- `PaymentProviderRegistryTest`: Validates verified Google Play Store packages vs provisional aliases, incoming credit filtering, and shortcode/personal-sender filtering.
- `EvidenceEncryptionLogicTest`: Validates authenticated AES-256-GCM encryption, decryption, 12-byte IV uniqueness, and authentication-tag failure on tampered payloads.
- `SmsGateProtocolTest`: Validates official SMSGate 3rdparty v1 schema formatting, lifecycle state mapping (`sms:sent`, `sms:delivered`, `sms:failed`), and ambiguous retry prevention.
- `SmsDispatcherLogicTest`: Validates state machine separation between radio submission (`SUBMITTED`) and handset delivery (`DELIVERED`), idempotency keys, and multipart message thresholds.
- `SimManagerLogicTest`: Validates Tanzanian telco normalization, dual-SIM slot mapping, and subscription fallback.
- `OutboundSmsJobCoordinatorTest`: Validates outbound SMS job payload gating, SIM selection decoupled from recipient phone prefixes, duplicate-dispatch prevention, `/dispatching` pre-radio gate enforcement, and pending result reconciliation.
- `DeviceCommandQueueTest` & `DevicePairingProofOfPossessionTest`: Validates fleet command allowlists, ACK deduplication, EC P-256 transcript signing, and PoP key binding.
- `UpdateRulesTest`: Validates the release reply (newer only, `https` only, checksum required, unreadable replies refused), the 24-hour "Not now" rule (silent until 24 hours pass, immediate for a newer or required release or a clock set back) the reminder-notification rule (once per release per 24 hours, immediately for a newer release or a clock set back) and the download integrity rules (matching checksum kept; mismatch, truncation and oversize deleted; an earlier download is reused only if it still matches).
- `ProductIsolationTest`: Invariant checks verifying complete database, queue, and entitlement separation between Product A and Product B.

---

## 12. Known Limitations & Operating Boundaries

1. **Hardware Telephony Dependency:**
   - Cellular SMS dispatch requires physical SIM card hardware installed in an Android device. Emulators without active GSM radio simulation cannot transmit real carrier SMS.
2. **Notification Listener OS Binding:**
   - Android requires the user to explicitly grant "Notification Access" in Android System Settings. Third-party apps cannot programmatically grant this permission; the companion UI provides a direct shortcut to system settings.
3. **Google Play Policy Scoping:**
   - `SEND_SMS`, `RECEIVE_SMS` and `BIND_NOTIFICATION_LISTENER_SERVICE` are sensitive. On Google Play the SMS permissions need an approved exception in the Permissions Declaration Form; the closest listed one is "SMS-based financial transactions", which lists RECEIVE_SMS, READ_SMS and SEND_SMS (approval is Google's decision and is not guaranteed). Until then the `direct` build is distributed from the website. No exception named "Enterprise Device Gateway" exists on Google's page.
4. **Carrier Radio Pacing & Safety Throttle:**
   - Cellular radio hardware requires safe dispatch pacing. The dispatcher enforces an internal engineering default of 1,500ms pacing delay between consecutive dispatches to prevent mobile carrier radio throttling and radio queue exhaustion.
5. **App Lock Scope:**
   - "Lock with screen lock" (Settings, Security; `KeystoreSecureStorage.isAppLockEnabled`, default off) asks for the phone's own PIN, pattern, password or fingerprint through `KeyguardManager.createConfirmDeviceCredentialIntent` when the app opens and after it has been away for more than 60 seconds. It covers the screens only: payment capture, the relay and background sync keep running while locked. It does nothing if the phone has no screen lock (the toggle explains this), so an owner who later removes the phone's screen lock is not locked out.
6. **Keep-Running Guide Is Unverified On Real Phones:**
   - `BackgroundGuide` lists where Samsung, Xiaomi (Redmi, POCO) and Tecno, Infinix and itel phones usually hide their background-app limits; any other maker gets the generic battery steps. The wording comes from the makers' general menu layout and has not been checked on physical devices (see section 13). Menu names change between versions, so the dialog says "usually".
7. **Support Diagnostics Content:**
   - "Share diagnostics with support" (`SupportBundle`) sends one plain-text block through the Android share sheet: app version and flavor, phone model and Android version, paired state and device ID, account type, server host, gateway mode, SIM count, permission and battery-exemption state, and queue counts. It never includes tokens, message text, phone numbers, payment details or the full server URL.

---

## 13. Physical Device Validation Checklist

The following capabilities require real Android physical hardware with active local Tanzanian SIM cards (Vodacom, Mixx by Yas, Airtel, Halotel) and cannot be proven by JVM tests alone:

| Check | Required Hardware / Configuration | Expected Outcome |
| :--- | :--- | :--- |
| **Notification Listener Permission Prompt** | Physical device running Android 8.0 - 14 | System dialog directs user to Notification Access screen; app displays green "ACTIVE" badge upon return. |
| **Real Payment SMS (direct build)** | Physical device with the direct build, paired, a real mobile money payment received | The payment SMS is accepted by the receiver, stored encrypted, uploaded, and appears in the Reconciliation feed. A personal-number SMS and an OTP SMS received at the same time create no evidence. | 
| **Real Payment SMS (play build)** | Physical device with the play build and Messages notifications on | The Messages notification is captured through the listener. Repeat with the screen off and with Messages open. | 
| **Real Payment App Interception** | Physical device with installed M-Pesa / Mixx app | Real incoming financial notification is captured, encrypted via Keystore AES-256-GCM, and inserted into Room database. |
| **Zero Personal Chat Leakage** | WhatsApp / SMS message received | Incoming message is dropped in memory; zero non-financial notifications appear in database or logs. |
| **StrongBox Hardware Keystore** | Device supporting hardware StrongBox Keymaster | Key pair generated with `setIsStrongBoxBacked(true)` successfully seals private key inside tamper-resistant hardware silicon. |
| **Dual-SIM Slot Enumeration** | Device with 2 physical SIMs inserted | UI and `SimManager` accurately detect Slot 1 (Carrier A) and Slot 2 (Carrier B) with valid subscription IDs. |
| **Cellular SMS Transmission** | Active local SIM with carrier credit | Message dispatched via `SmsManager.sendMultipartTextMessage()`; carrier radio tower accepts dispatch (`RESULT_OK`). |
| **SMSC Sent & Handset DLR Receipts** | Real recipient handset receiving SMS | Sent BroadcastReceiver receives radio confirmation (`SUBMITTED`); delivery BroadcastReceiver receives handset confirmation (`DELIVERED`). |
| **Foreground Keepalive Across Doze** | Device unplugged and screen turned off for > 1 hour | Foreground notification remains pinned; service continues listening without being killed by Android Doze. |
| **Offline Buffering & Network Reconnection** | Airplane mode toggled during payment/SMS queue | WorkManager buffers records locally; upon reconnecting Wi-Fi/LTE, exponential backoff flushes queue to backend. |

---

## 14. Provider Package Verification & Ingestion Status

To preserve engineering integrity and avoid unwarranted claims of verified hardware integrations, the operational status of all Tanzanian financial providers is categorized as follows:

| Provider / Channel | Package Name | Regex Parser Status | Real Device Capture Status |
| :--- | :--- | :--- | :--- |
| **Vodacom M-Pesa (Swahili)** | `com.vodacom.mpesa` | **VERIFIED** against real anonymized SMS corpus | **PROVISIONAL** (pending physical device test) |
| **Vodacom Lipa Till** | `com.vodacom.mpesa` | **VERIFIED** against real Till transaction corpus | **PROVISIONAL** (pending physical device test) |
| **Mixx by Yas (Tigo Pesa)** | `tz.tigo.mfsapp` | **VERIFIED** against real anonymized SMS corpus | **PROVISIONAL** (pending physical device test) |
| **Airtel Money** | `com.airtel.africa.selfcare` | **VERIFIED** against real anonymized SMS corpus | **PROVISIONAL** (pending physical device test) |
| **CRDB SimBanking** | `com.crdb.simbanking` | **VERIFIED** against real credit alert corpus | **PROVISIONAL** (pending physical device test) |
| **HaloPesa** | `com.halopesa.eu` | **PROVISIONAL** (schema defined) | **UNTESTED** on hardware |
| **NMB Mkononi** | `com.nmb.mkononi` | **PROVISIONAL** (schema defined) | **UNTESTED** on hardware |
| **Legacy / Secondary Aliases** | `com.vodafone.vodapay`, `com.yas.mixx`, etc. | Filtered through whitelist | Dropped unless matching verified canonical format |

---

## 15. Milestone 2.5: Persistent Key Management, Webhook Reliability & Database Proof

### 15.1 Persistent Signing Key Management & Encryption at Rest
- **Table:** `smsgate_signing_keys` in PostgreSQL.
- **Encryption Scheme:** AES-256-GCM authenticated cipher with 96-bit randomized IV and 128-bit authentication tag.
- **Fail-Closed Governance:** Decryption requires `ENCRYPTION_MASTER_KEY` (32 bytes). Missing, invalid, or tampered keys reject immediately without falling back to plaintext or null.
- **Tenant & Device Scoping:** Keys are strictly isolated by `organization_id` and optional `device_id` with a database unique index `(organization_id, COALESCE(device_id, '__ORG_DEFAULT__'))`.
- **Key Rotation Grace Period:** Stores `encrypted_key` and `encrypted_prev_key` with a 24-hour overlap grace window, allowing both old and new keys to verify in-flight delivery reports.
- **Audit Logging:** Provisions, rotations, and revocations write immutable audit records to `audit_logs` (`SMSGATE_KEY_PROVISIONED`, `SMSGATE_KEY_ROTATED`, `SMSGATE_KEY_REVOKED`).

### 15.2 Distributed Webhook Replay Protection & Idempotency
- **Table:** `smsgate_webhook_events` in PostgreSQL.
- **Event Fingerprint:** `sha256(organizationId + ':' + providerMessageId + ':' + eventType + ':' + signature)`.
- **Deduplication Invariant:** Retried delivery reports from SMSGate or network hiccups return HTTP `200` with `{ "duplicate": true }` and do **not** re-trigger credit mutations or ledger changes.
- **Transactional State Locking:** Status updates execute within ACID transactions using `SELECT ... FOR UPDATE` row locks, ensuring that out-of-order `FAILED` reports never revert a `DELIVERED` message or trigger double refunds.

### 15.3 HTTP Raw-Body Verification Route
- **Route:** `POST /v1/messaging/webhooks/smsgate` registered in `apps/api/src/app.ts`.
- **Middleware:** `RouteRequest.rawBody` preserves the unparsed request string directly from the HTTP socket.
- **Signing Input:** Conforms strictly to official SMSGate specification: `rawBody + timestamp` (exact bytes concatenated).
- **Diagnostics:** Distinct error codes for expired timestamps (`TIMESTAMP_EXPIRED`), future clock skew (`FUTURE_TIMESTAMP`), missing signing keys (`MISSING_SIGNING_KEY`), and invalid signatures (`INVALID_SIGNATURE`).

### 15.4 Opaque Bearer Token Semantics
- SMSGate API tokens (e.g. `smsgate_pat_...`) and pre-formatted headers are treated as opaque bearer credentials.
- JWT expiration checks (`exp`) serve solely as non-authoritative client-side operational guards and do not attempt unsupported cryptographic issuer verification without public keys.

### 15.5 Monorepo Automated Test Corpus
- **Monorepo Suite:** 153 tests across 20 files executing in 19.33s against real PostgreSQL (port 5433) and Redis (port 6380) with 0 failures and 0 mocks in financial persistence paths.
- **Milestone 2.5 Test Corpus:**
  - `apps/api/test/smsgate-webhook-and-keys.test.ts`: 8/8 passed.
  - `apps/api/test/smsgate-contract.test.ts`: 30/30 passed.
  - `apps/api/test/messaging.test.ts`: 21/21 passed.
  - `apps/api/test/device-auth-and-ingestion.test.ts`: 11/11 passed.

