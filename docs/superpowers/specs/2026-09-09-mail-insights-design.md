# Mail Insights design

Status: the user approved creating an implementation plan from the Insights concept on 9 September 2026 and required TDD and end-to-end validation on the Mac mini. This document records that design; implementation is a separate step.

## Outcome and placement

Add **Insights** to the sidebar immediately below All Inboxes, with a labeled icon in the collapsed rail and an entry outside the account picker in every sidebar layout. It opens across the main workspace and contains **Sender map**, **Timeline**, and **Activity** tabs. It is distinct from the existing List/Explorer mailbox views.

The existing inbox remains the default launch destination. Opening Insights preserves the mailbox, Explorer path, search, selection, list position, and reader state for return. Ordinary mail shortcuts are suspended while Insights owns the workspace; compose and Settings still work. No marketing or billing changes are required; this is a local mail-viewing feature available without Premium.

The approved interactive concept is conversation-owned, uses synthetic data, and is visual guidance rather than production source:

`/Users/Rokas/.codex/visualizations/2026/09/09/01a08694-3e39-73f3-811a-3b8501fa0f80/mail-insights.html`

## Shared scope

- Initial scope: all configured accounts, all available folders except Trash, Junk, Drafts, and unsent outbox items; include Archive, user folders, and the active vault. Cold external backups are outside this view.
- Date range: last 12 calendar months through today, inclusive. Presets: 30 days, 90 days, 12 months, and Custom. Custom dates are inclusive local calendar dates; reject an end before the start.
- Direction: Received initially; also Sent and Both. Keep the same direction when changing tabs. Activity always shows separate sent and received totals beside the selected measure.
- Optional sender selection persists between tabs. Clear it explicitly with All senders. Searching a sender only narrows the visible sender choices; it must not silently change activity totals until a sender is selected.
- Include every sender initially. The switch is **Hide likely automated senders**; evidence is List-Id, List-Unsubscribe, Precedence bulk/list, or an exact no-reply/noreply/do-not-reply mailbox pattern. Unknown senders stay visible. Classification is local, deterministic, and inspectable in sender details.
- Persist tab, account scope, range preset/custom dates, direction, and automated-mail preference. Sender selection, day selection, zoom, progress, errors, and mail headers are session state. Normalize invalid/deleted account preferences.

## Sender map

The user is the center node. Each other node is a normalized email address, with a display name as its label. Equal display names never merge different addresses. Configured account addresses and explicit send-as addresses represent the user; do not guess that plus-addresses or different domains are aliases.

- Bubble **area**, not diameter, is proportional to message count in the selected scope and direction. Use `radius = scale * sqrt(count)`; use a larger invisible pointer target when a circle is small, rather than falsifying the radius.
- Center-to-center distance increases monotonically with elapsed time since the latest selected-direction message. Measure relative to the selected range end; label historical ranges accordingly. Date/range changes cannot make an old message look recent relative to today without saying so.
- Use subtle labeled recency rings and a compressed monotonic radial scale. Stable address-based angles, deterministic angular collision resolution, and a world-space canvas preserve meaning. Do not change the radial value to resolve overlaps. Expand/pan the canvas or reduce displayed nodes when needed.
- Show the top 30 addresses by count, ties by latest event then address. Sender search can locate and bring an address outside the top 30 into focus. Show the number of omitted senders; do not invent a combined Other sender bubble.
- Keep the layout still at rest. No drifting simulation or looping motion. Respect reduced motion during filter transitions.
- Selecting a sender shows received/sent counts, exact last contact date, address, automation evidence when present, and actions to view its timeline or matching mail.
- Provide an equivalent sortable sender list for keyboard/screen-reader use and narrow layouts. Bubble nodes are real buttons with names/counts/dates in their accessible names.

## Timeline

One row per sender/correspondent on a shared horizontal time axis, initially newest interaction first. Received events use receive time. Sent events use send time and group by external recipient. Both shows received circles and sent diamonds, paired with a legend and accessible text.

Wide date ranges aggregate events into weeks; zoom to days and then individual messages. Use a single intensity/count scale across lanes. Sort by latest interaction or volume. Virtualize sender rows and bound visible event marks. Selecting a mark or bucket opens the matching message list; a bucket states its exact date bounds and count. Preserve the selected sender when opening Activity or returning to the map.

## Activity calendar

Use a GitHub-style seven-row grid: Monday through Sunday, weeks across, month labels, a Less–More legend, and one real local calendar date per square. Stronger indigo means more activity. Keep zero activity distinct from dates outside the range and from unavailable coverage.

Received and Sent each count one event per logical message in that direction. Both is their sum and is labeled **email activity** where necessary: a self-addressed email can contribute one sent event and one received event. Recipient counts do not multiply the calendar's sent total.

Hover/focus shows date and both counts. Selecting a day shows matching messages and allows opening one in the existing reader. Native keyboard navigation moves by day/week; Home/End move within a week. The selected date remains stable when filters change unless it leaves the range. Narrow layouts show contiguous quarter-sized blocks with month/year labels, without duplicating days.

