# Google Play and SMS apps: what SimGate shows, and what it means for BriskSMS

Date of reading: 22 November 2026.
Not legal advice and not a Google decision. This note separates what was read, what could not be seen, and what is inference.

## 1. What was read

Google's policy page "Use of SMS or Call Log permission groups" (support.google.com/googleplay/android-developer/answer/10208820), and SimGate's public privacy policy, FAQ and terms (simgate.app/policy, /faq, /terms). SimGate's Play Store listing could not be read, because the page did not render for the fetch tool. Nothing was installed or tested.

## 2. Google's rule, as written on that page

- The SMS permissions are SEND_SMS, RECEIVE_SMS, READ_SMS, WRITE_SMS, RECEIVE_MMS and RECEIVE_WAP_PUSH. Apps may use them only as the default SMS, Phone or Assistant handler, or under an exception.
- An app that is not the default handler must qualify for a listed exception, where the permission is needed for the listed core function and there is no alternative method. Every exception is "subject to Google Play review and approval", case by case.
- The listed exceptions are: account verification by phone call, anti-smishing, backup and restore, caller ID and spam blocking, connected device companion apps, cross-device sync, device automation, enterprise archive / CRM / device management, government quality-of-service reporting, in-vehicle use, physical safety and emergency alerts, proxy calls, SMS cell broadcast, SMS-based financial transactions, call-based banking authentication, SMS-based money management, and a few system roles.
- The page does not name "SMS gateway" or "bulk SMS". The only automation entry is "device automation": automating repetitive actions across the OS from triggers the user sets.
- An app that uses these permissions must submit the Permissions Declaration Form in Play Console. Without a valid declaration, an app "may be removed". Changing how the permissions are used means submitting the form again. Undeclared or deceptive use can lead to app suspension or developer account termination.
- Invalid uses include selling the data, market research based on SMS, and remote control of a user's phone or other devices. The list is not exhaustive.
- Not on that page, so not read: the notification-listener rules, and the User Data policy (prominent disclosure and consent).

## 3. What SimGate says about itself

- Its FAQ says the app has been on Google Play since 1 November 2026 (package `app.simgate.gateway`), for Android 7.0 and newer, with a signed APK for phones without Play services. This is SimGate's own statement. It was not checked against the store.
- Its privacy policy says the app reads every new incoming SMS (including one-time codes) and uploads sender, text, time and SIM slot. It says the app does not read the existing inbox, contacts, call history or location.
- It lists each permission (send SMS, receive SMS, phone state for SIM listing, camera for QR pairing only, notifications and battery) and says the app asks for them "only after showing you what it does with them".
- It keeps little: incoming message text is held until webhook delivery finishes (retries about 36 minutes), outgoing text for at most 10 minutes, then only masked numbers. Log retention depends on plan, from 1 to 90 days.
- It offers account deletion from the dashboard or by email, says it sells no data and shows no ads, and requires users to be 18 or older.
- Its terms ban spam, phishing and unsolicited messages and make the user responsible for consent. Its FAQ says bulk sends go at one message every 3 seconds, for opted-in recipients, and that carrier fair-use rules still apply.
- Nowhere does it say which Play exception it declared, or that it is a default SMS handler. That is unknown.

## 4. What this does and does not prove

- A gateway-style app is on Play, according to its own FAQ. That shows approval is possible. It does not show which route it took or that the approval will last, because the listing is about three weeks old by its own account. Policy review can happen again whenever the app changes how it uses the permissions.
- Which exception SimGate used is not known. It may be "device automation", but that is a guess and nothing on its pages says so.
- It asks for more than BriskSMS needs. It receives all SMS. BriskSMS does not need RECEIVE_SMS or READ_SMS (see section 5).

## 5. What it means for BriskSMS (inference and recommendations)

What the Android app requests today (from `docs/android/ANDROID_INTEGRATION.md` section 9.1): SEND_SMS, READ_PHONE_STATE, notification listener access, foreground service, boot, battery optimization exemption, notifications and internet. It does not request RECEIVE_SMS or READ_SMS. Payments are read from notifications of supported payment apps, not from the SMS inbox.

