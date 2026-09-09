# Mail Insights verification — 9 September 2026

Status: implementation and required verification complete. Local main integration is recorded in git history; no push or release is included.

## Delivered scope

The sidebar Insights workspace contains a sender map, sender/date timeline, and daily activity calendar. Bubble area follows communication count and distance from You follows recency. Shared account, date, direction, and automated-sender filters control all three views. Sender and day selections open matching real mail in the existing reader.

Counts describe locally available cached and vaulted headers, not complete server history. Native pagination, a worker-owned model, strict copy identity, explicit date evidence, and partial coverage reporting avoid equating the currently visible mailbox page with all mail. Unknown dates and fallback date evidence are disclosed. Entering charts does not fetch message bodies or change mail state. Reading a selected message retains existing read behavior and verified storage provenance.

## Environment

- Implementation branch: `codex/mail-insights`, isolated worktree `.worktrees/mail-insights`, based on local main `427aecf1`.
- Mac mini: `M4s-Mac-mini.local`, arm64, macOS 26.6.2. Dedicated runner: `/Users/unicorn/Repos/mv-insights-20260909-01a08694`.
- Every test runs on the Mac mini through `scripts/testing/insights/check.sh` and the shared `macmini-e2e` queue. Source files are frozen, hashed, synced, and verified before execution. Native runs verify compiled-source parity against the successful build manifest.
- Native scenarios use isolated mock accounts and disposable real cache/vault files. The existing screen-lock check remains enabled.
- The user's final model preference is honored: GPT 5.6 Luna implements the final fixes; Astra independently reviews them. Root owns test launches and integration.

## Test evidence

| Check | Verified result | Controller log in `/private/tmp` |
| --- | --- | --- |
| Final full frontend, including staged transfer | 299 files, 3,466 tests passed | `mv-insights-full-unit-7.log` |
| Staged worker/session regression | 28 passed | `mv-insights-worker-batch-green.log` |
| Core and daemon suites | 329 passed, no ignored tests | `mv-insights-core-daemon-full.log` |
| Final native inventory | 21 passed, no ignored tests | `mv-insights-native-cutoff-green.log` |
| Final ordinary native UI regression | 7 files, 55 tests passed, 3 existing skips | `mv-insights-ui-regression-2.log` |
| Ordinary connected-mail regression | 88 files, 540 tests passed, 4 existing skips | `mv-insights-connected-regression-1.log` |
| Final dedicated native acceptance | 21 passed: 12 data scenarios, 9 UI scenarios | `mv-insights-native-final-24.log` |
| Native app build | Passed, compiled-source guard verified | `mv-insights-build-13.log` |
| Final 50,000-header acceptance | 3 passed; 23ms maximum visible frame gap, 12ms committed filter | `mv-insights-native-50k-3.log` |

All checks above passed. The final worker/session change was followed by the complete frontend suite, rebuild, all 21 dedicated native scenarios, and all three 50,000-header cases. The earlier ordinary native regression, core/daemon, and native inventory results cover unchanged paths; those suites were not repeated solely for the isolated worker transfer correction.

## Test-first corrections and review findings

- Navigation and reader ownership: 5 behavioral failures, then 43 passes (`mv-insights-navigation-{red,green}.log`). Pending ordinary-reader restoration was also guarded by selection ownership; the initial three failures and superseding-selection failure are recorded in `mv-insights-restore-race-red.log` and `mv-insights-restore-owner-red.log`.
- Snapshot retry: 5 failures, then 34 passes (`mv-insights-retry-{red,green}.log`). Retry is bounded to four complete scans at 250/500/1000ms backoff, with interrupted rows discarded and snapshots released.
- Real native observation: 2 failures, then 17 passes (`mv-insights-observer-{red,green}.log`). The initial attempt to replace Tauri's non-writable internal function produced invalid empty observations and is not accepted as evidence. The E2E-only observer now witnesses the real native Promise while preserving its value/error.
- Reader inner close, export identity, and default runner isolation: 6 failures and 5 passes before corrections, then 176 passes across 16 files (`mv-insights-reader-export-isolation-{red,green}.log`). The reader closes its owned detail and cancels delayed marking; exports reject conflicting identities even with a shared Message-ID; ordinary WDIO suites exclude only dedicated Insights fixtures.
- Snapshot cutoff: real native acceptance exposed background Maildir arrivals repeatedly invalidating directory timestamps. Two native failures preceded the correction, then all 21 passed (`mv-insights-native-cutoff-{red,green}.log`). Enumerated paths are frozen; later independent arrivals belong to a future scan. Captured file contents, metadata/index/generation files, directory replacement/removal, symlinks, and account/vault context remain strict. Retry limits were not increased and background download was not disabled.
- Calendar clipping: actual native screenshots showed a 53-week calendar clipping at a 720px window with 616px available chart width. Three failing width cases preceded actual-width quarter splitting (`mv-insights-calendar-clipping-red.log`). All 10 calendar cases then passed in `mv-insights-custody-red-calendar-green.log`; native acceptance now checks every date cell's right edge.
- Reader custody: an actual offline vault reader showed the correct local body but a stale server-only label. Three failing regressions preceded selected-record custody projection (`mv-insights-custody-red-calendar-green.log`). Active mailbox rows, UID archive sets, and server completeness no longer override an Insights record. Real absence proof remains distinct from unknown server status. A subsequent focused run passed 153 tests but exposed two test-fixture backup-state assumptions; the fixture now explicitly declares no backup drive rather than changing correct production wording (`mv-insights-custody-calendar-green.log`).
- Worker transfer: the measured 107ms single-message clone prompted staged transfers capped at 1,000 copies with an abort-aware macrotask between batches. The previous complete model stays published until a replacement commits. Twelve expected regression failures preceded implementation (`mv-insights-worker-batch-red.log`); the first implementation passed 26 of 28 tests, with two review-added error-code assertions still failing (`mv-insights-worker-batch-review-red.log`). The error-code correction then passed all 28 tests (`mv-insights-worker-batch-green.log`), followed by all 3,466 frontend tests. The rebuilt native app then passed all 21 acceptance scenarios and all three 50,000-header cases.
- Disconnected vault cleanup: the last native case's error-state assertions passed, then cleanup encountered an old path recreated by in-flight background downloads. Recovery now validates/adopts the intact disconnected vault and uses the existing move-to-default path. No source assertions were removed and no recreated directory is forcibly overwritten.

