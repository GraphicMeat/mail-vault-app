# Changelog

## [Unreleased]

### Fixed
- **A message whose body fails to arrive now says so.** The reading pane printed the subject line where the body belongs, so a message that never loaded looked exactly like a message with one line in it. It now shows a loader while the body is on its way, and if it never comes, a plain "Couldn't load this message" with the reason and a Try again button.
- **"Email not found" no longer stands in for a server that refused.** A server that declined to hand over a message ended the exchange in a way MailVault read as "there is no such message" — for mail sitting right there in the list. It now checks whether the message is still on the server before reporting it missing.
- **Opening a message no longer waits behind the ones being fetched ahead of it.** MailVault reads the next few messages in the background so they open instantly, and that background reading was using the same limited set of connections as the message you actually clicked. It has its own now, it stops as soon as you move to a different message, and a message read that stalls gives up after 45 seconds instead of spinning forever.

## [2.10.0] - 2026-08-18

### Added
- **Delete Everywhere** — remove selected emails from the server, this computer, and the external backup in one action. Available in bulk operations, the selection bar, and the row menu.
- Bulk operations selection now checkmarks the rows and survives closing the modal — a bubble shows the account, folder, and live count, and the selection can be amended by hand before starting. The session is bound to one account, folder, and view (list or thread); navigating away ends it.
- Row hover menu now offers every action the selection bar does: mark read/unread, archive, unarchive, move, delete from server, delete everywhere.
- A bulk run can now report emails held back because the mailbox needs a resync, instead of silently skipping them.

### Changed
- Bulk operation descriptions now state which of the three storage locations (server, this computer, external backup) each action touches, and "Delete from Server" states per-selection whether local copies survive.

### Fixed
- **A short email list now fills itself in instead of waiting for a second reload.** The list could settle at "3 of 11 emails" and stay there: the check that runs on every account switch and reload asks whether the local copy matches the server, and when the answer was "nothing has changed" it returned without noticing that the list on screen was showing far less than the copy it had just verified. Clicking reload landed in that same check and appeared to do nothing; a second click a while later brought everything back. The check now compares what is on screen against what is stored and loads the difference, and the reload button in the "Showing cached data" warning always reaches the server instead of answering from a check made moments earlier.
- **A dropped connection no longer looks like an account with no folders.** If the connection died while the folder list was being read, MailVault treated the silence as an answer — "this account has no folders" — and showed the "Showing cached data" warning while quietly holding a broken connection. It is now recognised as the failure it is, so the connection is replaced and the folders come back on the retry.
- Deleting emails from the server is no longer lost if the app is closed or reloaded while the delete is still going. The delete is recorded before the rows disappear and finished the next time the app starts, so a message you were shown as deleted stays deleted.
- Email subjects no longer vanish from the list when a message's date includes a year — older mail showed only a sender and a date in a narrow list.
- A message deleted while switching accounts could take an unrelated message with it, or fail to stay deleted after a restart.
- Deleting archived emails from a folder left the local copies behind, so the rows reappeared as "Local only" and the delete looked like it had done nothing.
- **The key under the email list is readable again, and its explanations are visible.** Its four entries were squeezed until the labels broke mid-phrase, and hovering one opened its explanation below the bottom edge of the window, where it could not be seen at all.

## [2.9.2] - 2026-08-08

### Added
- **Email signatures are now formatted, not plain text.** Settings → Accounts gives the signature the same editor as compose: bold, italic, underline, links, lists and quotes, all carried into the messages you send. Existing plain-text signatures are kept as they are.
- **Signature and display name save as you type.** The "Save Changes" button is gone — edits are stored automatically, with a brief "Saved" mark next to the section title.
- **After a successful manual backup, MailVault now offers to automate the next ones.** A one-time panel suggests scheduled backups once your first manual backup completes, and a small "Automate" chip stays on the account's backup card afterwards. Shown once per install, never stacked with the star-and-share panel.

### Fixed
- **A message in a conversation no longer shows the contents of a completely different email.** Opening a thread could render an unrelated message — sometimes from another folder or even another account — under the right sender and subject. A message is identified by a number that is only unique inside one folder, and the thread view worked out which folder to read from by looking at whichever mailbox happened to be on screen; when that guess was off, the same number pointed at a real but unrelated email. Each message now carries its own account and folder, and when its identity can't be confirmed MailVault shows nothing rather than someone else's mail. The same guess is gone from attachment downloads, "View source", and "Delete thread from server", which could previously act on the wrong message.
- **Signing in to Premium now tells you what it found.** Choosing an email address that has no subscription — or one whose subscription has ended, or whose checkout was never completed — ran the check, stopped the spinner and changed nothing on screen, which was indistinguishable from the button not working. Sign-in now explains what the billing server holds for that address and what to do next. If the plans themselves can't be loaded, the page no longer shows blank space where they should be: it says so, offers a retry, and can open the plans in your browser. Signing in also re-checks free-trial eligibility for that address, so the trial badge stops promising a free trial to someone who has subscribed before.
- **The "Showing cached data" warning no longer appears — or refuses to leave — when MailVault rebuilds its email list from your saved copies.** If the fast email index was missing while the saved mail itself was intact, opening the account raised a warning banner even though this rebuild is routine and heals itself within moments. Worse, once anything raised that banner, the quick "has anything changed on the server?" checks that run on every account switch skipped the code that removes it — so the warning sat there for the rest of the session, and its reload button appeared to do nothing. The rebuild is now silent, and every check that confirms your mail matches the server also clears the warning, so the one remaining genuine warning (the server unexpectedly claiming a mailbox is empty when you have mail in it) disappears by itself as soon as the server checks out.
- **"Mark unread" now closes the email and sticks.** Marking the open message unread left it on screen, and opening it again brought back the state it had when it was first read — so the button still offered "Mark unread" for a message the list showed as unread, and the message was never marked read again no matter how often you opened it. Marking unread now closes the message, and reopening it marks it read as usual, so the button always names what happens next. Opening a message also updates its row and the sidebar's unread count straight away instead of waiting for the next refresh.
- **Buttons that did nothing are gone from the conversation and chat views.** Archive, Delete, Move and Mark read/unread appeared under each message in a thread and on chat bubbles but were never connected to anything — clicking them did nothing at all. They now appear only where they work.
- **Headings and text in newsletters stay readable in dark mode.** Some senders pin a text colour in a way that overrode MailVault's dark conversion, so headings kept their original black and disappeared into the dark background while the rest of the message converted normally. Those colours are now converted like everything else, and brand colours that convert correctly are left as they were.
- **Conversations show your own replies on a first run too.** On a freshly installed or freshly reset account, the Sent folder was looked up a moment before the folder list came back from the server, found nothing, and never looked again — so INBOX threads were missing every message you had sent, for the rest of the session. Switching accounts and back was the only way to get them. The lookup now waits for the folder list.
- **Your folders no longer go missing, leaving only INBOX in the sidebar.** If the very first folder lookup of a session ran a moment before the account's password was ready, it failed and was never tried again — the account showed a single INBOX until the app was restarted, and "Move to folder" had nothing to offer. The lookup now retries, and switching accounts no longer paints the old one-folder placeholder back over a list that had already loaded.
- **Marking a selection as read or unread now updates the list right away.** Selecting messages and using the selection bar's read/unread buttons changed the messages but left the rows looking exactly as before — the unread highlight, the bold subject and the thread's unread count only caught up after switching folders. The sidebar's unread badge now follows too, and the buttons work for Outlook/Microsoft accounts, where they previously did nothing.
- **Moving a selection to another folder empties the rows immediately** instead of leaving them in the list until the next refresh finished.
- **Formatted emails no longer sit in a lighter grey box in dark mode.** HTML messages — which includes every reply you write — were shaded slightly lighter than the app behind them, so your own replies looked boxed next to plain-text mail in the same thread.
- **No more empty space under an email with a folded quote.** The message area grew a little on every measurement instead of settling on the content's real height, leaving a gap below the "…" button. Expanding or collapsing a quote in the single-email view now resizes the message too, as it already did in thread view.
- **Your own reply no longer renders as a copy of the message you replied to.** When the quoted message carried a complete HTML document inside it (Proton Mail does this), MailVault displayed only the quote and hid everything you wrote. The email itself was always sent and stored correctly — this was a display bug in the thread and single-email views.

## [2.9.1] - 2026-08-06

### Added
- **Proton Mail works now — pick "Proton Mail Bridge" in the provider list.** MailVault connects through the locally-running Proton Mail Bridge app (127.0.0.1:1143), including its STARTTLS handshake and self-signed certificate, which are handled automatically for local connections. A setup guide is linked right from the provider screen.
- **Custom IMAP accounts can choose their connection security.** A new Security selector (SSL/TLS, STARTTLS, or None) appears when adding a custom account and when changing an existing account's server — previously MailVault always assumed SSL/TLS, so servers on STARTTLS ports couldn't connect. The IMAP port follows the chosen mode's default (993 or 143) until you type your own.
- The provider list now shows every supported provider, including Zoho, Proton Mail Bridge, and Fastmail, in a two-column layout.
- **See exactly how much mail data each account transfers.** Hover an account in the sidebar for a seven-day chart of what it downloaded and uploaded, with today's, this week's and this month's totals — click it for the new Settings → Data Usage page and its daily, weekly, monthly and yearly breakdowns. Useful for keeping an eye on provider limits — Gmail suspends IMAP access for up to 24 hours past 2,500 MB down / 500 MB up in a day.
- **MailVault can warn you before a provider cuts you off — or stop itself in time.** A banner appears when an account passes 80% of its daily transfer limit, and an optional cap pauses syncing for the rest of the day before the limit is hit. Both are configurable per account in Settings → Data Usage; Gmail accounts come with the known limits prefilled.
- A Report a Bug button now sits next to Settings in the sidebar — it opens a compose window with version and system details already filled in, under headed sections for what happened, how to reproduce it, and what you expected.
- The sidebar's hover usage bubble can be switched off in Settings → Data Usage, for anyone who would rather the sidebar stay quiet. The page's own breakdowns stay available.

### Fixed
- **Quoted replies and signatures fold away in the single-email view too.** Opening a reply showed the entire "Original Message" block with no way to collapse it — the fold controls were only ever added to thread and chat view.
- **Clicking outside a reply no longer throws away what you typed.** Replying or forwarding from an opened email, a thread, or chat view mounted its own compose window that couldn't minimize — clicking outside closed it and discarded the draft. All reply and forward paths now use the same compose window, which minimizes to a bubble when you click away with unsent text.

