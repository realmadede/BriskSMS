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
