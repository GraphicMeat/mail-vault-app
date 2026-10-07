# Footage capture

Real motion footage of the real app, for the preview video. Everything here runs
on the Mac mini through `testq` + `minijob`; nothing runs on the laptop.

| Piece | What it does |
| --- | --- |
| `recorder.swift` | ScreenCaptureKit recorder for one window: constant frame rate, no cursor, `.mov` (HEVC or H.264). |
| `tools/framestats.swift` | Reads a clip back frame by frame: size, frame count, real fps, content changes, blank check, event alignment, PNG frames. |
| `tools/testwin.swift` | Calibration window that paints its own display time as a bar code (recorder clock proof). |
| `tools/probe.swift` | Display probe: logical size, visible frame, backing scale. |
| `tools/cursor.swift` | Reads or parks the real pointer (no click, no event), for the no-cursor proof. |
| `spike.sh` | Recorder spike without the app (permission, fps, clock). |
| `../../scripts/footage/run.sh` | One scene end to end: build, boot the app on the demo mailbox, record, check, stream back. |
| `../../scripts/footage/scenes/*.js` | One wdio spec per scene. |
| `../../scripts/footage/lib/footage.js` | `Take`: recorder process + action log + in-page click/type/scroll. |
| `../../wdio.footage.conf.js` | Mock IMAP demo accounts, seeded settings, driver on its own port. |

## Run the full set (P1)

Two app boots, one job each, run one after the other (one app instance on the
mini at a time; the second queues behind the first on the `mini-e2e` lane):

```bash
S=<scratch dir>/footage
# Boot A: every clip that leaves the server alone, one .mov per clip.
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SPEC=boot-a FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=2842 \
  bash scripts/footage/run.sh > $S/boot-a.tar 2> $S/boot-a.log
# Boot B: S3 deletes a year from the mock server, so it gets its own boot.
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SPEC=s3-archive FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 FOOTAGE_EXPECT_TOTAL=2842 \
  bash scripts/footage/run.sh > $S/boot-b.tar 2> $S/boot-b.log
bash scripts/footage/collect.sh $S/boot-a.tar $S boot-a --s7
bash scripts/footage/collect.sh $S/boot-b.tar $S boot-b
node scripts/footage/lib/manifest.mjs $S $S/verdicts.json   # verdicts written after looking at frames
```

| Spec | Clips | Server |
| --- | --- | --- |
| `scenes/boot-a.js` | `s1-hero`, `s2-vault-states`, `s4-search`, `s5-explorer-insights`, `s6a-chat`, `s6b-undo`, `s6c-autotags` | untouched after setup |
| `scenes/s3-archive.js` | `s3-archive` | one year deleted |
| `scenes/s4-search.js` | `s4-search` (the spike, standalone) | untouched |

`FOOTAGE_ONLY=s1-hero,s4-search` limits boot A to those clips (setup still
runs). Every clip is its own mocha `it`, so one failed take does not stop the
rest; each starts from `resetView()` (work INBOX, list view, All mail, nothing
open, no search, list at the top).

### The mailbox (`scripts/footage/lib/mailbox.js`)

The demo mailbox, changed for footage only (the demo module and the app are
untouched):

- Text patches (`FOOTAGE_PATCH_TEXT=0` turns them off), on the raw MIME source:
  `MeatPad 0.9` -> `MeatPad` (row 1 and its body), `Amount: EUR 48.00. ` -> ``
  (the invoice body), `in Keynote` -> `in a slide deck` (a thread bubble), the
  personal account's `gmail.com` / the `fastmail.example` sender -> `marshfamily.me`,
  and every em dash -> hyphen.
