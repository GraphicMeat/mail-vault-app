# App Store privacy answers (App Privacy section)

Owner pastes these into App Store Connect. They match `PrivacyInfo.xcprivacy`
(`src-tauri-mobile/gen/apple/mailvault-mobile_iOS/`). Evidence for each line is the code named in brackets.

## Tracking

Does this app track users? **No.** No tracking domains, no advertising SDK, no data broker, no data combined with other companies' data.

## Data types collected (all "Linked to the user", none used for tracking, purpose "App Functionality" only)

| Apple data type | When | What exactly | Where it is checked |
|---|---|---|---|
| Contact Info: Email Address | Only if the user signs in to an existing website Premium account with a code sent to the address. Never otherwise. | The address, to mail the 6-digit code and find the subscriber. | `website/api/signin-code.js` (code mail), engine `premium.webSignIn.*` |
| Purchases: Purchase History | Only after a Premium purchase or Restore. | The signed App Store transaction (product, dates, state), kept against the install id so the server can say whether Premium is on. | `website/api/store-billing.js`, engine `mobile.premium.verify` |
| Identifiers: User ID | Premium purchase, Restore and the 12 hourly re-check. | A random UUID made at first use of Premium and kept in the iOS keychain (the "install id"), tied to the purchase on our server. The StoreKit `appAccountToken` is a one-way hash of it. It is not a device-level identifier: not the advertising id and not the vendor id, so Apple's "Device ID" type does not fit it. | engine `premium.installId`, `Store.swift` |

## Data types NOT collected

Name, phone number, physical address, contacts, health, financial info (card details never reach us; Apple handles payment), precise or coarse location, sensitive info, user content (**mail, attachments, subjects, contacts and drafts never leave the phone except to the user's own mail provider**), browsing history, search history (searches run on the phone, or as a request from the phone straight to the user's own mail server), usage data, product interaction, advertising data, crash data, performance data, other diagnostic data.

## Notes for the owner to confirm before submitting

1. **App version and OS version on web sign-in.** The first status call after a verified web sign-in sends a client name ("MailVault for iPhone"), platform, app version and OS version so the website's 5-device list can show the device. That is device information tied to the customer. If App Store Connect asks for "Other diagnostic data" or similar for it, answer Yes, Linked, App Functionality (and add the type to the manifest). Evidence: engine `billing_client.rs` `subscription-status` query.
2. **IP address.** Our server sees the caller's IP on every request and uses it for rate limits (in memory). If the billing service writes IPs to disk or logs, add "Identifiers" / "Other usage data" accordingly. Not verified here: server logging is outside this repo's code.
3. Mail provider sign-in (Google, Microsoft) and mail traffic go from the phone straight to those providers. The developer receives none of it, so none of it is "collected" under Apple's definition (data is collected only if it is transmitted off the device to the developer or a third-party partner).
4. Privacy Policy URL to enter: `https://mailvaultapp.com/privacy.html`. The page needs its mobile section (Plan 4 Task 13) before submission.

## Required-reason API declarations (in the manifest)

See the report for the evidence. Declared: UserDefaults `CA92.1`, File timestamp `C617.1`, System boot time `35F9.1`. Disk space is not declared (nothing in our code reads free space); check Xcode's Privacy Report on the archive and add `E174.1` only if SQLite or a framework shows up there.
