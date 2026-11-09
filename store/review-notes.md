# Review notes (App Store "Notes", Play "App access" instructions)

Paste the English text under "Notes" below. Fill the three placeholders first. Nothing here is a secret; the demo credentials are the owner's to supply and must be a throwaway mailbox, never a real one.

## What the reviewer needs

MailVault is a mail client. Mail stays on the phone and on the user's own mail server. There is no MailVault account; the app opens straight to "Add account".

Demo mailbox (owner fills in; a throwaway IMAP/SMTP mailbox with some mail in it):

- Provider/server: `<OWNER: IMAP host, port, SMTP host, port>`
- Address: `<OWNER: demo address>`
- Password: `<OWNER: app password>`

To sign in: Add account, then "Other (IMAP)", type the address and password above.

## Premium (in-app purchase)

Premium is an optional auto-renewing subscription (monthly or yearly) bought through the App Store or Play Billing. It unlocks three features: scheduled send (compose, Send later), follow-up reminders (a reminder choice in compose) and tracker blocking (a shield in the message viewer). Everything else is free. The paywall opens from Settings > Premium or from any of those three features. The reviewer can buy it with a sandbox/test account, and Restore purchases is on the same screen. The paywall shows the Terms of Use and Privacy Policy links and the renewal terms. Premium is verified by our server from the store's signed receipt; the app stores no card data.

## Background fetch (why the app asks to run in the background)

New-mail notifications are optional (Settings > Notifications, off by default; the permission is asked only when the user turns it on).

- iOS: the app uses `BGAppRefreshTask` (identifier `com.mailvault.app.refresh`, `UIBackgroundModes` = `fetch`). The system decides when to run it, roughly every 15 minutes at best, less when the battery is low or the app is rarely opened. A run checks the INBOX of each account, shows a local notification for new mail, and sends due scheduled messages and follow-up checks. There is no push service and no server of ours involved. A reviewer will usually not see a background notification during a short review; opening the app checks right away (pull down on the list).
- Android: WorkManager periodic work, minimum interval 15 minutes, same behaviour.
- Scheduled send and follow-up reminders run only when the app gets a turn (foreground or a background run), so a message can go out a little after its time. The scheduling screen says so.

## Data

The only data sent to our server (mailvaultapp.com) is the Premium purchase data and, if the user signs in to an existing website subscription, an email address for a 6-digit code. No analytics or ads. Mail, passwords and OAuth tokens go only between the phone and the user's mail provider. Passwords and tokens are kept in the iOS keychain / Android keystore-backed store.

## Export compliance

`ITSAppUsesNonExemptEncryption` is false: only standard TLS is used.
