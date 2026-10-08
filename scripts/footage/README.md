# Footage specs

Real footage of the real app for the preview video. The recorder, the clip
checks and the `actions.json` schema are documented in
`video/capture/README.md`; this folder holds what drives the app.

| File | What it is |
| --- | --- |
| `run.sh` | The whole mini job: build, boot, run one spec, check every clip, write the S7 listing, stream a tar back. |
| `collect.sh` | Local: unpack a run's tar into `<footage dir>/<clip>/...` (a re-take replaces the clip). |
| `lib/footage.js` | `Take`: recorder process, in-page click / type / rich-text type / eased scroll / reveal / cut, `actions.json`. |
| `lib/scene.js` | Around the takes: boot to the work INBOX, hide the version label, `resetView()`, `quiet()`, overlay census. |
| `lib/mailbox.js` | The demo mailbox for footage: text patches, multi-year history, clock alignment, body-fetch pace. |
| `lib/vaultListing.mjs` | S7: the run's real vault on disk as JSON (`s7-vault-listing.json`). |
| `lib/manifest.mjs` | `manifest.json` for a collected footage dir, with the reviewed verdict per clip. |
| `scenes/boot-a.js` | S1, S2, S4, S5, S6a, S6b, S6c in one boot (server untouched after setup). |
| `scenes/s3-archive.js` | S3 in its own boot (it deletes 2022 from the mock server). |
| `scenes/s4-search.js` | The original S4 spike, standalone. |
| `scenes/web-clips.js` | The short website feature-card takes (about 5 s each): batch 1 (boots A-C), batch 2 (boots D-G), batch 3 (boot H, plus the tagging-rules retake in G). |
| `web-clips.sh` | Website clips: `verify` / `all` (one build, every clip; below), and the older per-boot path: `record` (boots A-H; `WEBCLIP_ONLY=clip,clip` re-takes just those clips of a boot), `encode` (re-cut collected takes, no boot), `hero` (the 16:10 montage from collected takes, no boot), `publish` (`WEBCLIP_HOLD=clip:reason` routes a clip to `_needs-decision`; never over a published file unless `WEBCLIP_REPLACE=clip`; `WEBCLIP_ONLY` publishes just those). |
| `web-clips-job.sh` | The single-build mini job behind `web-clips.sh verify` and `all`. |
| `web-clips.groups.json` | Launch groups of that job: clips in run order and seed env per group. |
| `lib/heroSpec.mjs` | The hero's encoder spec from `hero-montage.json` and this run's takes. |
| `lib/webclipCheck.mjs` | Output check of every encoded clip (`check.json`). |
| `hero-montage.json` | The homepage hero: which take, which seconds and which 16:10 crop per cut (1440x900, at most 1.6 MB, poster at most 150 KB). |
| `webclip-encode.sh` | Takes to 960x660 H.264 web clips + posters with `video/capture/tools/webclip.swift` (no ffmpeg on the runners); a spec whose segments name their own takes (`src`) is a montage. |
| `web-clips.crops.json` | Reviewed crop / trim / poster overrides per web clip (window points). |
| `lib/locale.js` | `FOOTAGE_LOCALE`: UI language and demo catalog of a run. |

## Website clips: one build, every clip

```bash
W=<work dir>
bash scripts/footage/web-clips.sh verify en $W     # every take's steps and assertions, nothing recorded
bash scripts/footage/web-clips.sh all en $W        # verify, then record, encode, hero montage, output check
WEBCLIP_PUB=en-v2 bash scripts/footage/web-clips.sh publish en $W/all-<stamp>
```

Both are ONE minijob (`web-clips-job.sh`): the Swift tools, prepare-build,
`build:e2e`, mock IMAP and the FM helper are built once (`job.json` `builds: 1`),
then every launch group runs in its own fresh short HOME with its own seed env,
and the app, its daemon and the mock servers are stopped before the next. A
locale list (`"en de fr"`) reuses the build: one launch per group per locale.
Each call unpacks into its own `<work dir>/<mode>-<stamp>/`; nothing is merged
with an earlier run, so no stale encode can be published.

