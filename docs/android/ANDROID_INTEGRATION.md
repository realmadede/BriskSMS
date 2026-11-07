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
- **Permission:** `android.permission.BIND_NOTIFICATION_LISTENER_SERVICE`
- **Scoped Whitelist:** Only inspects notifications originating from authorized Tanzanian financial application packages:
  - `com.mpesa.tz` (Vodacom M-Pesa)
  - `com.yas.mixx` (Mixx by Yas / Tigo Pesa)
  - `com.airtel.africa.money` (Airtel Money)
  - `com.crdb.simbanking` (CRDB SimBanking)
  - `com.nmb.mobile` (NMB Mkononi)
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

### 4.1 SMSGate Cellular Gateway Architecture
BriskSMS operates purely as an SMSGate cellular relay using local Tanzanian SIM cards. Traditional telco aggregators (Beem, DARSMS, eHUB) and httpSMS are strictly excluded.

Two operating modes are supported:
1. `GatewayMode.MANAGED_GATEWAY`: Connects to organization's private VPS deployment behind Cloudflare (`https://gateway.brisksms.com/api/v1`).
2. `GatewayMode.EXTERNAL_RELAY`: Connects to SMSGate cloud relay endpoint (`https://api.sms-gate.app/3rdparty/v1`).

### 4.2 Dual-SIM Carrier Management
- **Engine:** `tz.co.brisksms.messaging.sim.SimManager`
- Uses `SubscriptionManager` to detect active SIM cards.
- Normalizes carrier names: `Vodacom`, `Mixx by Yas`, `Airtel`, `Halotel`.
- Routes outbound messages to designated physical SIM slots: `simSlot: 1` vs `simSlot: 2`.
- Graceful fallback: if a requested slot is empty, falls back to the active cellular subscription.

### 4.3 Foreground Service & Radio Dispatch Engine
- **Service:** `tz.co.brisksms.messaging.service.SmsGateRelayService`
- **Foreground Type:** `connectedDevice` (`ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`).
- **Dispatcher:** `tz.co.brisksms.messaging.dispatcher.SmsDispatcher`
- Manages multi-part and single-part SMS dispatch via Android `SmsManager`.
- Attaches unique `PendingIntent` callbacks for sent and delivery receipts:
  - `ACTION_SMS_SENT`: Carrier radio ACK/NACK verification (`SUBMITTED` or `FAILED`).
  - `ACTION_SMS_DELIVERED`: Handset delivery receipt (`DELIVERED`).
- Pacing delay: 1,500ms between consecutive dispatches to comply with TCRA carrier radio rate limits.
- Idempotency: Deduplication check prevents duplicate radio transmissions.

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
│    • Queue status (Queued, In-Flight, 40 msg/min dispatch rate)             │
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
4. **TCRA Radio Pacing:**
   - Cellular operators enforce SMS rate limits. The dispatcher enforces a minimum 1,500ms pacing delay between dispatches (approx. 40 SMS/min per active SIM) to avoid carrier SIM blocking.
