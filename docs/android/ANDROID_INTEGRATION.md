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
- **Asymmetric Curve:** Elliptic Curve NIST P-256 (`secp256r1`).
- **Signing Algorithm:** `SHA256withECDSA`.
- **Private Key Isolation:** The private key never leaves secure silicon and cannot be exported.
- **Registration:** Base64-encoded public key (`getPublicKeyBase64()`) is transmitted to `POST /v1/devices/pair` during device enrollment.

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

### 3.1 Scoped Notification Ingestion
- **Service:** `tz.co.brisksms.service.BriskNotificationListenerService`
- **Registry:** `tz.co.brisksms.payment.provider.PaymentProviderRegistry`
- **Permission:** `android.permission.BIND_NOTIFICATION_LISTENER_SERVICE`
- **Scoped Whitelist:** Only inspects notifications originating from authorized Tanzanian financial application packages:
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

### 3.2 Client-Side Provider Normalization
- **Engine:** `tz.co.brisksms.payment.parser.ProviderNotificationParser`
- Parses transaction reference, sender phone number, sender name, and currency amounts in Tanzanian Shilling cents (`amountCents`).
- Normalizes phone numbers to standard E.164 (`+255...`).
- Zero automated guesswork: if regex pattern match is ambiguous, parser returns `null` or defers to server-side parser engine.

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
1. `GatewayMode.MANAGED_GATEWAY`: Connects to an organization's private self-hosted SMSGate server on a VPS (`/api/3rdparty/v1`) or behind Cloudflare Tunnel / reverse-proxy rewrite (`https://gateway.brisksms.com/api/v1`).
2. `GatewayMode.EXTERNAL_RELAY`: Connects to the official SMSGate cloud relay (`https://api.sms-gate.app/3rdparty/v1`) or tenant-provided endpoint.

#### Endpoint Normalization Rules:
The backend `SmsGateProvider.resolveEndpoint()` normalizes base URLs dynamically:
- Validates URL scheme: requires `http://` or `https://`.
- Strips any trailing slashes: `https://gateway.example.com/api/3rdparty/v1/` → `https://gateway.example.com/api/3rdparty/v1`.
- Appends `/messages` unless already suffixed with `/messages` or `/message`.
- Reverse Proxy Path Rewriting: When fronted by NGINX or Cloudflare Tunnel, ensure path rewrites preserve either `/api/3rdparty/v1/messages` (upstream server default) or `/3rdparty/v1/messages` (upstream cloud relay default).

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

#### Authentication Header Support:
`SmsGateProvider.buildAuthHeader()` dynamically detects and crafts the appropriate authorization header:
- **HTTP Basic Authentication:** If credentials contain a colon (`username:password`) or `Basic `, converts to standard Base64 `Authorization: Basic <base64>`.
- **JWT / Bearer Token:** If credentials contain a single token string or `Bearer `, crafts `Authorization: Bearer <token>`.

#### Official Webhook Contract & Payload Schema:
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

- **HMAC Signature Verification:** Incoming webhooks are signed using HMAC-SHA256. The raw request body is verified against the `X-Signature` header using the organization's gateway signing secret via `crypto.timingSafeEqual`.
- **Event Lifecycle Mapping:**
  - `sms:sent` → Radio transmission acknowledged by carrier SMSC; mapped to `SUBMITTED`. Does NOT mark message as delivered.
  - `sms:delivered` → Handset delivery confirmation receipt; mapped to `DELIVERED`. Sets `deliveredAt = carrierTimestamp`.
  - `sms:failed` → Radio transmission or carrier failure; mapped to `FAILED`.
- **Delivery State Machine & Invariants:**
  1. **Terminal State Immutability:** Once a message reaches `DELIVERED`, it can never transition back to `FAILED`, even if a late or out-of-order `sms:failed` event arrives.
  2. **Exactly-Once Refund Guarantee:** Reserved credits committed upon dispatch are refunded if and only if the message permanently fails (`FAILED`). Delivered messages are never refunded. Out-of-order or duplicate `sms:failed` reports never trigger secondary credit refunds.
  3. **Graceful Handling of Unknown Messages:** If a webhook references an unknown `providerMessageId` (e.g. from an unmanaged broadcast or deleted test), it returns `null` and logs the observation without throwing a 500 server error.

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
- **Dispatcher:** `tz.co.brisksms.messaging.dispatcher.SmsDispatcher`
- Manages multi-part and single-part SMS dispatch via Android `SmsManager`.
- Attaches unique `PendingIntent` callbacks for sent and delivery receipts:
  - `ACTION_SMS_SENT`: Carrier radio ACK/NACK verification (`SUBMITTED` or `FAILED`).
  - `ACTION_SMS_DELIVERED`: Handset delivery receipt (`DELIVERED`).
- Internal Pacing Delay: Configurable 1,500ms safety delay between consecutive dispatches to prevent mobile carrier radio throttling.
- Idempotency: Deduplication check prevents duplicate radio transmissions. Unconfirmed outcomes (`UNKNOWN`) are never blindly retried.

---

## 5. Device Telemetry & Health Monitoring

- **Worker:** `tz.co.brisksms.worker.TelemetryWorker`
- **Schedule:** Periodic WorkManager job executed every 15 minutes.
- **Endpoint:** `POST /v1/devices/:id/telemetry`
- **Telemetry Payload:**
  - `batteryPercentage`: Current battery charge (0–100%).
  - `isCharging`: AC or USB charging indicator.
  - `networkType`: `WIFI`, `CELLULAR`, or `NONE`.
  - `pendingOfflineCount`: Sum of unsynced payment evidence and pending SMS dispatches.