## [2.9.0] - 2026-08-04

### Added
- **Your mail can now live wherever you want it — an external drive, a NAS mount, any folder.** Settings → Backup shows where the working copy is stored and can move it: MailVault copies everything across, checks every file arrived, and only then removes the originals. If the drive is later disconnected, the app says so at the top of the main view and pauses syncing instead of quietly starting a second archive in its own storage; if the drive comes back at a different path, pick the folder again and MailVault verifies it is yours before carrying on. Going back to the default location asks whether to bring the mail with you — move it back with the same copy-check-then-delete steps, or leave it in the folder and start fresh. (Developer ID and Linux builds for now.)

### Fixed
- **Read, flagged and replied marks now survive a restore from the external backup.** Backup copies were saved under a name that carried no message flags, so anything restored from them came back looking unread and unflagged. Backups now keep the full message name, and older flagless copies still restore as before.
- **Hitting a provider's daily download limit no longer grinds through thousands of doomed fetches.** Gmail caps IMAP traffic per day (2,500 MB down, 500 MB up) and temporarily suspends accounts that exceed it — for up to 24 hours, webmail included. Archiving and migration now recognize the server's "bandwidth exceeded" response, stop the run immediately, and say when to retry; everything already downloaded is kept.
- **The app no longer crashes at launch on Linux systems without a configured locale.** On a system where the language environment is unset (LANG empty, common on minimal installs and servers), the browser engine reports the raw "C" locale, and every date formatter rejected it — taking the whole window down to a "Something went wrong" screen before anything loaded. Date formatting now falls back to the system default when the reported locale isn't usable.

## [2.8.0] - 2026-07-26

### Fixed
- **Scrolling to the bottom of the list loads more mail again.** If the background load ever stopped quietly — a network blip at launch was enough — the list froze at whatever it had (say 741 of 15,083) and scrolling did nothing: the scroll position was never actually watched, so reaching the end couldn't restart the load. Scrolling near the bottom now kicks it off directly.
- **Images embedded in an email show up again.** Logos and signature images that a message carries inside itself rendered as empty boxes: the app fetches messages without their attachment data to keep things fast, so there was nothing to put in the image. It now loads just the embedded images from the message's local copy when you open it.
- **The message list header now says how much of the mailbox is actually in the list.** It always showed the mailbox's total on the server, so a list that was still filling looked exactly like a finished one. It now reads "741 of 15,067 emails" until everything is loaded.
- **Adding an account with a non-standard mail-server port works again.** Typing anything into the IMAP or SMTP port field made the connection test fail before it dialled — the port was sent as text where a number was expected — so only accounts on the default ports could be added.
- **Bulk operations can now select the whole mailbox, not just what's on screen.** Picking "All" in Bulk Email Operations only covered the messages the list had scrolled in so far — on a 15,000-message inbox that was a few hundred — even though the app already held every message locally. It now selects from the full local copy of the mailbox, and skips messages you have already deleted.
- **Switching back to an account is instant now.** The message list restarted at “500 of 15,065” and counted up again on every switch, because the app rebuilt the list by reading one file per message off disk — fifteen thousand of them — even though it had just had them all in memory. It now keeps the last few mailboxes it showed you, and when mail has arrived while you were away it re-reads only the messages that actually changed rather than starting the whole list over.
- **Loading a large mailbox no longer crawls.** Filling the list read every message file in the mailbox over again on each step — fifteen thousand of them, several times a second — so the count climbed a little at a time with long pauses and looked stuck. It now reads only the messages it doesn't already have.
- **The message list no longer stops partway through loading and sits there.** After switching accounts it could stick at a few hundred messages — spinner showing, nothing actually downloading — until you hit refresh. Two parts of the load raced over the same "still loading" flag, and the quick server check added in this release made the wrong one win.
- **The email counter no longer counts backwards.** The “x / y emails” indicator measured how much of the list was on screen, which drops every time you switch accounts, so a switch looked like a fresh download. It now shows how much of the mailbox has been downloaded — a number that only goes up — and stops spinning when nothing is actually downloading.
- **Switching accounts no longer restarts the whole load.** Every switch ran a full server sync and waited on it, even for an account you had opened moments earlier, and it restarted the background download of every other account's mail from the beginning. The app now asks the server whether anything actually changed — one quick check instead of a full sync — and picks up background work where it left off rather than starting over.
- **A backup that succeeded is no longer reported as failed.** The prompt shown after a backup finishes could error and drag the completed backup down with it, marking it failed and quietly re-running it up to three more times.
- **A dropped connection can no longer wipe cached mail.** If the server closed the connection while listing a mailbox's messages, the list came back empty with no error — and the empty list was treated as "everything was deleted". The listing is now checked against the server's own message count and refuses to report a partial result.
- **Changing only the port of an account's mail server no longer reuses the old connection.** Connections were pooled by address alone, so a config that differed only by port was handed a connection to the previous server.
- **Large mailboxes no longer get stuck loading forever on some servers.** Listing the messages in a mailbox used one very long server reply, and on a 15,000-message mailbox some servers (Purelymail among them) interrupt that reply with a keep-alive line, which made it unreadable. The listing now arrives one message per line, so an interruption can't corrupt it.
- **A failed lookup can no longer blank your cached mail.** When that reply failed to parse, the leftovers stayed in the connection and the next command read the wrong answer — reporting an empty mailbox and deleting hundreds of cached messages. Connections are now dropped after a failed command instead of being reused.
- **A mailbox whose background fill fails now loads normally instead of spinning.** The app waits while the helper fills a partly cached mailbox; if that fill failed, the wait never ended and the list kept loading with nothing actually downloading. The app now falls back to loading pages itself.
- **Mail connections are closed properly when you quit.** The app and the background helper now log out of every open server connection on exit, instead of leaving them for the server to time out.
- **Email light/dark switching works again in installed builds.** The app's security policy was tightened at build time in a way that blocked the script that darkens email content, so the Light/Dark button and the email theme setting did nothing — the button changed state, the email stayed light. Opening the same email in its own window was unaffected, which is why it looked intermittent.
- **A mailbox that is only partly cached now fills itself in, once.** After a restore or a server migration the local cache could hold a few hundred messages of a 15,000-message mailbox while still looking fully in sync — so every launch dragged the missing thousands off the server, a few hundred at a time, and rarely got to the end before the app was closed. The background helper now notices the shortfall and downloads only the missing headers, newest first, while you keep using the app.
- **Loading a large mailbox no longer slows down the further it gets.** Each batch of messages used to re-save every message loaded so far, so a full 15,000-message load performed well over half a million file writes. Only the new batch is written now.
- **Your other accounts no longer re-download their whole mailbox at startup.** Background loading for non-active accounts (and the Sent folder of the active one) fetched every page from the server on every launch, ignoring the cache entirely. It now syncs the same incremental way the active mailbox does.
- **The background helper is reachable again.** The app was looking for the helper's connection socket in the wrong folder, so every request to it failed and Settings always reported "Helper Not Running" — even while the helper was running normally. Affected contact indexing, AI classification, snapshots and background sync since 2.7.0.
- **App restarts no longer re-download the mailbox.** Saving headers used to delete every cached message that wasn't in the on-screen window, so an ordinary save cut a 14,000-message cache down to 500 — and the rest was then re-fetched from the server page by page, roughly 70 IMAP round-trips on every launch. The cache is now treated as a superset of the loaded window and only drops messages that are actually gone.
- **Read, unread and star changes now survive a restart.** Header cache writes skipped files that already existed, so a flag change updated the list but never reached disk and the old state came back on the next launch.
- Background sync now fetches only what changed — the messages that arrived since the last sync, plus flag updates — instead of re-fetching the newest 500 headers every time. Sync metadata is also no longer wiped by routine cache saves, which had been silently forcing that full fetch.
- Scrolling back through a large mailbox now reads from the local cache instead of re-fetching pages from the server.
- Deleted emails are pruned from the local cache on a count mismatch and, as a backstop, on a periodic full reconciliation — so a message deleted from another device can no longer linger in the list.
- Messages the server has flagged as deleted but not yet removed are now hidden from the list. Messages archived to your local vault stay visible either way.
- Emails no longer reappear as duplicates or ghosts after a server rebuilds its message IDs (UIDVALIDITY change) — the stale generation is now cleared instead of merged with the new one.
- Read and star state now refreshes on servers that don't support CONDSTORE, which previously left cached messages showing stale flags indefinitely.
- Deletions made in Outlook/Microsoft 365 accounts are now removed from the local cache instead of reappearing on the next load.
- The Sent folder for Outlook/Microsoft 365 accounts is no longer capped at 200 messages.
- Loading more messages could skip about 100 emails when the list was seeded from the cache; pages now overlap and de-duplicate instead.

### Internal
- Removed a second, unused email cache implementation (`mailvault_core::cache`) and the 14 daemon RPCs that fronted it — nothing called them, and the app has always read the sidecar cache through Tauri.
- A failed background sync no longer leaks its IMAP connection back into the pool.

## [2.7.0] - 2026-07-24

### Added
- Change-server restore can now be minimized to a corner bubble: the upload keeps running in the background, the bubble shows live progress, and clicking it reopens the modal (Escape mid-restore also minimizes instead of being blocked).
- Thread view: clicking a sender's name or avatar now opens the same Sender Details popover as chat view (full address, To/CC, verification, mailing-list "via").
- Restore-to-server: when an account's IMAP host is changed to a new, empty server, the app detects that the local Maildir still holds the account's mail and offers to re-upload it (all folders, flags preserved, dedup-safe re-runs).
- **Guided Change Server flow**: dedicated 3-step modal replacing the old Settings-only server edit. Enter new IMAP/SMTP hosts and the new password in one form — hosts are pre-filled by DNS auto-detection (SRV/autoconfig/MX), with a warning when your domain's DNS still points at the current server. Both IMAP and SMTP are verified (new `smtp_test_connection` command) before anything is saved. After saving, the app offers to upload locally stored mail to the new server, then runs a DNS health check (MX/SPF/DKIM/DMARC, new `dns_mail_health` command) and warns if mail delivery would be affected.
- **Mac App Store build target**: New `appstore` Cargo feature, `tauri.appstore.conf.json` overlay, and `Release (Mac App Store)` GitHub Actions workflow. Build locally with `npm run build:appstore`; CI builds + signs + uploads via App Store Connect API. See `BUILDING.md` for required secrets and gotchas.
- **In-app purchase gating for Cloud Backups (MAS only)**: External backup folders are now gated behind a non-consumable StoreKit IAP (`com.mailvault.app.backups`) in App Store builds. New `iap_*` Tauri commands bridge to `SKPaymentQueue`/`SKMutablePayment` via `objc2-store-kit`; entitlement is persisted in `NSUserDefaults`. Non-MAS builds are unaffected — the IAP module is stubbed out and always reports entitlement.
- **Paywall UI in Backup settings**: `BackupConfig.jsx` shows a one-time purchase prompt with a Restore button when running an unentitled MAS build.