1. **Product B (bulk SMS) needs a declared route.** SEND_SMS in a non-default-handler app needs an exception. No listed exception names gateways. The nearest fit is "device automation", and it may or may not be accepted. We should not build the Play release around an assumption. Ask Google Play policy support which category applies before submitting, and keep the answer in writing.
2. **Product A (payment alerts) uses notification access, not SMS permissions.** The SMS declaration page does not cover it, but its list of invalid uses mentions "SMS or phone notification enhancement and alerts" for non-eligible apps, so the wording needs a careful read. The notification-listener and User Data policies were not read here. They are the next thing to read before submission.
3. **Keep the permission footprint small.** Not asking for RECEIVE_SMS and READ_SMS is a real advantage over SimGate. Keep it that way.
4. **Show a plain disclosure before each sensitive permission.** The onboarding pages already explain what the listener reads and ignores, and what the SMS permission is for. Make sure the wording matches the Play listing, the privacy policy and the Data safety form exactly.
5. **Update the privacy policy to list each permission and its purpose,** and describe retention and deletion. The current `privacy.html` is marked as a draft. SimGate's policy is a useful checklist for what to cover, not a text to copy.
6. **Provide a way to delete the account and its data,** from the app or console, and keep the policy's 30-day statement consistent with it.
7. **Keep the non-Play route.** The existing plan to also distribute a signed APK or use MDM for enterprise customers is a sound fallback if a declaration is rejected. SimGate does the same.
8. **Option if Product B is refused on Play:** a Play build with payment reconciliation only (no SEND_SMS), and bulk SMS in the directly distributed build. This needs engineering work and is only a fallback idea.
9. **A documentation point to fix:** `docs/android/ANDROID_INTEGRATION.md` section 12 says to declare under an "Enterprise Device Gateway policy exemption". No exception with that name appears on Google's page. Replace it once the real category is confirmed.

## 6. Update of 22 November 2026: payment capture must use SMS

The product owner found that the provider apps (CRDB, NMB, Vodacom) never post a transaction notification, so reading those apps' notifications does not work and SMS is required. Sections 4 and 5 above assumed otherwise; read them with this update.

What Google's page says (read again on 22 November 2026):
- The exceptions are open only to an app that is not the default SMS handler, when the permission "enables the core app functionality" and "there's currently no alternative method to provide the core functionality". Eligible permissions are "Subject to Google Play review and approval".
- "SMS-based financial transactions" lists RECEIVE_SMS, READ_SMS, RECEIVE_MMS, RECEIVE_WAP_PUSH and SEND_SMS. Its example is "Unified Payments Interface (UPI), verifications for financial transactions". Detecting merchant payments from SMS is not named, so approval is a judgement by the reviewer.
- "SMS-based money management" lists the same receive permissions but not SEND_SMS.
- Nothing seen about using RECEIVE_SMS without READ_SMS, or about reading only some senders.
- Apps "may not exfiltrate or share non-financial or personal SMS history" (budgeting and loan apps note).

Decision (option C): two builds. `play` has no SMS permission and reads the Messages-app notification. `direct` adds RECEIVE_SMS with sender filtering on the phone and is downloaded from the website. A Permissions Declaration Form under "SMS-based financial transactions" will be filed in parallel, using the finding above as the reason no alternative exists. Section 5 point 3 (avoid RECEIVE_SMS) and point 2 are superseded by this. Technical detail: `docs/android/ANDROID_INTEGRATION.md` section 3.0.

## 7. Open points

- SimGate's Play listing, declared permissions and Data safety form were not seen. A person can open the listing and read the Data safety section and the permissions list directly.
- The notification-listener policy and the User Data policy need reading.
- Which exception to claim is a decision for the team, ideally confirmed with Google Play policy support.

## Sources

- Google Play Console Help, Use of SMS or Call Log permission groups: https://support.google.com/googleplay/android-developer/answer/10208820
- Permissions Declaration Form help: https://support.google.com/googleplay/android-developer/answer/9214102 (linked from the page above, not read)
- SimGate privacy policy: https://www.simgate.app/policy
- SimGate FAQ: https://www.simgate.app/faq
- SimGate terms: https://www.simgate.app/terms
