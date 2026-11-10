# BriskSMS Android Companion Architecture & Cellular Relay Topology

**Document:** `docs/architecture/ANDROID_COMPANION_AND_RELAY_TOPOLOGY.md`  
**Classification:** Core System Architecture & Edge Node Operations  
**Audience:** Platform Architects, Mobile Engineers, and Fleet Operators  

---

## 1. High-Level Role & Boundaries

The **BriskSMS Android Companion Application** (`apps/android`) is a purpose-limited hardware companion and cellular relay node. It operates on physical Android hardware located in Tanzania, bridging cellular operator infrastructure with the BriskSMS backend.

### Architectural Invariants:
* **Observational Only (Product A):** The companion app intercepts and forwards incoming payment notifications. It possesses **zero autonomous settlement authority**; all financial balance mutations occur on the cloud backend inside PostgreSQL ACID transactions.
* **Passive Carrier Relay (Product B):** Outbound cellular dispatches are executed via Android `SmsManager`. Prepaid credit balances and quotas are managed strictly on the backend.
* **Play Store Privacy Compliance:** The application **never requests `READ_SMS` or `RECEIVE_SMS` permissions**. Financial notifications are collected exclusively via the sanctioned Android `NotificationListenerService`. Personal messages, WhatsApp, and social communications are strictly discarded at the OS boundary.

---

## 2. Ingestion Topology: Dual-Channel Architecture

During peak commercial hours (e.g., Friday evenings, month-end salary dates), mobile network operators in Tanzania experience Short Message Service Center (SMSC) buffer delays. While the payer receives an instant debit confirmation, the merchant's gateway SIM may experience carrier latency ranging from 30 seconds to several minutes.

To minimize latency, BriskSMS employs a **Dual-Channel Ingestion Architecture**:

```mermaid
flowchart TD
    subgraph Payer Handset
        Payer["Customer Wallet Handset"]
    end

    subgraph Telco Infrastructure [Vodacom / Tigo / Airtel]
        Core["Telco Core Network"]
        SMSC["Carrier SMSC Gateway (GSM Cellular)"]
        PushServer["Carrier App Notification Server (FCM / APNs)"]
    end

    subgraph Companion Android Device [BriskSMS Companion Node]
        GSMModem["GSM Radio Baseband"]
        ProviderApp["M-Pesa / Mixx Official App"]
        Listener["BriskNotificationListenerService<br/>(Play Store Sanctioned)"]
        Parser["ProviderNotificationParser<br/>(Regex + Normalization)"]
        Storage[("Room SQLite Encrypted DB<br/>(AES-256-GCM)")]
        Worker["WorkManager Forwarding Engine"]
    end

    subgraph BriskSMS Cloud
        API["API Monolith (:3000)"]
        Ledger[("PostgreSQL Ledger")]
    end

    Payer -->|*150*00# Payment| Core
    Core -->|Standard Cellular SMS| SMSC
    Core -->|Instant App Push| PushServer

    SMSC -.->|Congestion Latency (30s-3m)| GSMModem
    PushServer -->|Instant IP Push (<5s)| ProviderApp

    GSMModem -->|Status Bar SMS Notification| Listener
    ProviderApp -->|Status Bar App Notification| Listener

    Listener --> Parser
    Parser --> Storage
    Storage --> Worker
    Worker -->|TLS 1.3 + Keystore ECDSA Signature| API
    API --> Ledger
```

### Why Dual-Channel Ingestion Slashes Latency:
* **GSM SMS:** Dependent on carrier tower paging channels and congested SMSC queues.
* **Official Provider App Notifications:** Transmitted over IP networks (Wi-Fi or Mobile Data via Firebase Cloud Messaging). These notifications frequently arrive **15 to 45 seconds ahead of the carrier SMS**, enabling sub-10-second payment confirmation even during cellular network congestion.

---

## 3. Cellular Messaging Engine: Daily Limits & Smart SIM Failover

Tanzanian mobile operators enforce Fair Usage Policies (FUP) and anti-spam monitoring on standard SIM lines. Blasting high volumes of SMS over a single consumer SIM card leads to carrier line suspension.