### Changed
- **Sparkle auto-updater is now an opt-in Cargo feature (`sparkle`, on by default)**. MAS builds drop the plugin, the `Sparkle.framework`, the "Check for Updates…" menu item, and the background update check — App Store handles updates instead.
- Sidebar connection-error card: "Change server" now opens the guided flow directly; "Migrate mail" removed from the card (the migration wizard needs a working source server — it remains in Settings → Migration). The expanded-sidebar card variant now also offers "Change server" (it previously only appeared in the collapsed variant).

### Fixed
- Deleting emails (single or multi-select) did nothing on servers whose Trash folder lives in a namespace (e.g. Hostinger/Dovecot `INBOX.Trash`): the delete now resolves the real Trash mailbox via SPECIAL-USE/LIST (auto-creating one if missing) instead of guessing hardcoded names, and falls back to COPY + EXPUNGE on servers without MOVE. Previously the message was only flagged `\Deleted` and reappeared on reload.
- **Deleted emails no longer resurrect from the local header cache.** Moving mail to Trash bumps the server's CONDSTORE modseq without changing UIDNEXT, and the flag-only fast sync path cannot see expunges — deleted emails kept reappearing on reload/restart even though the server delete succeeded. The fast path now verifies the server message count and falls through to full UID reconciliation when it changed.
- Fixed an IMAP session desync that could blank an entire folder view: some servers' (e.g. Purelymail) ESEARCH responses fail to parse in our IMAP library, leaving the connection misaligned so every subsequent command read the previous command's reply — a delete followed by a sync then wrongly concluded the mailbox was empty. The ESEARCH fast path was removed (plain `UID SEARCH ALL` everywhere) and the app now refuses to prune the email list when a search claims "empty" while the server reports messages.
- Deleted emails now disappear from the list instantly on confirm; the server deletion runs in the background and any email whose server delete fails is restored on the follow-up sync.
- Deleted emails no longer flash back when switching accounts or folders while the server deletion is still in flight (session-scoped delete tombstones filter them out of every list render until the cache is reconciled).
- Thread view: the sender-details/verification popover is no longer clipped when opened on a collapsed message row.
- Unrelated automated emails with identical subjects (forum digests, contact-form notifications) are no longer merged into one giant thread. Subject-based thread merging now only applies to `Re:`/`Fwd:`-prefixed messages that lack threading headers; proper `References`/`In-Reply-To` chains still thread as before.
- Post-server-change DNS health check no longer flags a missing DKIM record for domains using Purelymail (added `purelymail1-3` and other common selectors), and the warning now says the check is inconclusive rather than claiming DKIM is absent.
- Changing servers when the stored password is missing or stale no longer dead-ends: the connection test now uses the newly entered password instead of the stored one.
- Background-sync daemon now returns the same flat mailbox list as the app, fixing accounts on some providers (e.g. Hostinger) appearing to have only one folder in daemon-driven flows (fixed as part of consolidating the duplicated IMAP client — see Internal).

### Removed
- **Bun-compiled `mailvault-server` sidecar deleted.** All IMAP/SMTP/OAuth2 logic already lived in the Rust Tauri process; the Node sidecar was dead weight (last frontend caller — `src/workers/emailCacheWorker.js` — was unreferenced). Drops ~30 MB from the bundle, eliminates the JavaScriptCore JIT entitlement requirement that was blocking MAS review, and removes dependencies on express/cors/helmet/imapflow/mailparser/nodemailer/express-rate-limit + Bun toolchain. OAuth2 loopback callback now bound by `src-tauri/src/oauth2.rs` on `127.0.0.1:19876`.

### Internal
- **Codebase-wide dead-weight purge (~5.2k lines removed)**: duplicated IMAP/Graph/OAuth2/DNS modules consolidated from `src-tauri` + `src-daemon` into the shared `mailvault-core` crate (the two copies had already drifted); never-compiled `helper.rs` deleted; dead Tauri commands, dead frontend modules/exports, and unused dependencies removed (`uuid`, `@tauri-apps/plugin-http`, `thiserror`, `log`, `once_cell` → `std::sync::LazyLock`, `tauri-plugin-http`); daemon tokio features trimmed.
- Oversized frontend modules split on existing seams with zero behavior change: `activateAccount.js` → one-workflow-per-file, `db.js` → `db/` submodules behind a facade, `GeneralSettings.jsx` → per-subtab components, `ChatBubbleView.jsx` modals extracted.
- `iap.rs` module + `MV_IAP_DEV_ENTITLE=1` env override for local testing of the paywall flow.
- `entitlements-appstore.plist` now omits Sparkle XPC mach-lookup keys.
- `entitlements.plist` no longer includes JIT entitlements (`cs.allow-jit`, `cs.allow-unsigned-executable-memory`, `cs.disable-library-validation`) — they were only needed by the removed Bun sidecar.
- `scripts/build-server.js` → `scripts/build-daemon.js` (daemon-only build).
- Removed `src-tauri/entitlements-sidecar.plist`.

## [2.6.0] - 2026-05-04

### Improved
- **Row delete confirmation**: The 3-dots row menu's "Delete from server" no longer relies on an unreliable inline two-click confirm inside the virtualized row. Confirmation is now lifted to a portal-rendered modal at the list level so it escapes the virtualizer's transform stacking context and works consistently across the default and compact email/thread rows.

### Fixed
- **MIME-encoded subjects with non-conformant whitespace**: Subjects like `=?utf-8?Q?Dovan=C4=97l=C4=97_?=naujagimiui ir mamai` (encoded-word adjacent to plain text without RFC-required separating whitespace) now decode correctly in the email list and thread view. Replaced strict `mailparse`-based decoder with a lenient RFC 2047 scanner shared between the desktop app and daemon (`mailvault_core::mime::decode_rfc2047`). Full-mail Subject extraction now reads `get_value_raw()` and routes through the same decoder.

## [2.5.0] - 2026-04-27

### Added
- **Outbox tray + local stage-then-send**: Compose now archives to local Maildir before SMTP send; new outbox tray surfaces in-flight sends with cancel and retry; Shift+Enter sends; configurable per-compose send delay
- **Per-account Sent folder resolution**: Tiered SPECIAL-USE → name-heuristic → lazy CREATE detection with auto-heal so sent emails reliably land in the right Sent folder per account
- **Contacts picker popover**: Per-account filtered + boosted contact suggestions in compose; 15s reload throttle; daemon-side contacts indexing across INBOX, Sent, and custom folders (with frontend disk-walk fallback)
- **Reply-To mismatch alert**: New `ReplyToAlertIcon` flags emails whose `Reply-To` header diverges from the `From` address — common phishing tell
- **Email viewer dark mode v5**: Inlined DarkReader with body-only scan, per-email toggle, and new `emailViewerTheme` setting that decouples app theme from email rendering theme
- **Maildir `.eml` suffix + migration**: Stored email files now carry the `.eml` extension for OS-level interoperability; daemon performs a one-time version-guarded rename of legacy filenames on startup

### Improved
- **Link safety modal**: Portal-rendered so it escapes virtualized-row transform ancestors and sits correctly over the viewport
- **Selection action bar**: Narrow-screen layout fit and pointer-events fix on the delete confirmation popover
- **Account activation**: Guards against wiping email state on background refresh paths
- **Dev script**: Daemon socket and lockfile path aligned at `~/.mailvault/mv.sock` for sandboxed/sidecar parity
- **Settings menu**: Sidebar restructure continues — feature views (Email Cleanup, Time Capsule) consolidated under settings

### Fixed
- **Sent IMAP APPEND hang on Hostinger**: Added pool-checkout and append-verified breadcrumbs; Message-ID parser rewritten for CRLF; secondary IMAP append spawned instead of awaited so a stalled secondary cannot block the primary send response
- **Compose Escape behavior**: Escape now mirrors backdrop click (minimize to outbox bubble) instead of popping a discard prompt
- **Iframe load race / cache scope**: Fixed intermittent "blank email" caused by iframe load-event race and cache-key scope mismatch
- **macOS WKWebView dark scrollbars**: Themes now declare CSS `color-scheme` so scrollbars render correctly on dark backgrounds
- **WKWebView file:// charset**: Email HTML loads with UTF-8 BOM + meta charset first to avoid Latin-1 default decoding
- **Stacked keychain prompts**: Removed second uncancellable `spawn_blocking` retry path that produced a duplicate macOS keychain dialog

## [2.4.0] - 2026-04-16

### Added
- **Email Cleanup settings view**: Moved Email Cleanup from sidebar into Settings as an inline feature view with Naive Bayes classification controls
- **Time Capsule settings view**: Moved Time Capsule from sidebar into Settings as an inline feature view
- **Backup settings components**: Decomposed backup settings into focused subcomponents (account cards, config, restore, schedule, verification tree)
- **Snap publish gating**: Release pipeline no longer auto-publishes snaps; new Promote Snaps workflow for manual publish after testing
- **Configurable send delay**: Per-compose send delay override (15s–5min) with global default in settings
- **Sent folder sync**: Copy sent email to IMAP Sent folder after SMTP send

### Improved
- **Email classification**: Replaced heuristic-based classification with Naive Bayes classifier for more accurate email categorization
- **Email list performance**: Extracted EmailRow and ThreadRow into standalone memoized components
- **Settings architecture**: Restructured settings into modular subcomponents for better maintainability
- **Background helper architecture**: Extracted daemon management into dedicated `helper.rs` module separating launch strategy from RPC transport; UI reworded from "system service" to "background helper"

### Fixed
- **Outlook/Graph email content mismatch**: Clicking one email could display a different email's content — synthetic positional UIDs drifted when email order changed between fetches; Graph message ID now embedded directly on each email header
- **Cross-account email bleed**: Switching folders showed stale emails from the previous account when the target folder was empty — all email state is now cleared atomically on account/mailbox switch
- **Daemon sandbox socket**: IPC socket moved to `~/.mailvault/mv.sock` via `dirs::home_dir()` so both the sandboxed app and sidecar daemon resolve the same container-relative path
- **Daemon entitlements**: Removed `app-sandbox` from daemon (crashes standalone binaries without Info.plist); removed `application-groups` (not needed with shared container home)
- **Release signing**: `$(AppIdentifierPrefix)` in entitlements is now expanded before codesign — fixes silently broken keychain sharing between app and daemon
- **Module cache invalidation**: Clear module-level caches on invalidation, cap unified folder cache, remove redundant descriptor saves
- **Account activation**: Prevent infinite recursion in activateAccount descriptor restore path
- **Store architecture**: Remove state-duplicating domain store wrappers, use thin selector re-exports