## Data truth

Read the complete locally available header inventory for selected accounts, not `useMailStore.emails`, `sortedEmails`, `getAccountCacheEmails()`, or the compose contacts index. Those are windowed or intentionally capped and cannot supply accurate analytics.

Native Rust resolves the configured vault through `vault::root()`, inventories the Tauri header sidecars and local indexes, and reads header-only fallbacks from `.eml` files when needed. It must use the Tauri storage format and provenance helpers; the daemon/core Maildir formats are not interchangeable. No message bodies or attachments are loaded for charts, and no new database, telemetry, remote analysis, or background mail download is introduced.

Return a bounded, cancellable/paged snapshot with explicit coverage:

- last update time and per-folder cached/known-server counts;
- missing/unreadable folders and parse failures;
- stale snapshot or disconnected vault;
- unknown/fallback dates and uncertain identity counts.

Always say **Based on mail available on this device**. A finished local scan means the local inventory was read; it does not prove that all server history was synchronized. For a known 700-message folder with 200 cached headers, show the incomplete coverage. Unknown server totals remain unknown, never zero. Refresh rereads local inventory; it does not silently download mail or change the active account/folder.

The snapshot freezes the file paths discovered during enumeration. Files arriving afterward belong to the next refresh, so ordinary background downloads do not continually invalidate an in-progress scan. Changes to captured files, mailbox metadata, indexes, UID generations, directory identity, or vault/account context still invalidate it. This refinement was prompted by native acceptance: appending new Maildir files changed directory timestamps even though every captured message remained unchanged.

Opening a view is read-only. Reading an actual selected email retains the app's existing mark-as-read behavior. A chart click must not delete, move, archive, bulk-select, or send mail.

### Identity and counts

1. Preserve every physical locator: account ID, real mailbox path, UID, UIDVALIDITY when known, origin, and Message-ID. A UID alone is never an identity.
2. Deduplicate exact server/vault representations of one message. For cross-folder/account copies, require a nonempty Message-ID plus compatible sender, original message date, and subject. Conflicting values keep separate records. Missing IDs use physical provenance; do not merge unrelated messages by subject or timestamp.
3. UID reuse with a conflicting Message-ID keeps the older vault message and newer server message distinct. Preserve both locators and custody facts; never make a storage claim from chart state.
4. Within a selected scope, count each logical message at most once per direction. A message to three external recipients contributes one sent total and one interaction to each of those correspondents. Consequently, summing sender counts is not an activity-total calculation.
5. Use explicit Sent special-use/override, local sent provenance, and the existing configured identity helpers. Exclude drafts and queued/failed outgoing mail. Self-mail contributes to global direction totals but creates no You-to-You bubble.
6. Dates never come from file modification time. Receive time uses IMAP INTERNALDATE / Graph receivedDateTime; original RFC Date is a labeled fallback. Send time uses Graph sentDateTime / RFC Date; an available receive timestamp is only a labeled fallback. Invalid/missing dates remain in an Unknown date list, excluded from dated cells and recency placement with an explicit count. Equal instants in different offsets produce the same local date. Preserve the existing legacy `date` field semantics elsewhere in the app.

## Appearance and interaction constraints

Use existing `--mail-*` tokens, Instrument Sans/system typography, Lucide icons, shared controls, 14px body/12px labels, restrained borders, and the app's light/dark and Indigo/Graphite palettes. Charts use an explicit theme-aware indigo intensity ramp; vault/server/gold custody colors keep their existing meanings. Add every new string to English, German, Spanish, French, Italian, Portuguese (Brazil), Japanese, Korean, and Simplified Chinese, preserving interpolation and plural categories. English fallback remains a runtime safety net, not a replacement for the repository's catalog parity requirement. No new dependencies unless an evidenced blocker is brought back to the user.

The surface fills the workspace at normal desktop sizes. It remains usable at a 720px app width and at 320px available panel width with the sender-list and stacked-calendar alternatives. Toolbars wrap; the main app cannot overflow horizontally. Keep focus visible, announce completed selections/progress without every-frame chatter, restore focus after drill-down, and show useful loading/empty/partial/offline/error states.

## Verification and delivery

All test suites run on the Mac mini through the controller's `/Users/Rokas/.claude/bin/testq`. All native runs use the shared `macmini-e2e` lane. Use an isolated runner and temporary app data, the real compiled Tauri app, and the existing mock IMAP/SMTP harness. No real user mailbox is a fixture.

Each behavioral change follows observed RED → minimal GREEN → refactor → GREEN. Completion requires focused domain/native tests, the full frontend suite, relevant storage/provider tests, both CI-safe native suites, inspected screenshots, and a source checksum manifest matching the tested revision. Failed, skipped, driver-limited, and unrun checks remain explicit in the verification report. Screenshot generation alone is not visual approval and test retry success does not erase the first failure.