| Group | Clips, in run order | Seed (on top of dark, `FOOTAGE_ALIGN_ALL=1 FOOTAGE_ALIGN_SHIFT_MIN=-1760`) |
| --- | --- | --- |
| history | sender-verification, chat-view, archive-delete, scheduled-send | `FOOTAGE_HISTORY=1`, body fetch 65 ms, 2842 total; archive-delete deletes 2022 from the server, scheduled-send after it (its Scheduled count stays out of the archive clip) |
| mail | unified-inbox, link-safety, trackers, search-local, insights, views, undo-send, time-capsule, scheduled-backups | history + `FOOTAGE_EXTRA_MAIL=1` (tracker newsletter), 2852 total; undo-send after the search and list takes (its reply draft stays out of their lists) |
| settings | privacy-mode, layouts, manual-backup, custom-fields, ai-writing, tagging-rules | the demo mailbox alone, 82 total; the FM helper for the AI takes; the backup and the field strip stay out of the list and reader takes |
| demo | quick-actions, explorer-view, column-layout, shortcuts, notification-rules, templates, tags, radial-menu, snooze, focus-session | the demo mailbox alone, 82 total; snooze takes a row out, focus-session locks the window, so they run last |

`search50k` and `cleanup` (held clips) are groups too, outside the default set
(`WEBCLIP_GROUPS="search50k"`). The table lives in `web-clips.groups.json`.