## [2.3.2] - 2026-03-29

### Fixed
- **macOS external backup crash**: Fixed wrong Objective-C selector (`relativeToBookmarkURL` → `relativeToURL`) in security-scoped bookmark resolution that caused SIGABRT when selecting or validating an external backup folder on macOS
- **Bookmark lifecycle hardening**: All macOS Objective-C bookmark calls wrapped in catch_unwind so malformed bookmarks degrade to "needs reauthorization" instead of crashing the app

## [2.3.1] - 2026-03-29

### Added
- **External backup failure reporting**: IMAP and Graph backup runs now track external-copy failures separately — local backup succeeds independently while external failures are captured with per-email counts
- **Degraded backup status in UI**: Backup Settings shows amber "Partial" state for runs where local backup succeeded but external copy failed, distinct from full success and total failure
- **Version consistency check**: New `check-version-consistency.sh` script runs in CI to catch version drift across package.json, Cargo.toml, tauri.conf.json, and snapcraft.yaml

### Fixed
- **macOS sandbox external backup**: External backup folder access now uses security-scoped bookmarks that persist across app restarts; legacy raw paths are detected and prompt reauthorization
- **Linux Snap external backup**: External backup validates actual write access under Snap confinement instead of assuming paths are writable
- **Backup verification bypass**: "Check backup coverage" no longer reads the legacy `backupCustomPath` — uses native bookmark-resolved path like the rest of the backup system
- **Silent external write failures**: External `fs::write` and `create_dir_all` failures in IMAP archive and Graph backup are now captured and reported instead of silently ignored
- **Stale Snap version**: snapcraft.yaml fixed from 2.1.3 → 2.3.1; bump script rewritten with pattern-based replacement so drifted files are corrected instead of silently skipped
- **Display name quoting**: Fixed quote stripping for names with mixed Unicode/ASCII quotes; name upgrade logic replaces email-derived local parts with proper display names
- **CI e2e build**: Added stub binary for Linux, fixed binary name mismatch, increased timeout

## [2.3.0] - 2026-03-28

### Added
- **Premium subscriptions via Stripe**: Monthly (€3) and yearly (€25) plans with Stripe Checkout, webhook processing, Customer Portal, and a new Billing tab in Settings with plan cards, feature comparison, and subscription management
- **14-day free trial**: Yearly plan includes a 14-day free trial for new customers; trial eligibility is server-driven and one-per-customer; monthly plan remains paid immediately
- **Multi-currency billing**: EUR base pricing with fixed USD and GBP options; Stripe Adaptive Pricing for other currencies; server-driven pricing endpoint so displayed prices always match checkout
- **5-device subscription limit**: Per-install client registration with automatic oldest-device replacement when a 6th device connects; device usage bar and active client list in Billing settings
- **Sparkle auto-updater (macOS)**: Native Sparkle 2 framework integration for sandboxed macOS builds — automatic update checks, download, and quit-time installation via XPC services
- **Backup verification view**: Folder-level tree table in Backup Settings showing Server / App / External counts per folder with expand/collapse, summary chips, and progress bar — works for both IMAP and Outlook/Graph accounts
- **Backup icon opens focused account**: Clicking a sidebar backup status icon opens Settings on the Backup tab and scrolls to that account's card with a transient accent ring highlight
- **Empty-cache corruption prevention**: Suspicious empty server results are now rejected when prior cache had data — preserves mailbox trees and email headers with last-known-good recovery, IMAP verification pass, and sidebar warning banner

### Improved
- **Billing rate-limit protection**: Single-flight status checks with 60s auto / 10s manual cooldowns, split server rate limiters by route, 429 handling with Retry-After, in-memory server-side response cache
- **Shared credential resolver**: Mail loading and backup share a single `resolveServerAccount()` helper — eliminates duplicate credential-check paths; Graph accounts get JWT validation and forced refresh everywhere
- **Keychain access**: Single-prompt model — at most one OS keychain prompt per session; if denied/cancelled/timed out, no background re-prompts; app stays usable with cached/local data
- **Backup scheduler**: Lifecycle-aware coordinator with proper state machine, time-of-day and day-of-week scheduling, gates that prevent backup during active use, and resumable folder-level checkpoints
- **Sidebar performance**: Isolated backup progress into ephemeral store, narrowed store subscriptions, memoized per-account rows
- **Display name handling**: Fixed quote stripping for names with mixed Unicode/ASCII quotes (e.g. Lithuanian company names); name upgrade logic now correctly replaces email-derived local parts with proper display names

### Fixed
- **Graph/Outlook external backup**: `run_graph_backup` now writes emails to both app Maildir and external backup directory; adds bidirectional pre-sync per folder
- **Outlook credential recovery**: `resolveServerAccount()` accepts keychain accounts with malformed access tokens if they have a refresh token, then force-refreshes
- **Outlook OAuth reconnect**: Settings reconnect now passes `useGraph`, `customClientId`, and `tenantId` to `getOAuth2AuthUrl()`
- **Graph/Outlook token handling**: Reverted `hasValidCredentials()` to presence-only check — Microsoft Graph can return opaque non-JWT tokens that are valid
- **Manual backup false success**: "Back up now" button no longer shows Done! when backup was skipped due to missing credentials
- **Keychain retry loops**: Removed JS-side retry loop and automatic re-prompt; structured response returns status instead of raw HashMap
- **Outlook sidebar badge**: Successful backup no longer shows amber warning when slightly overdue
- **Backup coverage check**: Fixed missing `api` import that caused runtime error

## [2.2.1] - 2026-03-13

### Added
- **Sender-grouped view**: New toggle in email list toolbar groups emails by sender → topics → individual emails in an accordion layout
- **Dedicated mailbox cache**: Mailbox list cached separately per account for instant folder loading
- **App-specific password help links**: iCloud and AOL provider notes now include direct links to generate app passwords

### Improved
- **Mailbox loading performance**: Local email index cache (`local-index.json`) eliminates .eml MIME parsing on load; progressive chunked rendering shows emails instantly with background loading; switching mailboxes/accounts cancels in-progress loads via AbortController

### Fixed
- **Startup crash**: Removed Sparkle updater framework that caused `dispatch_sync` deadlock crash on macOS launch; custom appcast updater remains fully functional
- **Unified inbox**: Fixed local/archived emails not showing for accounts with overlapping UIDs in unified view

## [2.2.0] - 2026-03-11

### Improved
- **Email loading**: Refactored to two-stream architecture — local cache and server data load in parallel via `activateAccount()`, replacing 6 overlapping phases with a clean Promise-based model; eliminates "empty emails" bug on rapid account/mailbox switching via AbortController cancellation
- **Codebase refactor**: Extracted Graph config, LRU caches, search, and performance tracing into dedicated modules; SettingsPage and EmailViewer split into focused sub-components; bulk operations presets reordered by duration (Today → All)

## [2.1.5] - 2026-03-11

### Fixed
- **Linux window activation**: Clicking app icon while already running now brings window to front via SIGUSR2 signal between instances (previously second instance exited silently)

### Improved
- **Compose modal**: Larger compose window (max-w-4xl, 80vh height) for more writing space; unsaved changes confirmation prevents accidental dismissal

## [2.1.4] - 2026-03-11

### Fixed
- **macOS updater**: Replaced Sparkle XPC installer with custom appcast-based updater — checks GitHub releases, shows in-app update modal with direct DMG download link; eliminates "An error occurred while launching the installer" permanently

## [2.1.3] - 2026-03-11

### Fixed
- **macOS updater**: Added `SUEnableInstallerLauncherService` to Info.plist — required for sandboxed Sparkle updates; fixes "An error occurred while launching the installer" on v2.1.1+
- **Linux single instance**: Enforce single app instance via `flock` kernel lock — prevents email disappearance caused by multiple concurrent instances; works across AppImage, .deb, Snap, and Flatpak
- **IMAP error messages**: Show actual IMAP error instead of generic "Failed to connect" when adding accounts

## [2.1.2] - 2026-03-11

### Fixed
- **Snap updater**: Detect snap environment and show "Updates managed by Snap Store" instead of cryptic "builder error"; `.deb` installs show helpful message directing to website
- **Snap keyring**: `password-manager-service` plug requires manual connection (`sudo snap connect mailvault:password-manager-service`) — documented and improved error handling
- **Linux error messages**: Fixed generic "Failed to connect to email server" when actual IMAP error was available — Tauri invoke errors are strings, not Error objects

## [2.1.1] - 2026-03-10

### Changed
- **macOS updater**: Replaced broken Tauri updater with Sparkle 2 framework — native macOS update UI, sandbox-safe XPC installer, EdDSA-signed appcast.xml; Linux keeps tauri-plugin-updater with custom UpdateModal

## [2.1.0] - 2026-03-10

### Added
- **Custom update modal** — replaced native OS update dialog with a styled in-app modal showing full changelog, download progress bar, and three dismiss options: "Update Now", "Remind Me Later" (24h snooze), and "Skip This Version"
- **Keyboard shortcuts** for all core actions (navigation, compose, reply, archive, delete, move) with customizable bindings, cheat sheet modal (`?`), and settings UI for rebinding
- **Move to Folder** — move single or bulk-selected emails between server folders via IMAP MOVE/COPY with undo support; Graph API support for Microsoft accounts
- **Undo Send** — configurable delay (5/10/15/30s) before dispatching emails, with countdown toast and one-click cancel to reopen compose
- **Unified Inbox** — merged chronological view of all accounts' inboxes with per-account colored indicators and correct reply routing
- **Notification customization** — per-account and per-folder notification controls with privacy-aware preview toggle (show sender+subject or generic message)
- **Email templates** — save, manage, and insert reusable email snippets when composing, with save-as-template from any draft
- **Smart Sender Insights** — collapsible panel in email viewer showing exchange history, frequency, common topics, and accounts used per sender
- **Auto-Cleanup Rules** — automated email cleanup by age and folder with archive-then-delete or delete actions, dry-run preview, and 24-hour scheduling (Pro feature)

