# Deliverable F: Technical Feasibility & Regulatory Compliance Report

**Document Version:** 1.0.0  
**Jurisdiction:** United Republic of Tanzania & Android Ecosystem  
**Target Compliance Frameworks:**
- Tanzania Personal Data Protection Act (PDPA), No. 5 of 2022 / PDPC Regulations 2023
- National Payment Systems Act (NPSA), 2015 & Bank of Tanzania (BoT) Guidelines
- Tanzania Communications Regulatory Authority (TCRA) Bulk SMS & Sender ID Regulations
- Google Play Developer Program Policies (SMS & Call Log Permissions Policy)

---

## 1. Android Ingestion Feasibility & Distribution Strategy

### 1.1. Google Play SMS Policy Analysis
Google Play strictly restricts the `RECEIVE_SMS`, `READ_SMS`, and `SEND_SMS` permissions:
- **Core Rule:** An app requesting these permissions **must be registered as the device's Default SMS Handler** (the app the user uses for all text messaging).
- **Exceptions:** Google Play maintains an extremely narrow list of permitted exceptions (emergency safety alerts, direct smartwatch companion sync). General utility apps, corporate gateways, and business tools **do not qualify** and are systematically rejected during Play Console review.

### 1.2. The Dual-Channel Strategy (The Compliant Solution)
To deliver commercial reliability while complying with Google's policies, BriskSMS adopts a **hybrid distribution architecture**:

```
                                  +---------------------------------------+
                                  |     BriskSMS Ingestion Strategies     |
                                  +---------------------------------------+
                                                      |
                    +---------------------------------+---------------------------------+
                    |                                                                   |
                    v                                                                   v
+---------------------------------------+                               +---------------------------------------+
|                Mode 1                 |                               |                Mode 2                 |
|       Play Store Companion App        |                               |       Enterprise Direct APK           |
|     (NotificationListenerService)     |                               |       (RECEIVE_SMS Handler)           |
+---------------------------------------+                               +---------------------------------------+
| - Distributed via Google Play Store   |                               | - Distributed via BriskSMS Dashboard  |
| - Uses `NotificationListenerService`  |                               | - Used on dedicated merchant phones   |
| - Captures payment notifications      |                               | - Directly intercepts incoming SMS    |
|   from M-Pesa, Yas, Airtel, & Banks   |                               |   broadcasts from telco shortcodes    |
| - 100% compliant with Play Policy     |                               | - Bypasses Play Store SMS limits      |
| - Zero sideloading friction for users |                               | - Signed with internal release key    |
+---------------------------------------+                               +---------------------------------------+
```

#### Detailed Breakdown of Mode 1 (Play Store Compliant):
- **Mechanism:** Implements Android's `NotificationListenerService`. Whenever a financial app (e.g., M-Pesa app, CRDB SimBanking) or the system SMS application displays an alert banner in the status shade, Android invokes `onNotificationPosted(StatusBarNotification sbn)`.
- **Target Filtering:** The service filters strictly by package names and keywords:
  ```kotlin
  val approvedPackages = setOf("com.google.android.apps.messaging", "com.vodacom.mpesa", "tz.co.crdb.simbanking")
  if (sbn.packageName in approvedPackages) {
      val text = sbn.notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
      // Extract payment details safely
  }
  ```
- **Play Store Requirements:**
  1. *Prominent In-App Disclosure:* Before opening the Android system notification access screen, the app displays a full-screen disclosure explaining that notification text is read solely for payment reconciliation.
  2. *Data Minimization:* Non-payment notifications (personal WhatsApp, emails, social media) are ignored and never transmitted.
  3. *No Digital Goods Evasion:* The app is purely for real-world enterprise billing (MikroTik ISP subscriptions, physical retail goods, WHMCS hosting), not unlocking digital goods inside an Android app.

#### Detailed Breakdown of Mode 2 (Enterprise Direct APK):
- For businesses with dedicated Android phones running cellular SIM cards that receive raw carrier SMS (without the official M-Pesa app installed).
- The APK is signed and downloaded directly from the merchant's authenticated BriskSMS dashboard.
- Includes a self-updater module that checks for new releases against `api.brisksms.co.tz/v1/app/releases/latest`.
- Guidance provided to merchants to whitelist the application in **Google Play Protect** and configure OEM battery management.

