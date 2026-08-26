# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Desktop application shipped as a Tauri shell around a React/Tailwind front end.
     macOS 11+ (Apple Silicon and Intel) and Linux (.deb, AppImage, Snap, Flatpak) today;
     Windows desktop is a planned target and must not be designed out.
     No iOS or Android product exists or is planned. -->

## Users

MailVault serves four confirmed audiences at once; no single one outranks the others, and work must not be narrowed to one of them.

- **The mailbox-full sufferer.** Hitting a Gmail / Microsoft 365 / shared-host quota and needing to clear the server without losing anything. This is the entry point the website leads with — it is the trigger, not the whole audience.
- **The ownership-minded archivist.** Wants every message on their own disk as a plain file, whether or not a quota is pressing. Privacy and self-reliance are the motive.
- **The freelancer or small business on domain mail.** Treats email as a business record that must survive years, provider changes, and machine changes, across several accounts.
- **The power emailer switching clients.** Wants a fast native client first; the vault is the reason to leave Apple Mail, Thunderbird, or webmail.

Situation is shared across all four: their mail lives on someone else's server, under someone else's retention rules, and they want it to stop being that way without giving up a real mail client.

## Product Purpose

A local-first email client with a vault behind it. The user reads, searches, threads, composes, and replies as in any client; every message they keep is written to their own disk as a standard RFC 5322 `.eml` file in a Maildir tree, readable by Thunderbird, Apple Mail, `grep`, or anything else they own. When the provider deletes it, expires it, or charges for storage, the local copy is unaffected.

Success is a user who can safely delete mail from a server — because a verified local copy exists and they can see, per message, exactly where each copy lives.

## Positioning

The uncopyable claim is the **combination**, not any single feature. A competitor can copy any one of these; the product loses its position the moment work dilutes the set:

1. **Keep it after the server drops it** — plain `.eml` in Maildir, no database, no lock-in, portable by construction (back it up, move it, mirror it, export MBOX).
2. **Delete from the server with confidence** — archive-then-delete in one operation, plus per-message state on the row (on the server / in the vault / both / local-only because the server no longer has it).
3. **A full client, not a backup utility** — threading, compose, search, chat view, multi-account unified inbox. The vault is behind a client people actually live in.
4. **Nothing in the middle** — no account to create, no sync service, no telemetry; credentials in the OS keychain, classification local.

Backup tools do not read mail. Mail clients do not let you empty a server safely. MailVault is the one product that is both, without a cloud in between.

## Operating Context

- Mail lives on IMAP (auto-detected via SRV, Mozilla autoconfig, MX fallback), Gmail and Microsoft 365 via OAuth2, and Outlook.com via Microsoft Graph.
- Users run several accounts at once, each with its own display name and colour, mergeable into a unified inbox; each account remembers the folder it was left in.
- The vault is a directory the user chooses and can relocate, back up, or point at an external drive (external is cold storage).
- Work happens in long sessions and in bulk: pick a year or a custom range and archive/delete thousands of messages with progress, cancel, and crash-safe recovery.
- A background helper keeps mail syncing with the window closed. macOS builds update through a signed Sparkle appcast; the App Store build is a separate channel.
- mailvaultapp.com is a first-class surface, not an afterthought: marketing, pricing, docs, guides, blog, FAQ, changelog, comparisons, and the download/billing flows are designed and maintained alongside the app.

## Capabilities and Constraints

**Confirmed capabilities:** OAuth2 sign-in (Google, Microsoft 365) and plain IMAP with server auto-detection; JWZ threading with quote and signature folding; chat view (sent and received merged as bubbles); search with sender/date/attachment/folder filters across all folders; compose with templates, contacts picker, attachments, drafts, send-as aliases, undo send (15s–5min) and a local outbox; bulk archive/delete/archive-and-delete with progress and recovery; per-message state icons; link-safety warnings with both URLs shown; SPF/DKIM/DMARC badges and impersonation warnings; MBOX export; local-to-server restore; guided server change.