### Improved
- **Performance** — unified inbox loads instantly from disk cache on launch; account cache increased to 8 with pre-warming from headers.json; chat view uses deferred threading, React.memo, and virtualization; layout switch uses debounced ResizeObserver
- **Folder caching** — mailbox folders persist to disk and restore instantly on cold launch; background IMAP refresh updates silently; removed folder expand/collapse animation for snappier UI
- **Email content fallback** — retry with exponential backoff when body loading fails; graceful degradation shows email text/snippet instead of error message

### Fixed
- **Loading guard scope** — moved 20-second loading timeout to cover entire loadEmails function including credential and network checks, preventing stuck spinners during early failures
- **Bulk operation toast** — fixed React hook ordering violation in BulkOperationProgress component
- **Unified Inbox** — fixed all email operations (select, read/unread, delete, move, archive, export) passing virtual "UNIFIED" mailbox to IMAP instead of resolving the real account and INBOX; fixed stale content flash when entering/leaving unified view; fixed account switch from unified inbox showing combined emails instead of individual account; fixed "All Inboxes" header persisting after leaving unified view
- **Account switching** — fixed selecting an account from unified inbox doing nothing when it was the previously active account; fixed invalid remembered mailbox (deleted/renamed folder) causing blank screen — now falls back to INBOX
- **Snap Store** — added CA certificate bundle and SSL environment variables to fix "Failed to connect to email server" in strict confinement

## [2.0.3] - 2026-03-08

### Fixed
- **Loading guard scope** — moved 20-second loading timeout to cover entire loadEmails function including credential and network checks, preventing stuck spinners during early failures
- **Bulk operation toast** — fixed React hook ordering violation in BulkOperationProgress component

## [2.0.2] - 2026-03-08

### Added
- **Bug report email** — "Report Bug" button in Settings > Help & Support and in the app menu; opens a pre-filled compose window with system info (version, OS, account count, provider) and structured bug report template, sent to the developer
- **DNS-based email auto-detection** — when adding a custom-domain account, the app now resolves SRV records (RFC 6186), Mozilla autoconfig XML, and MX records to automatically detect IMAP/SMTP server settings; includes known provider mapping (Google Workspace, Microsoft 365, Hostinger, Zoho, Yahoo, Fastmail, ProtonMail) with pattern-guess fallback
- **Email list info bar** — folder header now displays total email count, current view mode (All/Server/Local), and date range of loaded emails
- **Progressive archive icons** — email list icons now update in real-time during batch archive as each email is saved, instead of waiting for the entire operation to complete

### Fixed
- **Bulk save toast** — "Operation complete" notification now auto-dismisses after 4 seconds on success; X button available for immediate dismiss; error completions stay visible until manually closed
- **Account modal dismiss protection** — clicking outside or pressing Escape while adding an account now shows a confirmation dialog if any data has been entered, preventing accidental loss of typed details
- **Folder name display** — stripped `INBOX.` prefix from folder names in sidebar (e.g., "INBOX.Trash" now displays as "Trash"); internal folder paths unchanged
- **Email content responsiveness** — single-email view now uses the same responsive iframe sizing as thread view, with proper overflow handling for wide tables, images, and preformatted text
- **Sidebar scrollability** — accounts section is now independently scrollable with a 30% max height cap, ensuring folders remain visible even with many accounts
- **Startup loading spinner** — fixed stuck loading spinner on app launch when cached emails exist; added safety guard in init() and 20-second timeout failsafe
- **Export backup clarity** — removed confusing "All Local Emails" option from export backup modal; only the "Archived Emails" export remains

## [2.0.1] - 2026-03-07

### Fixed
- **macOS updater** — added sandbox entitlement for writing to `/Applications/`, allowing in-app updates to complete successfully
- **DMG installer** — simplified DMG layout with cleaner icon positioning; removed custom background image

## [2.0.0] - 2026-03-07

### Added
- **Linux support** — MailVault now runs natively on Linux (x86_64 and aarch64) with .deb and AppImage packages; credentials stored via D-Bus Secret Service (GNOME Keyring / KWallet); native Wayland and X11 support; CI builds macOS + Linux in parallel
- **Linux app menu** — File menu with Check for Updates, Settings (Ctrl+,), and Quit (Ctrl+Q); Logs menu with Export Logs

### Fixed
- **Memory reduction** — lowered default body cache from 512 MB to 128 MB, reduced account/mailbox LRU cache sizes, excluded derived data from cache snapshots; targets ~200-300 MB total memory (down from ~1.14 GB)
- **App updater** — "Update Now" button now shows a downloading indicator and displays error dialogs on failure instead of silently doing nothing
- **Email list overlap** — action buttons (archive, menu) no longer overlap text when the email list panel is narrow; buttons now float over the row on hover
- **macOS-only Reopen event** — fixed compilation error on Linux where `RunEvent::Reopen` is macOS-only

## [1.9.2] - 2026-03-04

### Added
- **Quote folding** — quoted reply content (> lines, "On wrote:", Original Message blocks, HTML blockquotes) is detected and collapsed behind a clickable toggle in both thread view and chat view; collapsed by default for cleaner reading
- **Signature folding** — email signatures detected and handled with configurable display mode: Smart (show once per sender per thread, collapse duplicates), Always Show, Always Hide, or Collapsed with toggle; configurable in Settings > Appearance
- **Sender verification badges** — two-layer sender spoofing check: header mismatch detection (From vs Reply-To/Return-Path domain) and email authentication parsing (SPF/DKIM/DMARC from Authentication-Results header); shows green shield for verified, orange warning for Reply-To mismatch, red warning for authentication failure
- **Thread sort order** — configurable setting to sort thread emails oldest-first or newest-first; available in Settings > Appearance
- **Thread email details** — expanded header info (Message-ID, Reply-To, full date) and View Source button now available in thread conversation view, matching single email view

### Fixed
- **Attachment downloads on IMAP accounts** — fixed "Email UID not found" error when downloading attachments; `.eml` files were being saved under the email-address directory instead of the account UUID directory, causing a path mismatch on read; includes one-time migration of orphaned files
- **Embedded inline images** — CID-referenced images (e.g. logos, inline photos) now render correctly in email body by replacing `cid:` URLs with inline data URIs; applies to single email, thread, and chat views
- **Export/import progress** — backup export and import now show a non-blocking progress modal with real-time file count instead of a button spinner; export choice dialog uses clearer wording ("Archived Emails" / "All Local Emails")
- **Faster folder loading** — mailbox folder list is now cached and loaded instantly on app startup and account switch; server refresh happens in background without blocking the UI; all visible accounts' mailboxes are pre-fetched on startup

## [1.9.1] - 2026-02-28

### Added
- **Microsoft Graph API transport** — personal Outlook.com/Hotmail/Live.com accounts now use Graph REST API instead of IMAP, bypassing the known Microsoft IMAP server-side regression; auto-detected by email domain; supports read, delete, and mark read/unread
- **Own Azure AD app registration** — replaced borrowed Thunderbird client ID with MailVault's dedicated Azure AD app for more reliable corporate M365 OAuth2 authentication
- **Advanced OAuth2 fields** — corporate Microsoft users can now specify a custom Client ID and Tenant ID for organizations with strict OAuth2 policies

### Fixed
- **Thread view loading** — fixed race condition where email content showed "Could not load" until manually collapsed/expanded; bodies are now pre-populated synchronously before first render

## [1.9.0] - 2026-02-26

### Fixed
- **Date alignment in email list** — date no longer shifts position when archiving emails (fixed-width hover action area)
- **Keychain access** — keychain dialog now appears without freezing UI (async Rust); retry button uses correct credentials format with cache reset; auto-retries after 5s if keychain was slow; clear "Password missing" error with direct Settings link when credentials are lost

### Added
- **Year display for old emails** — previous-year emails now show the year (e.g., "Feb 25, 2024")
- **Locale-aware date formatting** — uses system region by default; configurable in Settings > Appearance with presets (US, European, ISO, short) and custom date-fns pattern support
- **Instant account switching** — LRU cache (max 5 accounts) saves/restores full email state on account switch; eliminates empty-list flash and avoids re-reading 15-20MB headers.json from disk
- **Parallel background header loading** — background accounts now load INBOX + Sent headers immediately alongside active account content caching (previously blocked until active finished); mailbox lists pre-fetched for instant folder switching on account change
- **Email body pre-fetch** — next 3 email bodies pre-fetched in background after selecting an email for instant navigation
- **CONDSTORE fast-path** — skip redundant disk reads for savedEmailIds/archivedEmailIds when account cache is fresh (< 5 minutes)

### Improved
- **IMAP fetch batch size** — increased from 50 to 200 emails per page, reducing round-trips from 340 to 85 for a 17k mailbox
- **Reduced artificial delays** — pipeline start 1000→200ms, pagination inter-page 1000→200ms, initial loadMore 2000→500ms, CONDSTORE timers 500→200ms, header pagination yield 50→0ms, content fetch yield 50→10ms, worker stagger 500→100ms

## [1.8.0] - 2026-02-25

### Added
- **Bulk operations** — archive-and-delete and bulk delete with concurrent IMAP operations (5 workers), progress tracking, cancel support, and crash-safe pending operation recovery on next launch
- **Selection action bar** — floating action bar for bulk email selection with archive, delete, mark read/unread actions
- **Sidebar refresh button** — manual refresh button in sidebar footer (both expanded and collapsed states) with animated spinner during sync
- **Pull-to-refresh** — pull down on email list to trigger a manual refresh
- **Mailbox LRU cache** — switching between mailboxes (INBOX, Sent, Drafts) is now instant; last 3 mailbox states cached in memory with automatic LRU eviction
- **Instant archived email display** — archived emails stored on disk now appear in the email list within ~400ms (previously 4+ seconds); 3-tier loading strategy: sidecar cache, archived headers cache, .eml fallback with progressive batch display
- **Chat view: attachment support** — chat bubbles and the full-view modal now show functional attachment cards (click to download/open, right-click for Open/Open With/Save As/Show in Folder); uses compact styling to fit the chat bubble aesthetic; correctly resolves mailbox for both inbox and sent folder emails
- **IMAP performance optimizations** — 9 optimizations to IMAP header loading: UID range compression (reduces command size from O(n) to O(ranges)), chunked UID FETCH (200-batch limits prevent command-length errors), lean fetch spec (drops BODYSTRUCTURE/RFC822.SIZE from header loads), newest-first UID fetching (users see newest emails first during delta-sync), COMPRESS=DEFLATE negotiation (70-80% bandwidth reduction when server supports it), capability caching in connection pool, skip-redundant-SELECT tracking, CONDSTORE delta sync (zero IMAP calls when mailbox unchanged, flag-only sync when only flags changed), and ESEARCH for compact UID enumeration
- **Email list scrolling performance** — fingerprint-based memoization skips redundant O(n log n) sorts in `updateSortedEmails()` and `getChatEmails()`; individual Zustand selectors prevent cascade re-renders from background pipeline updates; hand-rolled virtual scroll with static CSS positioning for smooth 17k+ email scrolling
- **Concurrency & pipeline performance optimizations** — 10 optimizations: Set-based uncached UID filtering (eliminates 17k sequential IPC calls), parallel disk reads via Promise.all in loadEmails/setActiveMailbox/pipeline finish, batch `maildir_read_light_batch` Rust command (single IPC for all local emails), IMAP connection pool expanded from 1→3 sessions per account (supports concurrent workers), parallel background account header loading (up to 3 accounts at once), memoized thread building, batch account backfill (single file read/write), reduced pipeline/pagination/loadMore delays (5s→1s, 1s→200ms, 2s→500ms)