---

## 2. Tanzania Payment Provider Landscape & Access Strategy

### 2.1. Provider Evaluation:

| Provider | Brand / Platform | Official API Availability | Real-World SME Accessibility | BriskSMS Strategy |
|---|---|---|---|---|
| **Vodacom Tanzania** | M-Pesa / Lipa Kwa M-Pesa | Daraja / Open API (C2B, B2B) | Requires enterprise vetting, corporate bank guarantee ($1,000+), high setup fees. Sole proprietors & SMEs cannot easily qualify. | Ingest via Android Relay (Till/Paybill SMS) + Official API adapter for enterprise clients. |
| **Yas (formerly Tigo)** | Mixx by Yas (Tigo Pesa) | Tigo Pesa Developer Portal | Similar to Vodacom: requires formal corporate partner onboarding. | Ingest via Android Relay (Till SMS) + Versioned Regex Parser. |
| **Airtel Tanzania** | Airtel Money | Airtel Money B2B API | Highly restricted; direct API access typically reserved for Tier-1 billers (utilities, banks). | Ingest via Android Relay (Till SMS). |
| **Halotel** | HaloPesa | HaloPesa API | Limited public documentation; manual onboarding. | Ingest via Android Relay. |
| **TTCL** | TTCL Pesa | Government/Enterprise API | Restricted to parastatals and licensed entities. | Ingest via Android Relay. |
| **CRDB Bank** | SimBanking / Merchant Alerts | CRDB Albaraka / Open Banking | Available for corporate accounts; requires formal banking integration contracts. | Parse incoming transactional SMS alerts (`CRDB-ALERT`). |
| **NMB Bank** | NMB Mkononi / Business Alerts | NMB Open Banking API | Corporate API available under strict compliance. | Parse incoming transactional SMS alerts (`NMB-ALERT`). |

### 2.2. Why the Android Relay is Vital for Market Dominance
In Tanzania, hundreds of thousands of retail shops, local internet providers (ISPs), and web hosts receive payments on physical SIM cards registered under Lipa Kwa M-Pesa Tills or standard business numbers. 

By using an authorized Android device to relay these notifications securely to BriskSMS, businesses gain instant, automated 24/7 reconciliation **without waiting months for telco API approvals or depositing bank guarantees**.

---

## 3. Regulatory Assessment: Bank of Tanzania & NPSA 2015

### 3.1. The Legal Boundary:
Under the **National Payment System Act (NPSA), 2015** and the **Electronic Money Regulations (2015)**:
- Operating a **Payment System Provider (PSP)** requires licensing from the Bank of Tanzania (BoT). PSPs hold consumer funds, process clearing and settlement, or issue electronic money.
- **BriskSMS's Position:**
  - BriskSMS is strictly a **Technical Service Provider (TSP)** and business management SaaS.
  - **Zero Funds Custody:** Money flows directly from the payer's mobile wallet to the merchant's own till/bank account held directly with the telecom or bank.
  - BriskSMS never touches, escrows, holds, or routes financial money. It only processes informational notifications to update software states (e.g., invoices, MikroTik user profiles).
  - *Compliance Rule:* Marketing materials, contracts, and terms of service must explicitly state: *"BriskSMS is an independent software automation platform and is not a bank, electronic money issuer, or payment service provider licensed by the Bank of Tanzania."*

---

## 4. Personal Data Protection Act (PDPA 2022) & PDPC Compliance

Under Tanzania’s **Personal Data Protection Act No. 5 of 2022** and the **Personal Data Protection Commission (PDPC)** Regulations of 2023:

1. **Mandatory Registration:**
   - Any corporate entity processing personal data of individuals in Tanzania must register as a **Data Controller** and/or **Data Processor** via the PDPC's online portal: **RCMIS** (`pdpc.go.tz`).
   - *Requirement:* Submit BRELA certificate of incorporation, TIN certificate, audited financial report, and designate an official **Data Protection Officer (DPO)**.