The clock: one fixed shift for every group, so every clip shows the same
times and weekday labels. `-1760` (web-clips.groups.json) puts the newest demo
message at 05:52 yesterday (the personal account's at 09:45 yesterday): valid
at any hour, and no list header, date range or reader date ends on the day of
the run (v1's `-320` showed today's date in the archive header and the tracker
newsletter's reader, and with every account aligned it is refused before
09:45 local). A recording job never falls back to "now"
(`FOOTAGE_ALIGN_STRICT=1`), and a group that would start after local midnight
refuses. The tracker newsletter and the newest subscription note sit at fixed
distances from the shifted newest message. Inherent dates stay: the snapshot
time-capsule takes is stamped now, and Scheduled send's "Tomorrow" is a real
date (run after 07:00 local so New York's tomorrow is not today).

Verify and the take assertions: every take calls `check(name, ok, actual)`
for its cause and effect (the chip after the rule, the row gone after snooze,
the toolbar before and after the preset, the theme flip, the backup's files,
three columns then the reader below, the rebound key starring, Scheduled 1, ...);
a failed check aborts the take. `FOOTAGE_VERIFY=1` runs the same steps and
holds without a recorder. Each group writes `web-clips.verify.json`; the job
merges them into `<locale>/verify/verify.json` and `all` records only when
every take passed (`WEBCLIP_FORCE=1` records anyway). The in-page text scan
(em dash, version label, "N days ago", today's date) runs on the take's crop
and on the reviewed override crops in `web-clips.crops.json` (an override's
whole-clip crop replaces the take's own); text under an opaque or painted layer
(the focus lock) is not counted. A scan hit does not fail verify (the UI is not
broken); verify reports it and the output check holds that clip.
`lib/webclipCheck.mjs` then checks each encoded file from its own bytes
(960x660 or 1440x900 for the hero, H.264, no audio, moov first, duration,
250 KB / 1.6 MB, poster size and 80 KB / 150 KB) plus the scan and the record
run's assertions; `publish` holds every clip that fails it in
`_needs-decision/` with the reasons. tagging-rules retries the arrival up to
`FOOTAGE_TAG_ATTEMPTS` (3) times with a fresh copy (the untagged one is
deleted from the server) and reports the attempts.

The hero (`hero-montage.json`) places each cut on a segment of its take
(`seg` + `[start|end, offset]`), resolved against this run's takes by
`lib/heroSpec.mjs`.

## The full set

```bash
S=<scratch dir>
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SPEC=boot-a FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=2842 \
  bash scripts/footage/run.sh > $S/boot-a.tar 2> $S/boot-a.log
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SPEC=s3-archive FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 FOOTAGE_EXPECT_TOTAL=2842 \
  bash scripts/footage/run.sh > $S/boot-b.tar 2> $S/boot-b.log
bash scripts/footage/collect.sh $S/boot-a.tar $S/footage boot-a --s7
bash scripts/footage/collect.sh $S/boot-b.tar $S/footage boot-b
node scripts/footage/lib/manifest.mjs $S/footage $S/footage/verdicts.json
```

One boot-A clip again, in the state and clock of the clips it joins (S5 in a8:
the clips before it run too so the vault, read flags and badge match, the
clock shift is the one a6 logged, and only S5 is kept):

```bash
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SPEC=boot-a FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=0 FOOTAGE_EXPECT_TOTAL=2842 \
  FOOTAGE_ALIGN_SHIFT_MIN=-320 FOOTAGE_ONLY=s1-hero,s2-vault-states,s4-search,s5-explorer-insights \
  bash scripts/footage/run.sh > $S/a8.tar 2> $S/a8.log
```

Strip the other clips from the tar before `collect.sh` (it replaces every clip
it finds) and leave `--s7` off.

## The light set (light graphite)

Same specs, same mailbox and clocks, with `FOOTAGE_THEME=light` (the harness
always seeds palette graphite) into its own footage dir. Pass the theme
explicitly: a run without it is a dark take that passes every other guard.

```bash
S=<scratch dir>; L=$S/footage-light
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SPEC=s3-archive FOOTAGE_THEME=light FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 \
  FOOTAGE_EXPECT_TOTAL=2842 FOOTAGE_ALIGN_SHIFT_MIN=-391 \
  bash scripts/footage/run.sh > $S/light-b.tar 2> $S/light-b.log
TESTQ_TIMEOUT=14400 ~/.claude/bin/testq --lane mini-e2e ~/.claude/bin/minijob \
  env FOOTAGE_SPEC=boot-a FOOTAGE_THEME=light FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=0 \
  FOOTAGE_EXPECT_TOTAL=2842 FOOTAGE_ALIGN_SHIFT_MIN=-320 \
  bash scripts/footage/run.sh > $S/light-a.tar 2> $S/light-a.log
bash scripts/footage/collect.sh $S/light-a.tar $L light-a --s7
bash scripts/footage/collect.sh $S/light-b.tar $L light-b
node scripts/footage/lib/manifest.mjs $L $L/verdicts.json
```

`-320` is the dark boot-A shift (MeatPad 5:52 AM), `-391` the dark S3's (b3,
MeatPad 4:41 AM). A fixed shift keeps the clock, not the age: relative times
("37m ago" in the chat list) read from the hour the run happens.

What light needs beyond the theme seed:

- The native title bar (the 32 pt strip with the traffic lights) is window
  chrome in the app's appearance, which follows the system; the mini runs Dark,
  so over a light UI it would be a dark bar. `lib/scene.js` `setWindowTheme`
  calls Tauri's window `setTheme('light')` right after the window is raised
  (NSApp.appearance = Aqua for this process only; no system setting changes).
  `run.sh` grants `core:window:allow-set-theme` for it in a footage-only
  capability (`src-tauri/capabilities/footage.json`, written in the job clone
  before the build, removed in `finish`). `geometry.json` `windowTheme` records
  the window theme before and after. Dark takes leave the window alone.
- `Take.start()` refuses to record when the page's `data-theme` is not
  `FOOTAGE_THEME`, and `probe()` (so every `<clip>.census.json`) carries
  `theme` and `palette`: frame 0 is proven light, not assumed.

Timing on the mini (warm sccache): boot A about 6 min wall (build 1.5 min,
wdio 3.5 min), boot B about 2.5 min. `FOOTAGE_BODY_DELAY_MS=65` gives S3 about
6.4 s of visible progress for the 420 messages of 2022 (5 parallel fetches).

Every take ends with `framestats` on the finished file; `run.sh` writes the
`shown` times into `actions.json`. A clip is only good once its frames have been
looked at (`collect.sh` keeps `frames/`; `ffmpeg -ss <t> -i <clip>.mov
-frames:v 1` for any other moment).