### Fixed
- **View mode filtering (all/server/local)** — server view no longer empty on account switch; local view correctly distinguishes archived (green) vs local-only (orange) emails; all view shows correct source icons
- **Thread view date pushed off screen** — CSS `contain: inline-size` at multiple container levels prevents expanded email iframe content from stretching collapsed message headers; date stays visible at all window widths
- **Thread list date shifting on hover** — moved date inside subject flex container so hover action buttons don't displace it
- **Thread view missing archive icons** — each message in thread conversation view now shows source icon (cloud/green HardDrive/orange HardDrive)
- **Thread view iframe overflow** — email HTML content (wide tables, images) no longer expands beyond container
- **Badge count oscillating during IMAP sync** — dock badge no longer flickers between values as email pages load; debounced with 2s delay
- **Archived emails race condition** — `localEmails` no longer overwritten by IMAP sync; fire-and-forget chain is now the sole owner of `localEmails` state
- **Thread cache never working (crash fix)** — `getThreads()` checked `_threadsCache.length` but `buildThreads()` returns a `Map` (which uses `.size`); cache was always bypassed, causing expensive thread rebuilds on every render with 17k emails
- **Thread/compact row crash on null lastEmail** — added null guard to `ThreadRow` and `CompactThreadRow` to prevent crash when a thread has no emails during race conditions
- **findRoot stack overflow** — cycle detection in email threading now also tracks by UID, preventing infinite recursion on emails without Message-ID but with inReplyTo loops
- **Direct Zustand state mutation** — `addToCache` no longer mutates `get().cacheCurrentSizeMB` outside `set()`; uses module-level variable for sub-threshold tracking
- **Sorted emails fingerprint missed flag changes** — `updateSortedEmails` fingerprint now includes a flag-change counter so read/unread toggles are detected
- **loadEmailRange O(17k) loop** — replaced `for (i=0; i<totalEmails)` loop with `Array.from(entries).sort().map()` — now O(loaded) instead of O(total)
- **Sidebar/EmailViewer re-rendering on every store change** — replaced whole-store `useMailStore()` subscriptions with individual selectors in Sidebar and EmailViewer
- **Object selectors without shallow comparison** — split object literal selectors into individual selectors in ChatBubbleView MessageBubble, AttachmentItem, and DownloadAllButton to prevent unnecessary re-renders
- **selectedEmailIds Set cascading re-renders** — thread rows now receive precomputed `anyChecked` boolean prop instead of the full Set reference
- **ThreadEmailItemContent iframe rebuilt every render** — wrapped `iframeContent` string in `useMemo` keyed on `loadedEmail?.html`
- **60fps scroll handler re-renders** — throttled `handleScroll` via `requestAnimationFrame` to batch scroll state updates
- **IMAP NOOP on every pool get** — added time-based skip: sessions used within 60s skip the NOOP health check; added per-session `last_selected` tracking instead of per-account-key
- **Pipeline header loading 200ms artificial delay** — reduced to 50ms (just enough to yield to event loop), saving ~30s on 200-page mailboxes
- **waitForComplete/startContentCaching race** — reordered to call `startContentCaching()` before `waitForComplete()` to prevent synchronous completion firing before promise setup
- **Duplicate loadMoreEmails scheduling** — added module-level timer deduplication to prevent multiple concurrent pagination timers
- **Subject-fallback orphan merge** — orphans with matching subjects now merge with each other (not just with multi-email threads)
- **normalizeSubject called redundantly** — added module-level memoization cache for normalized subjects
- **ensureFreshToken called per-email in pipeline** — moved to before the worker loop with re-call only on auth errors
- **Large mailbox not loading (17k+ emails)** — fixed multiple issues: `_sortedEmailsFingerprint` not reset on account switch caused `sortedEmails` to stay empty via false fingerprint match; quick-load parsed full 15-20MB headers.json (now loads partial 200 headers); `displayEmails` redundantly re-sorted 17k emails (now uses pre-sorted `sortedEmails` directly); `threadedDisplay` depended on stable `getChatEmails` function ref that never triggered recomputation (added `sortedEmails` as dependency)
- **Large mailbox stall at partial cache** — CONDSTORE and non-CONDSTORE early-return paths in delta-sync now check whether the local cache is partial and schedule `loadMoreEmails()` when needed; previously, mailboxes with 17k+ emails would stall at ~200 cached headers because the "no changes" fast path returned without continuing background pagination
- **Endless spinner on app launch** — `getChatEmails()` was calling Zustand `set()` during React render (inside a `useMemo`), and `threadedDisplay` useMemo never reacted to `sortedEmails` changes because the function reference was stable; moved chat email cache to module-level variables
- **Pipeline manager `_destroyed` flag never initialized or reset** — `destroyAll()` now sets the flag, constructor initializes it, and `startActiveAccountPipeline()` resets it so background pipelines can run after a destroy/restart cycle
- **CONDSTORE flag-only sync false negative** — removed `serverTotal === existingEmails.length` condition that failed with partial caches; `uidNext` unchanged already guarantees no new messages
- **Thread cache stale after flag changes** — added `_flagSeq` store state and `_flagChangeCounter` to `getChatEmails`/`getThreads`/EmailList thread fingerprints so read/unread and archive changes propagate to thread views
- **`waitForComplete()` hang on pipeline destroy** — stored resolve callback for `destroy()` to call; made `waitForComplete()` idempotent with shared promise
- **All accounts hidden crash** — added null guard for `firstVisible` in `init()` when all accounts are hidden
- **findRoot O(N²) chain walking** — added memoization cache so each email's thread root is computed once, not re-walked from scratch
- **Thread delete triggers N loadEmails calls** — added `skipRefresh` option to `deleteEmailFromServer`; thread delete handlers now batch deletions and call `loadEmails()` once
- **Dynamic Zustand store key leak** — replaced `_rangeRetry_*` dynamic store keys with module-level `Map` for range retry state
- **Archive state stale in chat view** — `getChatEmails` fingerprint now includes `archivedEmailIds.size`
- **IMAP pool sessions always re-SELECT** — `with_background`/`with_priority` helpers now pass the selected mailbox back to the pool for session reuse tracking
- **App.jsx and usePipelineCoordinator re-renders** — converted whole-store subscriptions to individual Zustand selectors
- **Stale rAF scroll position** — fixed `handleScroll` to read `scrollTop` inside the rAF callback, not in the stale event closure
- **UI freeze on large mailboxes (17k+ emails)** — monolithic `getEmailHeaders()` reading all 17k sidecar JSON files replaced with `getEmailHeadersPartial(200)` for instant display; added `load_email_cache_meta` Rust command for metadata-only reads; heavy Rust commands (`save_email_cache`, `load_email_cache_partial`, `maildir_list`, `maildir_read_light_batch`) moved to `tokio::spawn_blocking` to prevent main-thread blocking
- **Endless spinner on account switching** — `getLocalEmails()` reading all .eml files removed from `setActiveAccount`, `setActiveMailbox`, and `loadEmails` hot paths; archived emails now load via fire-and-forget `getArchivedEmails()` (reads only archived .eml subset); added `_loadEmailsGeneration` counter to cancel stale concurrent `loadEmails` calls on rapid account switching
- **Background pipeline re-reading 17k files** — `EmailPipelineManager` now uses in-memory `pipeline._lastLoadedEmails` from Phase 1 header loading instead of calling `db.getEmailHeaders()` for Phase 2 content caching
- **Whole-store Zustand subscriptions** — added `useShallow` selectors to ChatBubbleView, ChatSenderList, ChatViewWrapper, EmailViewer; converted bare `useMailStore()` to individual selectors in useEmailScheduler and SearchBar

## [1.7.0] - 2026-02-21

### Added
- **Email threading (Gmail-style)** — emails are now grouped into threads using RFC 2822 `In-Reply-To` and `References` headers, with normalized subject as fallback; the regular email list shows collapsed thread rows with participant names, message count badges, and latest date; the chat view uses the same threading algorithm for its topic grouping; Rust IMAP layer now fetches `In-Reply-To` from ENVELOPE and `References` via `BODY.PEEK[HEADER.FIELDS (References)]`
- **Thread conversation view** — clicking a thread in the email list now shows all emails in the thread as a stacked conversation in the viewer; emails are sorted chronologically with the latest expanded by default; each email has its own reply/reply-all/forward buttons and attachment section; email bodies load progressively using the same concurrent loader as the chat view
- **Chat view: sent message merge** — chat conversations now display both received (INBOX) and sent messages together; Sent folder headers are synced via the background pipeline and merged with INBOX emails, with deduplication by Message-ID to avoid duplicates; body loading handles per-mailbox IMAP fetches transparently
- **Clear cache button** — Settings > General > Local Email Caching now has a "Clear Cache" button that removes all cached .eml files and headers, preserves archived emails, and restarts the sync pipeline
- **Hide/unhide accounts** — accounts can be hidden from Settings > Accounts; hidden accounts disappear from the sidebar and stop all syncing (background pipelines, scheduled refresh); unhiding immediately resumes sync; if the active account is hidden, the app switches to the next visible account

### Removed
- **App Password fallback for OAuth2 providers** — Gmail and Microsoft accounts no longer show the "Use App Password instead" toggle; OAuth2 is the only authentication method for these providers as app passwords are less secure

