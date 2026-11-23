# SimGate compared with BriskSMS

Date of reading: 22 November 2026.
Source for SimGate: its public home page (simgate.app) and its setup guide (simgate.app/getting-started), read once. Nothing else on its site was read, and nothing was tried in the product. Anything marked "not on page" was not stated there and is unknown.

## 1. What each product is

| | SimGate | BriskSMS |
|---|---|---|
| Core idea | An Android phone with your own SIM becomes an SMS gateway behind an HTTP API. It sends and receives SMS | An Android phone does two jobs: it reads mobile money payment alerts for reconciliation (Product A), and it sends bulk SMS through its SIM (Product B) |
| Money | No payment features | Matches payments to invoices, queues uncertain ones for human review, verifies in an ACID transaction. Non-custodial |
| Main customer | Developers who want an SMS API (the page cites "5,000+ developers", unverified) | Tanzanian businesses that collect mobile money payments, plus developers who integrate |

## 2. How the engine works

SimGate, from its pages:
- The dashboard pairs a phone by QR code. An API key goes in an `x-api-key` header. `POST /v1/sms/send` takes `deviceId`, `phoneNumber` and `message`.
- If the phone is online the API answers 200. If it is briefly offline it answers 202 and holds the message until the phone reconnects.
- Bulk is `POST /v1/sms/bulk` with up to 500 numbers, paced at one message every 3 seconds per phone, with progress by batch id.
- Inbound SMS is posted to your endpoint as `sms.received` with an `x-simgate-signature` header. Automations can match inbound text and auto-reply.
- It says message text is deleted once delivered and logs show masked numbers.
- Not on page: how the phone talks to the cloud, how the webhook signature is computed, delivery receipt format, SIMs per phone, encryption.

BriskSMS, from this repository:
- A phone pairs with a single-use code (5 minutes) and a hardware-backed key, proved by a signed challenge. The device token is stored encrypted on the phone.
- Product A: the phone relays supported provider notifications only. The server parses, deduplicates by hash, and matches by reference or by sender and exact amount. Uncertain matches go to review. A human verifies before an invoice is paid.
- Product B: the phone acquires a send job, records that it is dispatching before it calls the radio, and reports sent and delivered receipts. It survives restarts without sending twice. Pacing is 1.5 seconds between sends. Dual SIM, with carrier names detected.
- Prepaid credits sit in their own ledger, separate from subscription billing.

Short answer: the sending half is the same idea (your phone, your SIM, an API). SimGate stops there. BriskSMS adds the payment side, which is the larger part of the product.

## 3. Integrations

| SimGate (home page) | BriskSMS |
|---|---|
| n8n, Make, Zapier, Home Assistant, Node-RED, Pipedream. Setup guides for Node.js, Python, PHP and curl | Zapier app (Google Sheets and Excel dispatch), webhooks with signing, REST API with API keys and OAuth, developer portal. Payment events can feed accounting and workflow tools |

Gap worth noting: SimGate has more automation-platform listings and per-language guides. BriskSMS has no per-language guide pages.

## 4. Pricing

SimGate (euro, per month, as shown on its home page):

| Plan | Price | SMS per month | Devices |
|---|---|---|---|
| Free | 0 | 250 | 1 |
| Starter | 7.49 | 1,200 | 2 |
| Pro | 14.99 | 5,000 | 5 |
| Scale | 39 | 15,000 | unlimited |

It says there is no per-SMS surcharge from SimGate. Messages use the carrier plan on your SIM. Annual pricing, VAT and overage are not on the page.

BriskSMS: plans and prices live in the catalog and are edited on `/nexus`, so nothing is fixed in code. The development seed defaults in `packages/db/src/seed.ts` are TZS 25,000, 65,000 and 180,000 a month for three plans, and bulk messaging is on the top plan only. These are seed values, not published prices. Bulk messaging also uses prepaid credit packs, which are set on `/nexus` too.

Implication: the two charge differently. SimGate sells an allowance of SMS per plan. BriskSMS sells the payment reconciliation product by subscription and bulk SMS by prepaid credits, and the credits are a separate meter from the plan. A decision on whether to publish prices and how they compare is a commercial one and is not made here.

## 5. Setup guide

SimGate's guide is a short video plus six steps: install the app, pair by QR, create an API key, send a test SMS from the dashboard, send through the API, check device status. It also has troubleshooting and a short FAQ.

BriskSMS now has its own setup guide at `/getting-started`. It follows the BriskSMS flow instead: create a workspace, install the relay app, pair, grant permissions, check a first payment, send a first SMS, connect your own systems. It does not reuse SimGate's wording or layout.

## 6. Open points

- The relay app's install source is not documented in this repository (the Android notes say Play Store policy for SMS permissions needs a private or enterprise distribution). The setup guide therefore does not name where to get the app. That line needs the real answer before launch.
- The setup guide has no video, screenshots or per-language API guides. SimGate has the video and the guides.
