# Google Play Permissions Declaration Form: draft answers (SMS)

Status: draft prepared 23 November 2026. It has not been submitted. I could not open the live form (it needs the Play Console), so the headings below follow Google's published policy page, not the form's exact fields. Match each answer to the real field when filing, and re-check anything the form words differently.

Basis: `docs/compliance/PLAY_STORE_SMS_POLICY_STUDY.md` (section 6) and `docs/android/ANDROID_INTEGRATION.md` (section 3.0). Everything below describes what the code does today; nothing is promised that is not built.

## 1. What is being declared

| Permission | Where it is used | Build |
| :--- | :--- | :--- |
| `RECEIVE_SMS` | `PaymentSmsReceiver`: reads an incoming SMS only to decide whether it is a payment message from a supported mobile money or bank sender | `direct` today. Would be added to the `play` build once approved. |
| `SEND_SMS` | `SmsDispatcher`: sends the business's own outgoing SMS through its own SIM (Product B) | Both builds today |

`READ_SMS` is not requested. The app never reads the SMS inbox.

Exception to claim for `RECEIVE_SMS`: **SMS-based financial transactions**.

`SEND_SMS` is declared separately (section 6), not under the financial-transactions claim. Bulk and marketing SMS are not obviously "financial transactions", and putting them in the same claim could sink the payment declaration. If Google refuses `SEND_SMS`, the `play` build ships without bulk sending (payment reconciliation only) and bulk sending stays in the `direct` build. This split is a recommendation from this draft, not something the team has confirmed.

## 2. Core functionality (draft answer)

BriskSMS is a payment reconciliation tool for small businesses in Tanzania. Customers pay the business's own mobile money number or bank account. The mobile money provider or bank then sends the business an SMS confirming the credit. The BriskSMS relay app, installed on the business's phone, reads that confirmation SMS so the payment can be matched to the business's invoices. Without reading the SMS the app cannot do its main job.

## 3. Why there is no alternative method (draft answer)

- The provider apps for the main Tanzanian operators and banks (M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, CRDB, NMB) do not post a notification when money arrives. This was observed on the product owner's own phones (report of 22 November 2026). Reading those apps' notifications does not work. **Evidence to attach before filing:** screenshots from at least one phone per provider showing the app installed with notifications on and no transaction notification, next to the SMS received for the same payment.
- **Unverified, confirm before filing:** that no provider offers a small business a way to receive credit events on its own phone other than SMS. BriskSMS does not use such an API today, but I have not checked each provider's offering.
- The SMS Retriever and SMS User Consent APIs apply to a one-time code the app itself requested, not to transaction messages from a provider.
- Reading the notification the default Messages app shows is available as a fallback and is built into the `play` build, but it is unreliable: Android can truncate or group the text, hide it when notifications are off, or redact it on newer versions. A payment that is never shown is a missed payment, which is a financial error.

## 4. What the app does and does not read (draft answer)

- Reads only an SMS whose sender is on a short fixed list of mobile money and bank sender names (`PaymentProviderRegistry.FINANCIAL_SENDER_SHORTCODES`) and whose text reads as an incoming credit.
- Drops everything else immediately on the phone, in memory: messages from phone numbers, other senders, one-time codes, and outgoing-money messages. Dropped messages are not stored, logged or sent anywhere.
- Kept messages are encrypted on the phone (Android Keystore, AES-256-GCM), signed with a device key, and uploaded over HTTPS to the business's own BriskSMS workspace.
- The app cannot read the inbox, cannot list past messages, and has no "read all" mode.
- Nothing is shared with third parties or used for advertising.

## 5. User disclosure and consent (draft answer)

- First launch shows introduction pages that explain the permission before Android asks for it.
- A prominent in-app disclosure is shown before Android's own permission dialog, with "Allow" and "Not now". It is in the app (`MainActivity.offerSmsPaymentCapture`, `direct` build) as of 23 November 2026. The text, which should be copied into the form and the Play listing unchanged:

  > **Allow BriskSMS to read payment texts?**
  > BriskSMS reads incoming text messages only to find payment confirmations from supported mobile money and bank senders (M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, CRDB and NMB). Each one is encrypted and sent to your BriskSMS account so it can be matched to an invoice.
  > Every other message, including personal texts and one-time codes, is ignored on this phone and is never stored or uploaded. BriskSMS cannot read your message history.
  > You can turn this off at any time in Android settings, under Apps, BriskSMS, Permissions.

  It is not yet reviewed against Google's User Data policy, and it has not been seen on a real phone.
- The first-launch introduction pages say the same thing in plainer form (payment texts, not alerts from provider apps).
- The permission can be refused. Payment capture then stays off and the app says so.
- Privacy policy: `apps/web/src/privacy.html` now describes payment text messages, lists each permission and its purpose, and says the app cannot read message history. It is still a draft with legal placeholders (company name, retention and deletion periods, Data Protection Officer) that counsel must fill before its URL goes into the form.

## 6. SEND_SMS (draft answer, if declared separately)

The business uses the app to send its own messages (receipts, reminders, payment confirmations to its own customers) from its own SIM. The business chooses every message and recipient; BriskSMS does not send on its own or to numbers the business did not supply. Candidate exception: device automation or connected-device companion. The study notes no listed exception names an SMS gateway, so this is the weaker claim.

## 7. Demonstration video (to record)

A short screen recording, hosted as an unlisted video, showing:
1. The disclosure and the permission request.
2. A real payment received from a supported provider and the SMS arriving.
3. The app keeping that SMS and the payment appearing in the console.
4. A personal SMS and a one-time-code SMS arriving and creating nothing.
5. Where the user can turn payment capture off.

## 8. Before submitting

- [ ] Real-phone test of the `direct` build passes (in progress, owner), including the disclosure dialog.
- [x] Prominent disclosure added to the app (23 November 2026).
- [ ] `privacy.html` placeholders filled by counsel, then published with its URL ready for the form.
- [ ] Evidence screenshots for section 3 collected.
- [ ] Demo video recorded.
- [ ] Confirm the split: `RECEIVE_SMS` under financial transactions, `SEND_SMS` separately.
- [ ] Re-read the live form and Google's page; update this draft where they differ.

Approval is Google's decision and is not guaranteed. The `direct` build remains the route for customers if it is refused.