### Fixed
- **Thread row actions** — threaded email rows in the list view now show archive and more-menu buttons on hover (matching single-email rows); archive button archives all emails in the thread; more menu offers "Delete thread from server" with confirmation
- **Chat view "Content cannot be displayed"** — chat bubbles showed "Content cannot be displayed" for all messages because the chat view only received header-only emails (no body content); added progressive body loading via `useChatBodyLoader` hook that fetches email bodies concurrently (3 at a time) from cache → Maildir → IMAP, with per-bubble loading spinners and targeted re-renders

## [1.6.0] - 2026-02-20

### Added
- **Gmail OAuth2 sign-in** — Gmail accounts now support "Sign in with Google" via OAuth2 PKCE flow, alongside the existing Microsoft OAuth2; uses Thunderbird's public Google client ID with `https://mail.google.com/` scope for IMAP and SMTP access
- **Multi-provider OAuth2 architecture** — OAuth2 backend refactored from Microsoft-only to a provider-agnostic design; adding new OAuth2 providers requires only a new `ProviderConfig` entry in Rust
- **Automatic OAuth2 token refresh** — access tokens are now refreshed proactively 5 minutes before expiry; refresh is deduplicated across concurrent calls, persisted to Keychain, and patched into the live store so all pipelines and UI operations get fresh tokens transparently
- **Collapsible sidebar** — click the panel icon in the sidebar header to collapse it to a narrow icon-only strip (~56px); expands back with one click; state persisted across sessions
- **Compact email list view** — alternative 2-line layout (sender + date on line 1, subject on line 2) selectable from Settings > General
- **Account avatar initials & colors** — account avatars now show the first letter of the display name (or email) on a deterministic color circle instead of a generic person icon; each account gets a unique color, customizable per-account from Settings > Accounts
- **From account selector** — compose modal shows a "From" dropdown when multiple accounts exist, defaulting to the currently active account
- **Per-account mailbox memory** — switching accounts restores the last selected folder for that account instead of always resetting to INBOX
- **Non-selectable folder handling** — IMAP `\Noselect` folders (e.g. Gmail's `[Google Mail]`) now expand children on click instead of triggering a SELECT error

### Fixed
- **Inline images treated as attachments** — embedded images with Content-ID (referenced via `cid:` in HTML) incorrectly showed the paperclip icon in the email list and appeared in the attachment section; BODYSTRUCTURE walker now checks Content-ID to distinguish embedded images from real attachments, and `.eml` parsing applies the same filter (tracking pixels also excluded)
- **Gmail XOAUTH2 auth hanging** — `async-imap`'s `authenticate()` deadlocked because the IMAP server greeting was not consumed before starting the SASL handshake; added explicit `read_response()` to drain the greeting first
- **XOAUTH2 authenticator infinite loop** — when the server rejected XOAUTH2 with a `+` error challenge, the authenticator resent the full token on every challenge; now sends empty response on subsequent challenges to let the server close cleanly
- **Gmail OAuth2 "client_secret is missing"** — Google requires `client_secret` even for PKCE public clients (unlike Microsoft); added Thunderbird's public Google client secret as default
- **OAuth2 sign-in endless spinner** — entering wrong credentials during OAuth2 sign-in left the UI in a permanent loading state; added Cancel button to abort the OAuth2 flow
- **Test connection timeout** — `imap_test_connection` had no timeout; wrapped in 20-second `tokio::time::timeout`
- **OAuth2 token refresh race condition** — concurrent callers could bypass the deduplication guard; moved guard registration before any async operation
- **Missing token refresh at IMAP entry points** — `markEmailReadStatus`, `performSearch`, and `setActiveAccount` didn't call `ensureFreshToken`, causing expired-token failures for OAuth2 accounts
- **Server-side search broken for OAuth2** — `performSearch` only checked `account.password`; now uses `hasValidCredentials()` which accepts both password and OAuth2 tokens
- **Mailbox folders unsorted** — folders appeared in arbitrary server order; now sorted alphabetically with INBOX pinned first
- **"Invalid from address" on send** — special characters in display name broke `format!()` address parsing; now uses `lettre::Mailbox::new()` for proper RFC 5322 formatting
- **Namespace error on account switch** — old mailbox path (e.g. `[Google Mail]/Spam`) carried across accounts; fixed with per-account mailbox memory
- **Cloud icon doubling on Retina** — CSS `opacity-50` on Lucide SVG caused double-compositing; replaced with `rgba()` inline color
- **Badge count log spam** — `set_badge_count` logged on every call; added deduplication and downgraded to debug level

## [1.5.0] - 2026-02-19

### Performance
- **Delta-sync on folder/account switch** — switching mailbox or account now checks IMAP UIDVALIDITY + UIDNEXT before fetching; if nothing changed, the cached email list is kept as-is with zero IMAP fetches; when emails were added or deleted, only the diff is fetched via `UID SEARCH ALL` + `UID FETCH` for new UIDs, instead of re-downloading the entire first page
- **Lazy email parsing** — opening an email now only parses text/HTML body and attachment metadata; attachment binaries and raw source are no longer loaded upfront, reducing parse time from ~60ms to ~8ms for a 5 MB email
- **On-demand attachment loading** — attachment content is fetched from the .eml file only when the user clicks download, eliminating wasted memory for unviewed attachments
- **On-demand raw source** — "View Source" now loads the full email source lazily instead of including it with every email open
- **Optimized email list rendering** — `EmailRow` wrapped in `React.memo` with stable selectors, eliminating thousands of unnecessary re-renders per store mutation at scale (10k+ emails)
- **Light IMAP fetch** — new `imap_get_email_light` command returns only body text and attachment metadata from the server, auto-persisting the full .eml to Maildir for later on-demand access
- **Light Maildir reads** — `getLocalEmails()` and email selection now use `maildir_read_light` which skips base64-encoding attachment binaries and raw source
- **Light background caching** — content caching pipeline now uses `fetchEmailLight` (Rust auto-persists .eml) instead of fetching full email + JS-side save, reducing memory and bandwidth per cached email

### Fixed
- **Garbled sender/subject in email list** — non-ASCII names and subjects (e.g. `=?windows-1257?Q?Ona_...?=`) appeared as raw RFC 2047 encoded text in the email list; IMAP envelope values are now decoded through `mailparse` before display
- **Attachment indicators missing from email list** — IMAP header fetches never detected attachments because `BODYSTRUCTURE` wasn't requested; now included in the FETCH command so `hasAttachments` is set correctly at the header level without needing to open the email
- **Attachment section not showing in email viewer** — `hasAttachments` updates only wrote to the `emails` array but not to `emailsByIndex` (the Map used by the virtual-scroll list); now both are updated in sync when selecting an email or background-caching completes
- **IMAP namespace error** — servers requiring mailbox prefix (e.g., `INBOX.Sent` instead of `Sent`) would fail with "nonexistent namespace" when the app fell back to hardcoded mailbox paths; now caches server-returned mailbox paths and falls back to INBOX-only when no cache exists
- **Black screen crash** — app going to a black screen after extended use due to WKWebView memory exhaustion; stripped heavy fields (rawSource, attachment content) from in-memory cache, reduced default cache limit from 5GB to 512MB, and eliminated wasteful Map copies on every cache read/write
- Iframe event listeners (click, contextmenu) leaked on every email selection — now properly cleaned up when switching emails
- Rust panic hook installed — panics are now logged to stderr/system log before process abort, aiding crash diagnosis
- Update checker blocked a Tokio worker thread with `std::thread::sleep` — replaced with async `tokio::time::sleep`
- Email archive from cache could fail when rawSource was not available — now falls through to a fresh IMAP fetch
- Bulk archive ("Archive Selected") now correctly sets the `archived` flag — previously only set `seen`, so bulk-archived emails didn't appear in Local view
- Failproof email loading — emails that fail to load are now retried with unlimited exponential backoff (3s → 9s → 18s → 36s… capped at 120s) instead of being silently skipped
- OAuth2 accounts (Microsoft 365) silently failed to load email content — background caching and header loading both checked only for password, now correctly accept OAuth2 access tokens
- All network activity pauses automatically when app goes offline and resumes on reconnect (both header loading and content caching pipelines)
- Per-message error handling on the server — one malformed email no longer kills the entire page fetch; failed messages are skipped with a warning and the rest load normally
- IMAP connection retry now covers more transient error types (BYE, closed, SERVERBUG, EPIPE, EAI_AGAIN) in addition to timeouts and resets
- Priority IMAP connections (used for single email fetch) now properly cleaned up on error/close, preventing stale connection buildup
- Guard against stale state updates when user switches mailbox while background loading is in progress
- Mailbox mutation detection — if another client adds or deletes emails mid-pagination, sequence numbers shift and MailVault now detects the total change and restarts pagination instead of loading duplicates or gaps
- Stale UID cleanup on refresh — cached emails deleted on another client are removed from the local list when the server no longer returns them in the overlap window
- Server returns skipped UIDs to client for retry instead of silently dropping them; client re-requests the affected page/range after 5 seconds
- Server graceful shutdown now cleans up both priority and background IMAP connection pools (previously leaked priority connections)
- Drag-and-drop account reordering in sidebar and settings had no visible effect — components weren't subscribed to the `accountOrder` state, so reorders were persisted but never reflected in the UI

### Added
- **Native Rust IMAP/SMTP** — replaced Node.js sidecar server with native `async-imap` and `lettre` crates; all email operations now run directly in the Tauri process via `invoke()` commands (no more HTTP to localhost:3001)
- **IMAP connection pooling** — two-pool design (background + priority) with NOOP health checks and automatic reconnection on stale sessions
- **Native OAuth2 PKCE flow** — Microsoft OAuth2 moved from Node.js to Rust with PKCE code challenge, local TCP callback server on port 19876, and automatic token refresh
- **UID EXPUNGE support** — permanent email deletion now uses RFC 4315 UID EXPUNGE to only remove the targeted message, not all deleted messages in the mailbox
- Background loading pipeline architecture — dedicated `AccountPipeline` class manages per-account header loading and content caching with configurable concurrency
- Multi-account background sync — after the active account finishes loading, all other accounts' INBOX headers are fetched and cached automatically
- Parallel content caching — active account downloads 3 email bodies concurrently (up from 1); background accounts use 1 concurrent worker
- Cross-account cascade — after active account content is fully cached, background accounts also get their email bodies cached sequentially
- Shared credential helper (`authUtils.js`) — single source of truth for password/OAuth2 credential validation
- Bulk archive runs on Rust async thread pool — 3 concurrent email fetches via IMAP pool, with progress events and cancellation support; no longer blocks the JS event loop
- Cancel button on bulk archive progress toast — stops in-flight archive operation

### Changed
- Disabled browser's native "Open Frame in New Window" right-click option on email content iframe
- Replaced monolithic `useBackgroundCaching` hook with clean pipeline architecture: `AccountPipeline` (per-account worker), `EmailPipelineManager` (singleton coordinator), `usePipelineCoordinator` (React bridge)
- Removed Node.js sidecar server — no more bundled binary, sidecar spawning, health check polling, or HTTP-based API calls; reduces app size and startup time

## [1.4.11] - 2026-02-19

### Fixed
- Sidecar server port conflict after app update — old sidecar process stayed alive on port 3001, blocking new instance; new sidecar now sends a shutdown request (`POST /api/shutdown`) to the old instance before retrying, enabling graceful handoff without shell commands (blocked in sandbox)

## [1.4.10] - 2026-02-19

### Fixed
- API calls now routed through Tauri HTTP plugin instead of WKWebView's native fetch — App Sandbox blocks WebView from making HTTP requests to `localhost` sidecar; the plugin routes requests through Rust's networking stack, bypassing the restriction
- Fixed duplicate `http:default` capability identifier that could cause permission conflicts

### Added
- Comprehensive diagnostic logging throughout the connection flow: API module startup, HTTP plugin loading, health check polling, request lifecycle, and IMAP test-connection steps — enables pinpointing exactly where failures occur in sandbox environments

## [1.4.9] - 2026-02-19

### Fixed
- "SecurityError: the operation is insecure" crash caused by Web Worker — WKWebView blocks `blob:` URL workers under the `tauri://` origin; replaced Web Worker with main-thread queue processor (no functionality lost, all I/O was already on the main thread)
- Infinite spinner when adding an account — sidecar server crashed silently on `EADDRINUSE` (port 3001 occupied by previous instance) and the frontend waited forever; sidecar now retries port binding up to 5 times before exiting cleanly so the crash is detected and reported
- Frontend API requests now have a 30-second timeout (AbortController) to prevent infinite hangs
- Health check polling now throws and resets on failure, allowing retry on subsequent API calls instead of caching the failed state forever
- IMAP test-connection timeout reduced from 30s to 15s for faster settings detection feedback

## [1.4.8] - 2026-02-19

### Fixed
- "SecurityError: The operation is insecure" crash — completely replaced localStorage with Tauri filesystem-backed storage; WKWebView in App Sandbox blocks all web storage APIs, now settings persist via JSON file on disk instead
- Black screen on first launch — Framer Motion animations starting at opacity 0 could stay invisible if animation engine failed in WKWebView
- Added React error boundary with visible fallback UI and stack trace for rendering crashes
- Splash screen now only dismisses after React successfully renders (not before)
- Added 10-second timeout fallback if app fails to load — shows reload button instead of blank screen

### Added
- Blog section on website with post about the v1.4.x signing saga

### Changed
- Updated README icon descriptions to match current UI

## [1.4.5] - 2026-02-18

### Fixed
- Sidecar crashing in sandboxed release builds — sidecar now signed with dedicated entitlements (no sandbox, JIT allowed) while main app keeps App Sandbox; signing order corrected (sidecar first, no `--deep`)

## [1.4.4] - 2026-02-18

### Fixed
- Sidecar server crashing on launch in release builds — App Sandbox blocked Bun's JIT compiler; sidecar now signed with dedicated entitlements (no sandbox, JIT allowed)
- Removed `--deep` codesigning flag that was overwriting sidecar entitlements
- Replaced shell-based process cleanup (lsof, kill) with Tauri CommandChild handle

## [1.4.3] - 2026-02-18

### Fixed
- Sidecar server not starting in sandboxed builds — removed shell commands (lsof, kill) blocked by App Sandbox, replaced with Tauri CommandChild handle for clean process management

## [1.4.2] - 2026-02-18

### Fixed
- Sidecar server unable to start in sandboxed release builds — added missing `network.server` entitlement so the backend can listen on localhost

## [1.4.1] - 2026-02-18

### Fixed
- "Server unreachable (/test-connection): Load failed" when auto-detecting server settings — raw fetch bypassed the API base URL in Tauri builds

## [1.4.0] - 2026-02-18

### Fixed
- Server unreachable error in release builds — sidecar now explicitly binds to 127.0.0.1 to prevent IPv4/IPv6 mismatch

## [1.3.0] - 2026-02-18

### Added
- Settings menu item in macOS app menu (Cmd+,) for quick access to Settings
- Escape key closes Settings page
- Copy button in logs section — copies logs to clipboard with "Copied!" feedback
- Inline confirmation modal for account removal — replaces browser confirm() dialog

## [1.2.0] - 2026-02-18

### Added
- Microsoft 365 OAuth2 (XOAUTH2) support — sign in with Microsoft for Outlook/Hotmail/Live/M365 accounts
- "Sign in with Microsoft" button in account setup for Outlook provider (uses PKCE authorization code flow)
- OAuth2 token auto-refresh — access tokens refresh automatically when expired
- OAuth2 account status in Settings — shows "Connected" / "Token expired" badges, with Reconnect button
- OAuth2 callback server on `localhost:19876` — temporary server for receiving Microsoft auth redirects
- `server/oauth2Config.js` — Microsoft OAuth2 endpoints and credential configuration
- `updateOAuth2Tokens()` helper in `db.js` for updating tokens after refresh
- OAuth2 API functions in `api.js` — `getOAuth2AuthUrl`, `exchangeOAuth2Code`, `refreshOAuth2Token`
- App Password fallback — users can still choose password auth for Outlook accounts

### Fixed
- Settings page blank screen — missing `AnimatePresence` import from framer-motion
- Notifications now show app icon — replaced AppleScript `osascript` with `tauri-plugin-notification`
- Email content now renders with original formatting preserved — removed aggressive dark mode CSS overrides that broke email layouts, centering, and styled elements; emails now display on a light background (like Apple Mail) regardless of app theme
- IPv6 connection hangs with Outlook — forced IPv4 on all IMAP/SMTP connections
- Multiple sidecar server processes — added orphan cleanup on startup and kill on quit

### Changed
- IMAP/SMTP auth now supports `accessToken` (XOAUTH2) in addition to password auth
- Outlook provider renamed to "Outlook / Microsoft 365" with OAuth2 as recommended auth method
- Account setup for Outlook defaults to OAuth2, with "Use App Password instead" fallback link
- Settings Authentication section shows auth type badge (Password vs Microsoft OAuth2)
- OAuth2 now uses Mozilla Thunderbird's public client ID by default (no Azure app registration needed)
- Specific error message for Microsoft Outlook IMAP regression with link to FAQ
- "Sign in with Microsoft" button requires email before clicking and uses purple accent styling

## [1.1.0] - 2026-02-16

### Changed
- Emails now stored as standard .eml files (RFC 5322) in Maildir format
- Opening an email automatically caches it locally (download once, read forever)
- "Save locally" now archives emails with a Maildir flag
- Local view shows only explicitly archived emails
- Email file operations moved to Rust for better performance
- Extracted keychain parsing utilities to `src/services/keychainUtils.js` for testability
- Backup format changed from JSON blob to ZIP archive of .eml files for better performance and portability
- ZIP structure uses email addresses (not UUIDs) so backups are portable across installations
- Export/import now uses Rust for file operations (faster, handles large mailboxes)
- Export dialog lets you choose between "All Emails" or "Archived Only"
- Import automatically creates new accounts for unrecognized email addresses (user re-enters password in Settings)

### Added
- Maildir filename flags (Seen, Flagged, Replied, Archived)
- Raw email source always available for cached emails
- Automatic migration of existing saved emails to .eml format
- Unit tests for legacy keychain migration (`parseKeychainValue`, `getAccountsFromKeychain`, cleanup logic)
- GitHub Actions CI workflow — runs tests on push/PR to main
- "Open in New Window" — pop-out button in toolbar + custom right-click menu in email iframes, uses `WebviewWindowBuilder` to open a native Tauri window
- Email popup windows close normally (only main window hides to tray)
- `export_backup` and `import_backup` Tauri commands (Rust) for ZIP-based backup
- `src/services/backupUtils.js` with testable pure utility functions
- Unit tests for backup utilities (buildBackupEmailPath, matchAccountsByEmail, parseBackupManifest)
- Extracted `computeDisplayEmails` utility (`src/services/emailListUtils.js`) for testability
- Unit tests for display email computation — covers all view modes, local-only flag logic, edge cases (18 tests)
- Unit tests for state transitions — archive→delete→local-only flow, cache restoration, quick-load state (13 tests)
- Integration test for local-only flag detection — real IMAP flow: send → archive → delete from server → verify flag (4 tests)
- CI workflow now writes `.env.test` from GitHub secrets for integration tests
- `initBasic()` in db.js — lightweight init that skips keychain, used by quick-load

### Removed
- Session Cache settings from Settings page — redundant now that Maildir auto-caches every opened email to disk; in-memory cache still works silently with default limit

### Fixed
- Dark mode email text readability — force light text via inline `!important` on all elements (EmailViewer + ChatBubbleView)
- Logs no longer clear before confirmation — replaced `confirm()` with Tauri dialog `ask()` for proper async blocking
- Dynamic version display from package.json
- Export/import backup compatibility with new storage format
- Backup export now works in Tauri WebView (replaced broken blob download with native save dialog + Rust ZIP writer)
- Backup import now correctly restores all emails (previously silently skipped every email due to missing accountId/mailbox fields)
- "Open in New Window" now works on macOS — popup loads HTML from a temp file instead of eval on about:blank (WKWebView ignores eval before page ready)
- Email list no longer shows empty placeholder cells when scrolling — virtual scroll row count now matches loaded emails instead of server-reported total
- Email list no longer shows overlapping rows after switching accounts — email state fully cleared on account switch + virtual scroll container keyed by account ID
- Email list no longer shows overlapping rows after switching view modes — scroll position resets on view mode change + virtual scroll container keyed by view mode
- Delete confirmation no longer hides the email content view — replaced native `confirm()` dialogs with inline React modals in EmailViewer and EmailRow
- "Local only (deleted from server)" indicator now clearly visible — changed from tiny corner dot to amber-colored HardDrive icon; fixed local view mode to check server UIDs
- After deleting from server, email immediately shows as local-only — `emails` array updated synchronously before background refresh; cached headers on disk also updated to prevent `loadEmails` from restoring the deleted email
- Local-only flag now only appears for explicitly archived emails, not auto-cached ones
- Local view mode now correctly filters to show only archived emails (not all cached emails)
- No more black screen on app launch — quick-load uses `initBasic()` which skips keychain; shows cached emails + branded loading while keychain password prompt is active