- Battery protection: UI warns operator if battery drops below 20% and device is unplugged.

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
│    • Dual-SIM active cards (SIM 1 / SIM 2 carriers, today's sent count)     │
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
│    • Organization ID and Device attributes                                  │
│    • Android OS version, companion version, hardware model                  │
│    • API & SMSGate endpoint URLs                                            │
│    • Permission shortcuts (Notification, App Permissions, Battery Exemption)│
│    • "Disconnect & Unpair Device" with confirmation dialog                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

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
     "endpoint": "https://api.brisksms.co.tz"
   }
   ```

### 7.2 Android Device Enrollment
1. Operator opens BriskSMS Relay companion.
2. Pastes QR payload or manual pairing code.
3. Companion reads or generates hardware EC P-256 key pair in Android Keystore.
4. Companion calls `POST /v1/devices/pair`.
5. Backend verifies token, binds device public key, registers hardware metadata, and issues device Bearer token (`bsk_dev_...`).
6. Companion securely stores token in Keystore AES-256-GCM storage and launches background workers.


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
- `ProviderNotificationParserTest`: Comprehensive tests for Vodacom M-Pesa, Mixx by Yas, Airtel Money, CRDB Bank, and personal message filtering.
- `PaymentProviderRegistryTest`: Validates verified Google Play Store packages vs provisional aliases and shortcode filtering.
- `EvidenceEncryptionLogicTest`: Validates authenticated AES-256-GCM encryption, decryption, 12-byte IV uniqueness, and authentication-tag failure on tampered payloads.
- `SmsGateProtocolTest`: Validates official SMSGate 3rdparty v1 schema formatting, lifecycle state mapping (`sms:sent`, `sms:delivered`, `sms:failed`), and ambiguous retry prevention.
- `SmsDispatcherLogicTest`: Validates state machine separation between radio submission (`SUBMITTED`) and handset delivery (`DELIVERED`), idempotency keys, and multipart message thresholds.
- `SimManagerLogicTest`: Validates Tanzanian telco normalization, dual-SIM slot mapping, and subscription fallback.
- `ProductIsolationTest`: Invariant checks verifying complete database, queue, and entitlement separation between Product A and Product B.

---

## 12. Known Limitations & Operating Boundaries

1. **Hardware Telephony Dependency:**
   - Cellular SMS dispatch requires physical SIM card hardware installed in an Android device. Emulators without active GSM radio simulation cannot transmit real carrier SMS.
2. **Notification Listener OS Binding:**
   - Android requires the user to explicitly grant "Notification Access" in Android System Settings. Third-party apps cannot programmatically grant this permission; the companion UI provides a direct shortcut to system settings.
3. **Google Play Policy Scoping:**
   - `SEND_SMS` and `BIND_NOTIFICATION_LISTENER_SERVICE` are sensitive permissions. When publishing to Google Play, the application must be declared under the Enterprise Device Gateway policy exemption or distributed via enterprise private APK / MDM sideload.
4. **Carrier Radio Pacing & Safety Throttle:**
   - Cellular radio hardware requires safe dispatch pacing. The dispatcher enforces an internal engineering default of 1,500ms pacing delay between consecutive dispatches to prevent mobile carrier radio throttling and radio queue exhaustion.

---

## 13. Physical Device Validation Checklist

The following capabilities require real Android physical hardware with active local Tanzanian SIM cards (Vodacom, Mixx by Yas, Airtel, Halotel) and cannot be proven by JVM tests alone:

| Check | Required Hardware / Configuration | Expected Outcome |
| :--- | :--- | :--- |
| **Notification Listener Permission Prompt** | Physical device running Android 8.0 - 14 | System dialog directs user to Notification Access screen; app displays green "ACTIVE" badge upon return. |
| **Real Payment App Interception** | Physical device with installed M-Pesa / Mixx app | Real incoming financial notification is captured, encrypted via Keystore AES-256-GCM, and inserted into Room database. |
| **Zero Personal Chat Leakage** | WhatsApp / SMS message received | Incoming message is dropped in memory; zero non-financial notifications appear in database or logs. |
| **StrongBox Hardware Keystore** | Device supporting hardware StrongBox Keymaster | Key pair generated with `setIsStrongBoxBacked(true)` successfully seals private key inside tamper-resistant hardware silicon. |
| **Dual-SIM Slot Enumeration** | Device with 2 physical SIMs inserted | UI and `SimManager` accurately detect Slot 1 (Carrier A) and Slot 2 (Carrier B) with valid subscription IDs. |
| **Cellular SMS Transmission** | Active local SIM with carrier credit | Message dispatched via `SmsManager.sendMultipartTextMessage()`; carrier radio tower accepts dispatch (`RESULT_OK`). |
| **SMSC Sent & Handset DLR Receipts** | Real recipient handset receiving SMS | Sent BroadcastReceiver receives radio confirmation (`SUBMITTED`); delivery BroadcastReceiver receives handset confirmation (`DELIVERED`). |
| **Foreground Keepalive Across Doze** | Device unplugged and screen turned off for > 1 hour | Foreground notification remains pinned; service continues listening without being killed by Android Doze. |
| **Offline Buffering & Network Reconnection** | Airplane mode toggled during payment/SMS queue | WorkManager buffers records locally; upon reconnecting Wi-Fi/LTE, exponential backoff flushes queue to backend. |