- `FOOTAGE_HISTORY=1`: 2,760 older messages in the work INBOX from the demo's own
  fictional cast (2022: 420, 2023: 560, 2024: 700, 2025: 820, 2026: 260, all
  before the demo's own mail), 183 of them with "invoice" in the subject. The
  INBOX then holds 2,842. History uids are 1..2760; the demo INBOX is renumbered
  +10000 so nothing newest-by-uid surfaces 2022 before the hero rows.
  `"2022:420,2023:560"` sets the spread. The messages have real-mail shapes so a
  vault listing shows real-mail sizes (median about 2 KB, p90 about 15 KB, up to
  38 KB): most carry an HTML alternative, half quote the message they answer,
  newsletters are long HTML, invoices, statements and proofs carry a PDF.
- `FOOTAGE_ALIGN_NOW` (default on): the demo stamps today's mail at fixed UTC
  hours (08:12, 07:48), which is in the future for a run before about 11:15
  local ("Just now" in chat). Every demo message is moved back by the same whole
  number of minutes, only when needed, so the newest one arrived 35 minutes
  before the run. Order, gaps and senders' UTC offsets are kept. Every run logs
  `demo clock moved N min`; `FOOTAGE_ALIGN_SHIFT_MIN=N` applies that same shift
  again, so a re-take shows the same clock times as the clips it joins (a6 was
  -320: MeatPad at 5:52 AM). It is refused when it would put the newest
  message in the future.
- `FOOTAGE_BODY_DELAY_MS`: the demo stalls every `BODY.PEEK[]` 350 ms (for the
  archive progress bar). `0` removes it (boot A: messages open instantly), a
  number replaces it (boot B: the archive's pace).

### Setup before the first take (boot A, not recorded)

The per-message states, through the app's own actions (about 25 s):

- green: the bulk dialog, Last 90 Days -> Archive (67 messages);
- blue: today's two messages un-archived again (`removeLocalEmails`, what the
  dialog's Unarchive runs);
- amber: three archived messages whose server copy the app then deletes
  (`deleteEmailFromServer`, the reader's Delete). That path stamps the
  "we deleted it" proof that makes a row the only copy. The bulk dialog's
  Archive & delete does NOT stamp it today, so rows it moves stay green in the
  list (app behaviour, reported, not changed).

Insights is opened once and closed (its load time goes into the facts; it does
not warm a later open, see below). The backup drive dot
is NOT seeded: the only route is a real backup run, which archives every folder
it touches (it would turn the blue rows green), and a mirror the scan cannot
read makes every row wear a hollow "unknown" dot. Untested, so left out.

Between S2 and S4 (`archiveEverything`, `FOOTAGE_ARCHIVE_ALL=0` turns it off):
the bulk dialog's All -> Archive, so search answers from this computer
("185 local, 0 server") and Insights reads a complete vault. The three only-copy
messages have no server copy to fetch, so that run ends "Finished with 3
failed"; its bubble is closed before S4. S5 comes right after S4, so it shows
the same archived vault (its own prepare runs the same step, a no-op after S4,
so `FOOTAGE_ONLY` without S4 still archives first).

Insights cannot be pre-warmed: closing it disposes its snapshot, so every open
reads the whole vault again (about 4.6 s with 2,842 files in the E2E build's
debug daemon, "Reading local headers... N found" then "Updating Insights..."
over an empty panel). S5 records that read and writes its exact window to
`notes.insights` in its `actions.json` (`click`, a `timeline` of every status
and busy-line change, `mapDrawn`, `scrollEnd`). `mapDrawn` is the DOM commit;
the first complete painted map comes 2-3 frames later (a8, the delivered take:
commit 13.144 s, "Updating Insights..." on frames 788-790, complete on 791 =
13.183 s, a 1 px settle on 792), so take the cut-in from the frames. After
`scrollEnd` only the overlay scrollbar at the right edge fades out (about
0.8 s); then nothing moves to the end. S5 also closes the search panel S4 left
open, so it starts on a plain List view.

### Before every take

- `resetView()`: no compose (and its "Discard message?" confirmation), no
  settings, no insights, list view, All mail, no search, no bulk bubble, nothing
  open, list at the top.
- `.sidebar-version` ("MailVault v2.16.0") is hidden by a stylesheet the harness
  injects into the page (`#footage-hide-version`); no app code changes. Its box
  (measured before hiding) is in `geometry.json` under `versionLabel`: window
  points x 16, y 938, 188.9 x 16 (pixels 32, 1876, 378 x 32).
- The same injected stylesheet removes the `:focus-visible` ring from buttons,
  links, tabs and switches. This changes pixels, so it is disclosed here: a
  take's clicks are dispatched in the page, so WebKit sees no real pointer and
  treats focus as keyboard focus, painting a ring a mouse user never sees (a
  dialog's autofocused close button, the last button clicked). Text fields
  keep their focus ring.
- `quiet()` waits until no toast, chip, bubble or dialog is on screen;
  `<clip>.census.json` records every visible `position: fixed` element at the
  start of the take.

### actions.json additions

- `{ "t", "type": "cut", "label", "note" }`: the picture changes without a
  pointer action (a setting switched through the store because its control is a
  native menu or lives in Settings). Cross-fade here; the cursor rests. Used by
  `s6a-chat` (Mail view: Email -> Chat).
- `scroll` events from `Take.scrollEase` / `Take.reveal` carry `ease: "inOutCubic"`
  and the distance the element really moved (`dy`).
- `type` events from `Take.typeRich` (compose editor) have the same shape as
  input typing.
- `boxes` (named boxes in window points) and `notes` (free-form, e.g. S3's
  progress timing) at the top level.

### S7

`s7-vault-listing.json` is written by `scripts/footage/lib/vaultListing.mjs`
from the run's own HOME before it is deleted: the Maildir layout with file
counts and bytes, 16 real `.eml` entries (name, size, mode, mtime), and
`ls -lh`-style lines without owner or group.

## Run one scene

From the worktree root (the job ships uncommitted files; the clone is deleted
afterwards, so the results come back as a tar on stdout):

```bash
S=<scratch dir>
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SCENE=s4-search bash scripts/footage/run.sh > $S/take.tar 2> $S/take.log
tar -tf $S/take.tar && tar -xf $S/take.tar -C $S
```

Knobs: `FOOTAGE_WINDOW` (default `1536x928`: the web content in points; the
window adds a 32 pt title bar, so the window is 1536x960 and records at
3072x1920), `FOOTAGE_CAPTURE` (`display`|`window`, see recorder `--mode`),
`FOOTAGE_THEME` (`dark`|`light`; light also sets the window's own appearance so
the native title bar is light, see `scripts/footage/README.md` "The light set"),
`FOOTAGE_CODEC` (`hevc`|`h264`),
`FOOTAGE_BITRATE` (Mbps, default 80), `FOOTAGE_REAL_MOTION` (`1` restores
framer-motion transitions in the E2E build when the window is visible, `0`
leaves them off), `FOOTAGE_QUERY` (S4).

Window size: the mini's display is a 3840x2160 virtual display at 2x (1920x1080
points); the menu bar (30 pt) and the Dock (90 pt) leave a visible frame of
1920x960 points, so 960 pt is the tallest window that is not under the Dock.
1536x960 is 16:10 (the website screenshot aspect) and 3072x1920 px, which sits
in a 3840x2160 frame at about 0.9-1.0x, so camera zooms up to about 1.1x stay at
or above native resolution.

Output: `<scene>.mov`, `<scene>.mov.json` (recorder accounting),
`<scene>.actions.json`, `<scene>.stats.json` (framestats on the finished file),
`frames/*.png` (1600 px wide), `run.log`, `geometry.json`, `motion.json`,
`<scene>.load.txt` (top while recording), `leftover.txt` (this job's processes
after cleanup: must say `none`), `foreign.txt` (MailVault processes of other
clones that were already running, for the record).

`run.sh` waits (up to 10 min) while another project's XCUITest run is driving
the display: those clicks are real and would land on our pinned window.

Guards a take fails on: a webview that is not 2x (`FOOTAGE_EXPECT_SCALE`), a
clip that is not the expected size (`FOOTAGE_EXPECT`, default window x 2 with
the 32 pt title bar, i.e. `3072x1920`; `""` skips), a blank capture, no START
within 15 s, fewer than 10 delivered pictures. `probe.json` in the tar records
the display mode the take ran on.

Before a take the scene parks the mini's real pointer on the window's title bar
(`tools/cursor.swift`; it moves the shared mini's pointer, no click and no
event), so a clip without a pointer is evidence of `showsCursor = false`
rather than luck. The title bar is not web content, so the parked pointer gives
nothing a hover state.

## recorder

```
recorder <CGWindowID> <out.mov> [--fps 60] [--codec hevc|h264] [--bitrate 80]
         [--mode app|window|display|screen] [--start-timeout 8] [--max-seconds 300]
```

- Capture, by `--mode` (all record the window's frame at the backing pixel size,
  points x `pointPixelScale`, BGRA, sRGB, `showsCursor = false`, queue depth 8,
  shadows excluded):
  - `app` (default): `SCContentFilter(display:excludingApplications: <every
    other app>)` with `sourceRect` = the window's frame. Other apps, the Dock and
    the wallpaper are left out; the window corners come out black.
  - `window`: `SCContentFilter(desktopIndependentWindow:)`.
  - `display`: `SCContentFilter(display:including: [window])`, cropped.
  - `screen`: the whole display composite, cropped (whatever overlaps shows).
- Use `app`. On macOS 26 a filter that names the window (`window`, `display`)
  makes the system replace the window's traffic lights with a "window is being
  shared" badge, which then sits in every frame (measured: from about 1 s in
  with `window`, from the second frame with `display`; never with `app`).
  `framestats` reports `titleBarCorner` (frames whose title-bar corner differs
  from the first frame), so a take that carries the badge is caught.
- The window's rounded corners come out as opaque black: mask them in the
  compositor.
- stdout, exactly two lines: `START <epoch ms>` when the first complete frame
  arrives (the value is that frame's display time on the wall clock, from its
  host-clock PTS; it may carry a fraction), and `STOP <frames written> <dropped>`
  after the file is finalised. SIGINT or SIGTERM stops cleanly.
- Exit codes: 0 ok, 2 ScreenCaptureKit refused (the NSError domain and code are
  printed), 3 writer setup, 4 no complete frame within `--start-timeout` (the
  window is not being drawn), 5 the file did not finalise.
- `<out.mov>.json`: geometry (`logicalW/H`, `scale`, `pixelW/H`, `windowID`,
  `pid`, `screenFrame`) and the accounting below, plus `cpuPercent` of the
  recorder itself.

### Constant frame rate and frame accounting

ScreenCaptureKit only hands over a picture when the window's pixels change. The
writer turns that into constant frame rate: frame `n` of the file has PTS
`n / fps`; a delivered picture goes into the slot nearest its display time
(`round((pts - firstPts) * fps)`), and a slot nobody delivered repeats the
previous picture, three frames behind real time so a slightly late delivery
still lands in its own slot. File time therefore equals wall time since START to
within half a frame.

| Field | Meaning |
| --- | --- |
| `framesWritten` | slots in the file |
| `delivered` | complete pictures ScreenCaptureKit delivered (real content changes) |
| `padded` | slots filled by repeating the previous picture (static window; expected) |
| `dropped` | a picture was due but the writer was not ready: a real loss |
| `late` | a delivered picture whose slot had already been padded (kept for the next slot) |
| `merged` | two delivered pictures for one slot (the later is kept for the next slot) |
| `uniqueDelivered`, `uniformDelivered`, `blankSuspect` | blank-capture check on DELIVERED pictures (padded slots are identical by design) |
| `deliveredSlots` | which frames of the file are real pictures |

### Clock

`START` is the wall-clock time the first picture was on screen, from its
host-clock PTS. `tools/testwin.swift` paints its own target display time as a
bar code every frame and `framestats --barcode` compares it with `START + t`
(`spike.sh`): `window` mode lands within +-2.5 ms (median about +1 ms, a few
frames one refresh late); display-based modes (`app`) stamp one refresh late
(-17.3 ms, steady to under 1 ms), so the recorder moves START back by one
refresh (`startCorrectionMs`), after which `app` measures -0.5 ms median
(-0.8 to -0.2 ms). The harness stamps events with the page's `Date.now()` on
the same machine, so event `t` and video `t` share one clock.

A capture is blank when every delivered picture hashes the same or is one flat
colour; `Take.stop()` throws on it. The recorder fails fast (exit 4) when no
picture arrives at all, which is how a window that is not being composited shows
up.

## actions.json

Written by `Take.stop()` next to the clip. The file is named per scene,
`<scene>.actions.json` (for example `s4-search.actions.json` beside
`s4-search.mov`), so seven scenes can share one folder; there is no bare
`actions.json`. The compositor redraws the cursor from it and aims camera zooms
at it.

A real one (the S4 take, 6 of its 13 events, numbers rounded):

```jsonc
{
  "version": 1,
  "scene": "s4-search",
  "clip": "s4-search.mov",
  "fps": 60,
  "window": {
    "logicalW": 1536, "logicalH": 960,           // window in points = video size / scale
    "scale": 2, "pixelW": 3072, "pixelH": 1920,  // the video's pixel size
    "webview": { "x": 0, "y": 32, "w": 1536, "h": 928 }  // web content: below the 32 pt title bar
  },
  "recorderStartEpochMs": 1790640119805.3,       // START: video t = 0
  "durationSeconds": 6.883,
  "events": [
    { "t": 1.026, "type": "move", "x": 700.531, "y": 63,
      "bbox": { "x": 662.062, "y": 48, "w": 76.938, "h": 30 }, "label": "search-toggle", "dur": 0.65 },
    { "t": 1.681, "raf": 1.708, "type": "click", "x": 700.531, "y": 63,
      "bbox": { "x": 662.062, "y": 48, "w": 76.938, "h": 30 }, "label": "search-toggle", "shown": 1.75 },
    { "t": 1.719, "type": "focus", "x": 441.789, "y": 245,
      "bbox": { "x": 272, "y": 226, "w": 339.578, "h": 38 }, "label": "search-box" },
    { "t": 2.077, "raf": 2.08, "type": "type", "x": 441.789, "y": 245,
      "bbox": { "x": 272, "y": 226, "w": 339.578, "h": 38 }, "label": "search-box", "text": "i", "shown": 2.1 },
    { "t": 3.049, "raf": 3.069, "type": "type", "x": 441.789, "y": 245,
      "bbox": { "x": 272, "y": 226, "w": 339.578, "h": 38 }, "label": "search-box", "text": "\n", "key": "Enter" },
    { "t": 5.343, "raf": 5.357, "type": "click", "x": 505.5, "y": 330,
      "bbox": { "x": 256, "y": 304, "w": 499, "h": 52 }, "label": "result-1", "shown": 5.4 }
  ]
}
```

`scroll` events (none in S4) look like
`{ "t", "type": "scroll", "x", "y", "bbox", "label", "dy": <px>, "dur": <s> }`.
Coordinates are already in WINDOW points: the webview offset is applied, so
`y` of a web element includes the 32 pt title bar.

- `t`: seconds since the first recorded frame (float). Frame index = `round(t * fps)`.
  Stamped with the page's own `Date.now()` at the moment the action was
  dispatched, against the recorder's START (same wall clock, same machine).
- `raf` (click, type): when the page's next animation frame ran after the
  dispatch (usually 0-1 frames after `t`).
- `shown` (click, type; added by `run.sh` from `framestats`): the time of the
  first frame whose pixels actually changed after the event. Measured on the S4
  takes: keys 12-28 ms (1-2 frames) after `t`, clicks 57-71 ms (about 4 frames:
  React render plus WebKit's paint pipeline). Absent when the event changed
  nothing measurable (Enter).
- `x`, `y`: window logical px (origin top-left of the window, points), centre of
  the target. Video px = logical x `scale`.
- `bbox`: the target's box in window logical px, or null.
- `label`: short human name (`search-toggle`, `search-box`, `result-1`).
- `text` (type): one event per character; Enter is `"\n"` with `key: "Enter"`.
- `dur` (move, scroll): seconds.

Cursor semantics:

- `move`: the cursor leaves its current position at `t` and arrives at
  `(x, y)` at `t + dur`, which is when the click that follows lands.
- `click`: press and release at `(x, y)` at `t` (ripple + tick SFX here).
- `focus`: a field took focus without a click (autofocus): a camera target, the
  cursor stays where it is.
- `type`: key at `t` (keyboard tick); the cursor stays put (hide it while typing
  if that reads better).
- `scroll`: wheel over `(x, y)` from `t` for `dur`.
- Between events the cursor rests.

## Harness facts (tauri-wd)

- `performActions` sends MouseEvents only, there is no hover and no dblclick, and
  `browser.keys` never reaches an input's value. `Take` dispatches a
  pointer + mouse sequence at the target's centre in the page, types through the
  React value setter one character at a time (~90 ms +- 35 ms, seeded), and
  submits with `form.requestSubmit()`. CSS `:hover` states never appear in the
  footage.
- The E2E build (`VITE_E2E=1`) sets framer-motion's `skipAnimations` in
  `src/e2eMotion.js`, so modals and panels appear without their transitions.
  `restoreMotion()` switches it back when the page is visible and native
  animation frames tick (`motion.json` says what happened).
- `window.js raiseWindow` sizes, centres and pins the window on top; an occluded
  WKWebView stops painting.
- The app HOME template stays short (`mvfoot`): the daemon socket path is capped
  at 104 bytes.