## Visual and performance evidence

Actual screenshots use `scripts/screenshots/capture.js` and CGWindow capture pinned to the dedicated app PID. Styles, font loading, geometry, and WebView visibility are recorded. WebDriver `saveScreenshot` serializes DOM without linked styles in this environment; those unstyled images are not accepted as visual evidence.

Screenshots were inspected for map, timeline, calendar, detail, offline/error states, themes, and narrow layouts. That review found the calendar clipping and custody-label issues above. Captures in `/private/tmp/mv-insights-native-final22-screens` were inspected by root and Astra: the corrected calendar has no horizontal clipping, the offline reader shows saved/unknown-server wording, and the complete map, themes, and German narrow labels are readable. The final build produced 19 fresh captures in `/private/tmp/mv-insights-native-final23-screens`. Root rechecked the map, narrow calendar, offline reader, and centered timeline; the timeline now visibly includes its date axis, sender lane, event marker, controls, and matching-message count.

The previous 700-header native run recorded a maximum visible rAF gap of 26ms and a filter probe of 1ms. The latter probe did not confirm committed filter results and is superseded: the final probe waits until the actual requested sender is the sole rendered map node. The first actual 50,000-header run inventoried 50,000 unique provider UIDs with pages bounded to 1,000, showed 917 visible frame callbacks, and measured a 123ms maximum frame gap. Committed sender filtering took 4ms; 49,888 matching messages retained at most 24 mounted rows. Inventory and filter/virtualization cases passed; initial-loading performance failed its unchanged 100ms limit. The follow-up profile reproduced a 119ms gap and located its cause: the single `postMessage` copying 50,209 headers took 107ms (timestamps 63,110–63,217ms), within the 63,099–63,218ms frame gap. All other recorded gaps were at most 32ms; query request posting took 0ms. Evidence: `mv-insights-native-50k-profile-1.log`. After the test-first bounded transfer correction, the final 50,000-header run passed all three cases: 933 visible frame callbacks, a maximum 23ms gap, transfers capped at 1,000 copies, a maximum approximately 2ms post duration, and a 12ms committed sender filter. All 50,209 physical header copies transferred; 49,888 matching messages remained bounded to at most 24 mounted rows. The original 100ms frame and 200ms filter limits stayed unchanged. Astra independently parsed and accepted the final runtime evidence. WebKit long-task entries remain unsupported.

The Impeccable mechanical source detector was rerun after the final visual changes over the changed UI files. It reported one `severity: advisory` item: the unchanged 10px draft-recipient text in App, already present on base main. No new Insights finding remains. The detector exits 2 for this existing item; this is not described as an exit-0 check. Evidence: `/private/tmp/mv-insights-design-audit-final2.json` and `.log`. Earlier new font/radius findings were corrected. This is static source analysis on the controller; all test suites execute on the Mac mini.

## Source parity and integration

The final native source and build manifests match all 831 compiled source/build-input files exactly. The complete 2,963-file source manifest also matched the implementation worktree at final native acceptance, with no unexplained differences. The SHA-256 of the sorted compiled path/hash map is `210a1890a1e8cbd5d0604c765bd39dd3401c7b6255c18eadd3beec9596c05386`. Controller evidence: `/private/tmp/mv-insights-final-compiled-manifest.json`, `mv-insights-remote-final-source-manifest.json`, and `mv-insights-remote-final-build-manifest.json`. The staged whitespace check removed one trailing blank line from `chartFormat.js` after the full frontend run. Rebuild 13 preserved all 152 frontend artifacts byte for byte, but changed the native binary checksum. Both the complete 21-case native suite and all three 50,000-header cases were therefore rerun successfully against build 13. The full frontend result covers the same behavior; the whitespace-only cleanup is the sole source difference since that run. Subsequent documentation edits do not alter the compiled-source digest.

Astra's final source and runtime reviews found no remaining blocker. The patch includes the three views, shared local-header model, strict reader identity, translations, test fixtures, runner isolation, and documentation. Integration is a local commit and merge to main; no version bump, signed package, release, or push is part of this work.

## Limits

- Native screenshots at 720px and 600px app widths provide approximately 616px and 496px chart content with the collapsed sidebar. They do not prove a 320px native content width. Narrow calendar component coverage is separate from native evidence.
- Native driver keyboard/focus checks exercise handlers; they are not a manual physical keyboard pass.
- WebKit does not expose long-task entries in the observed runs. Frame callback gaps and committed filter timings are reported separately, with visibility and any hidden-window timer fallback disclosed. They are not compositor-paint guarantees.
- Seven existing skips are retained: three in the UI suite, two driver-limited compose/Escape checks in connected features/search, and two connected performance cases requiring multiple accounts. No skipped assertion was removed or muted by this feature; unrun local-manual, signed DMG, release, and provider-live suites are not claimed passed.
- No release/version bump or push is requested. The local ignored `architecture.md` records the new boundaries. Final integration is a local commit and merge to main after required verification.
