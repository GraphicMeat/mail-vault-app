# Google Play Data safety answers

Owner pastes these into Play Console (App content > Data safety). Same facts as `privacy-labels.md`.

## Overview questions

- Does the app collect or share any of the required user data types? **Yes** (collected; none shared).
- Is all of the user data collected by your app encrypted in transit? **Yes** (HTTPS to mailvaultapp.com; mail uses TLS to the user's own provider).
- Do you provide a way for users to request that their data be deleted? **Yes**, through the contact address on the Privacy Policy page (email address, install id and purchase record on the billing server). Removing an account in the app deletes its tokens and cached mail from the phone.
- Data shared with third parties: **none**. Google Play Billing and the user's own mail provider are not "sharing" under Play's definition (service providers acting for the user, and transfers the user starts).

## Data types

| Play category / type | Collected | Shared | Optional | Purpose |
|---|---|---|---|---|
| Personal info: Email address | Yes, only when the user signs in to a website Premium account | No | Yes (the user may skip it) | App functionality |
| Financial info: Purchase history | Yes, after a Premium purchase or Restore (Play purchase token, product, dates) | No | Yes (only for Premium) | App functionality |
| Device or other IDs: Device or other IDs | Yes, a random install id made by the app (not the advertising id) | No | Yes (only for Premium) | App functionality |

Not collected: name, user IDs, address, phone number, race, political or religious beliefs, sexual orientation, other personal info, user payment info, credit score, other financial info, health and fitness, **emails, SMS or MMS, other in-app messages** (mail stays on the phone and the user's mail server; the developer never receives it), photos, videos, audio, files and docs, calendar, contacts, app activity, web browsing, app info and performance (crash logs, diagnostics), location.

## Notes for the owner

1. Same open item as the iOS labels: app version and OS version are sent on web sign-in (`billing_client.rs`). If you count that as "App info and performance: Diagnostics", add it (collected, not shared, optional, app functionality).
2. Same open item for server IP logging.
3. Account creation: the app has no account of its own; the optional web sign-in is for an existing subscription. If the Console asks about account deletion, point to the Privacy Policy contact.
4. Ads: **No**. Target audience: adults. News app: No. Government app: No.