2. **Data Minimization & Purpose Limitation:**
   - BriskSMS only captures the minimum data required to reconcile payments: sender phone number, payer name, transaction reference, amount, and timestamp.
   - Payer phone numbers must be masked in customer-facing logs (e.g., `+255 754 *** 123`).
   - Personal SMS text messages must be discarded on-device and never transmitted to our servers.
3. **Data Security & Breach Notification:**
   - Encryption in transit (TLS 1.3) and at rest (AES-256).
   - In the event of a security incident or data breach, the PDPC must be notified within 72 hours in accordance with statutory obligations.

---

## 5. TCRA Bulk SMS & Sender ID Regulations

For Product B (Bulk Messaging), operations must adhere to **Tanzania Communications Regulatory Authority (TCRA)** guidelines:

1. **Sender ID Registration Workflow:**
   - Alphanumeric sender IDs (max 11 characters) cannot be arbitrarily assigned.
   - Every merchant requesting a custom Sender ID must submit:
     - Certificate of Incorporation (BRELA)
     - Taxpayer Identification Number (TIN) Certificate
     - Letter of Authorization on official company letterhead signed by a company director.
   - The Sender ID is submitted to licensed telco aggregators (Beem, DARSMS, eHUB) for whitelist approval by TCRA.
2. **Anti-Spam Time Windows:**
   - Promotional and marketing SMS messages are prohibited between **20:00 and 07:00 EAT**.
   - Transactional messages (OTP verification, urgent payment alerts) are permitted 24/7.
   - The BriskSMS campaign scheduler enforces these curfew restrictions automatically for promotional campaigns.

---

## 6. Infrastructure Cost Projections & Scaling Model

To respect capital constraints while guaranteeing production reliability, the infrastructure scales through predictable tiers:

### 6.1. Tier 1: Launch & Initial Scale (100 Active Businesses)
- **Daily Volume:** ~10,000 payment notifications, ~20,000 SMS dispatches.
- **Infrastructure Architecture:**
  - Application Server: Hetzner Cloud CPX31 (4 vCPU, 8 GB RAM) — Running Docker Compose (`api`, `worker`, `redis`).
  - Database: Managed PostgreSQL (2 vCPU, 4 GB RAM, 50 GB NVMe Storage with automated daily backups).
  - Web & Assets: Cloudflare Pages + Cloudflare Free/Pro CDN ($0 – $20/month).
  - Monitoring: Sentry Developer Tier (Free / $26/month).
- **Estimated Monthly Operating Cost:** **$65 – $95 / month** (~170,000 – 250,000 TZS).

### 6.2. Tier 2: Growth Scale (1,000 Active Businesses)
- **Daily Volume:** ~150,000 payment notifications, ~200,000 SMS dispatches.
- **Infrastructure Architecture:**
  - Application Servers: 2x Hetzner CPX41 (8 vCPU, 16 GB RAM) behind Cloudflare Load Balancer.
  - Redis Cluster: Managed Redis (4 GB) for BullMQ queues.
  - Database: Managed PostgreSQL (4 vCPU, 16 GB RAM, 250 GB NVMe, Read Replica).
  - Object Storage: Cloudflare R2 for invoice PDF storage and CSV exports (~$10/month).
  - Sentry Team Plan (~$80/month).
- **Estimated Monthly Operating Cost:** **$350 – $480 / month** (~900,000 – 1,250,000 TZS).

### 6.3. Tier 3: Enterprise Scale (10,000 Active Businesses)
- **Daily Volume:** ~2,000,000 payment notifications, ~2,000,000 SMS dispatches.
- **Infrastructure Architecture:**
  - Kubernetes / Managed Container Cluster (Autoscaling API and Queue Workers).
  - High-Availability PostgreSQL Cluster (Multi-AZ, 16 vCPU, 64 GB RAM, Read Replicas, Connection Pooling via PgBouncer).
  - Managed Redis Cluster (16 GB).
  - Cloudflare Enterprise / Business tier with dedicated WAF rules.
- **Estimated Monthly Operating Cost:** **$1,800 – $2,500 / month**.

