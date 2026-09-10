# Explorer, Insights, and row-star verification — 10 September 2026

## Changes

- Explorer hides Back at the root. Pointer navigation does not transfer keyboard focus to Back; keyboard navigation retains focus, including return to the root breadcrumb.
- Insights uses the same icon slot and row spacing as neighboring sidebar entries in comfortable and compact density. Account and All Inboxes selection styling is suppressed while Insights owns the workspace.
- Insights offers individual accounts only. Persisted multiple-account selections are reduced to one valid account, and removal of that account falls back to a remaining account.
- Sender-map bubbles show sender identity, received/sent counts, and latest activity immediately on pointer hover or keyboard focus. The overlay prefers above-pointer placement, measures its bounds, and dismisses on Escape, pointer exit, scroll, filtering, and resizing.
- Unmarked row stars remain visible beside tracker, sender/reply/link warning, or attachment indicators. Plain rows retain hover/focus disclosure. Both row layouts use the same control.

GPT-5.6 Luna at medium effort implemented the changes. GPT-6 Astra reviewed them independently; the findings were corrected and its final static review found no blocking issue.

## Completed checks

- Original production code with the final regression tests, in a disposable local copy: **11 failures and 84 passes**. The failures reproduced root Back visibility, pointer/keyboard focus, sidebar selection, multiple-account preferences, the All accounts option, absent immediate tooltip, and star visibility. Log: `/tmp/mv-ui-fixes-baseline-local-red-final.log`.
- Final frontend suite: **3,478 tests passed in 299 files**. Log: `/tmp/mv-ui-fixes-full-unit-local-final.log`.
- Production web build: **passed**. The generated CSS includes the final compact Insights spacing. Log: `/tmp/mv-ui-fixes-build-local.log`.
- Impeccable source detector: **passed, no findings**. Output: `/tmp/mv-ui-fixes-design-audit.json`.
- Changed native test files parse successfully; `git diff --check` passes.

Earlier validation attempts exposed test-only setup errors (an incorrect accessible label, missing import/matcher, and the temporary baseline's dependency read allowance). These were corrected before the accepted baseline and final runs above. The first remote run is not evidence for the final source.

## Mac mini validation

The user approved testing on the Mac mini and committing/merging after success. All runs used the shared `macmini-e2e` queue and the dedicated runner `/Users/unicorn/Repos/mv-insights-20260909-01a08694`, with isolated mock mail accounts and a temporary test home. The source-copy manifest matched 2,963 files, and native runs confirmed the built app matches the current compiled source.

- Native application, daemon, and frontend build: **passed**. Log: `/tmp/mv-ui-fixes-mini-build.log`.
- Full frontend suite on the Mac mini: **3,478 tests passed in 299 files**. Log: `/tmp/mv-ui-fixes-mini-unit.log`.
- Final combined native Insights run: **23 passed in 2 files** (12 data/integration, 11 UI). Log: `/tmp/mv-ui-fixes-mini-insights-final.log`.
- Native Explorer and tracker/star regressions: **21 passed in 2 files** (11 Explorer, 10 tracker). Log: `/tmp/mv-ui-fixes-mini-mail-e2e.log`.
- **44 native end-to-end tests passed overall.** They cover root/pointer/keyboard navigation, sidebar selection/alignment, single-account scopes, immediate tooltip placement and Escape, and star visibility beside a real tracker glyph in both actual row renderers.

The first native UI run exposed one test assertion that incorrectly counted a selected folder as an account; the assertion now checks account destinations and Insights, with a separate All Inboxes selection check. Two runs also encountered transient native windows reported offscreen by CoreGraphics. Their cause was not established; no product fix or automatic window recovery is claimed. Capture checks now log/assert native visibility and minimized state while retaining the stricter real onscreen-window capture requirement. The subsequent 11-test UI run and final combined 23-test run both passed with valid screenshots. Logs for the unsuccessful and diagnostic runs: `/tmp/mv-ui-fixes-mini-insights-e2e.log`, `/tmp/mv-ui-fixes-mini-ui-rerun.log`, `/tmp/mv-ui-fixes-mini-ui-diagnose.log`.

Visual review inspected native captures of the immediate sender popup, aligned expanded navigation, collapsed navigation, narrow annual activity, German labels, and the light theme. The sender popup displays identity, counts and latest activity beside/above the pointer without clipping. Individual account destinations remain neutral while Insights is selected. Captures were downloaded to `/tmp/mv-ui-fixes-shots`; the successful UI capture set remains in the runner test home `/var/folders/41/81s58b051lqfyh9jr960ndk00000gn/T/mailvault-e2e-aMPAcj`.

The WebDriver harness synthesizes pointer/key events and does not reliably produce trusted OS hover or default keyboard button activation. Tests distinguish handler/rendered-state checks from physical native input. The star regression asserts the shipped renderer and ungated visible star style; the immediate tooltip check measures actual native-WebView DOM rendering within 100 ms.

Astra's final review found no blocking issue. Integration will preserve the exact tested source tree using a fast-forward merge to local main.