To protect merchant SIM cards, BriskSMS implements **Automated Quota Monitoring & Smart SIM Failover**:

```mermaid
flowchart TD
    Start["New SMS Dispatch from Queue"] --> CheckIdem{"Idempotency Check:<br/>Already Submitted?"}
    CheckIdem -- Yes --> Skip["Duplicate Ignored"]
    CheckIdem -- No --> CalcSent["Query dispatchDao.countSlotSentSince(simSlot, startOfDay)"]
    
    CalcSent --> CheckQuota{"sentToday >= DEFAULT_SIM_DAILY_CAP<br/>(400 SMS/day)?"}
    
    CheckQuota -- Under Cap --> Transmit["Transmit via designated SIM Slot"]
    
    CheckQuota -- Capped --> CheckAlt{"Alternative SIM Slot Available<br/>and Under Cap?"}
    
    CheckAlt -- Yes --> Failover["Dynamic Failover:<br/>Route to Alternative SIM Slot &<br/>Update dispatchDao.updateSimSlot()"]
    Failover --> Transmit
    
    CheckAlt -- No --> Pause["Fail-Closed Guard:<br/>Mark Dispatch FAILED with Quota Error<br/>(Protect SIM Reputation)"]
    
    Transmit --> CarrierACK{"Carrier Radio ACK?<br/>(BroadcastReceiver)"}
    CarrierACK -- Result OK --> Submitted["Mark Status SUBMITTED"]
    CarrierACK -- Radio Error --> MarkRadioErr["Mark Status FAILED"]
```

### Key Parameters:
* `DEFAULT_SIM_DAILY_CAP = 400`: Maximum outbound messages per calendar day per SIM slot.
* `DEFAULT_DISPATCH_PACING_MS = 1500L`: Mandatory 1.5-second pacing delay between consecutive dispatches to prevent anti-spam trigger alarms at the base transceiver station (BTS).

---

## 4. Device Management System: Telemetry Command Bus

Rather than maintaining fragile persistent WebSocket connections across fluctuating cellular connections, BriskSMS utilizes an **Asynchronous Telemetry Command Bus**:

```
[Merchant Console] ──► POST /v1/devices/:id/command ──► [API In-Memory / Redis Queue]
                                                                │
                                                                │ Piggybacked in
                                                                │ Telemetry ACK
                                                                ▼
[Android Companion] ◄── POST /v1/devices/:id/telemetry ◄───────┘
  (TelemetryWorker: Battery, Network, Signal)
```

### Supported Remote Fleet Commands:

| Command | Action on Android Handset | Use Case |
|---|---|---|
| `PAUSE_RELAY` | Halts `SmsGateRelayService` loop and sets `isBulkMessagingEnabled = false`. | Prevents SIM overheating or respects merchant quiet hours. |
| `RESUME_RELAY` | Restarts foreground service and resumes queue processing. | Re-enables messaging after pausing. |
| `SWITCH_SIM` | Sets `preferredSimSlot = payload.simSlot` in `KeystoreSecureStorage`. | Dynamically balances carrier billing plans remotely. |
| `WIPE_AND_REVOKE` | Wipes local SQLite database, revokes device tokens, and deletes Android Keystore ECDSA private key. | Emergency security response if device is lost or stolen. |

---

## 5. Physical Companion Deployment SLA & Best Practices

To guarantee 99.9% ingestion reliability and sub-10-second processing:

1. **Cellular Signal SLA:** The companion handset should be placed in an area with a signal strength above `-95 dBm` (minimum 3 bars of 4G/LTE). Poor signal (< `-105 dBm`) causes the baseband processor to retry tower registrations, delaying SMS receipt.
2. **Dedicated AC Power:** Devices should remain plugged into continuous power with the OEM's "Battery Optimization" exemption enabled.
3. **Dedicated Wi-Fi:** Although cellular data works, operating on a stable Wi-Fi connection ensures that outbound evidence forwarding is never interrupted by cellular voice calls or USSD sessions.
4. **Active Telco App Sessions:** Merchants should ensure official mobile money applications (e.g. M-Pesa App) are logged in to maintain active push notification channels.