**Premium capabilities** (scheduler- or server-shaped work only): scheduled automatic backups with health verification, cross-account migration, cleanup rules driven by a local Naive Bayes classifier, Time Capsule point-in-time snapshots, up to 5 devices.

**Pricing facts:** Free tier is $0 forever and includes the full client and unlimited manual backups. Yearly is $25/year (~$2/month) with a 14-day trial. Monthly is $4/month. Local data is never gated behind the paywall.

**Technical constraints:** Rust + Tauri (not Electron) — ~8 MB binary, ~80 MB idle, sub-second startup; React 18 + Zustand + Tailwind front end with `--mail-*` CSS custom properties and a `[data-theme]` light/dark switch; virtualized lists that must stay smooth past 17,000 messages; CONDSTORE delta sync and COMPRESS=DEFLATE; macOS sandbox (App Store) plus Developer ID/notarized channel; credentials only in macOS Keychain or Linux Secret Service.

**Terminology (use these words, not synonyms):** the vault, Time Capsule, chat view, unified inbox, outbox, per-message state, archive-then-delete.

**Open product decisions:** Windows desktop is planned but unscheduled and unspecified. There is no `LICENSE` file in the repository even though the pricing page says "Open source — inspect every line on GitHub"; the license terms are undecided and must not be stated as a fact until they are.

## Brand Commitments

- Name is **MailVault**, one word, capital V. Website is mailvaultapp.com. Made by **Graphic Meat** (graphicmeat.com).
- Product line: "Read your mail. Keep your mail."
- Voice is plain, concrete, and unhyped — it names mechanisms rather than benefits, and never oversells ("A local-first email client that files every message on your own disk as a plain `.eml`").
- Existing type: Instrument Sans for display, JetBrains Mono for mono.
- Existing app palette lives as `--mail-*` tokens (`accent`, `bg`, `surface`, `border`, `text`, `text-muted`, `danger`, `warning`, `success`, plus `server` and `local` for message state) with light and dark themes.
- Privacy is a commitment, not a feature: no telemetry, no account requirement, no third-party analytics, no email address displayed on the website.

## Evidence on Hand

- **Real product screenshots**, all captured from the running app against one scripted demo mailbox on a HiDPI Mac (`screenshots/`, `.github/images/`, `website/screenshots/`, generated via `wdio.screenshots.conf.js`). Use these; do not mock up fake UI.
- **Third-party mentions** (`website/mentioned-in.html`): a TaskBounty independent test-coverage measurement (July 2026) and a PeerPush indie-product directory listing (March 2026).
- **Changelog** (`CHANGELOG.md`, `website/changelog.html`) and a public GitHub repository.
- **Measured performance figures** in the README (binary size, idle memory, startup, list size) — real, and the only numbers that may be quoted.
- **Absences that must never be fabricated:** no revenue, sales, download, or user-count figures; no customer testimonials or named customers; no press quotes beyond the two mentions above; no awards, benchmarks, or ratings; no license terms.

## Product Principles

1. **The user's copy is the product.** Anything that makes the local files less standard, less portable, or less trustworthy is off the table, whatever it buys.
2. **Never let the user guess where a message lives.** Server, vault, both, or local-only must be visible before any destructive action.
3. **Destructive is fine; ambiguous is not.** Deleting from a server is a supported, encouraged operation — the design work is confidence, not friction.
4. **A real client first.** Everyday mail work (read, thread, search, reply) sets the quality bar; archiving features live inside that, never in place of it.
5. **Free stays whole.** The paywall covers automation, never the user's own data or the client they already rely on.

## Accessibility & Inclusion

No product-specific standard has been established. Existing surfaces already rely on light/dark theming via `[data-theme]`, `aria-label`s on icon-only controls, and `:focus-visible` styling; keyboard operation matters because the primary users work in long mail sessions. Reduced-motion handling is not currently implemented anywhere in the app.
