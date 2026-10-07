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
| `scenes/web-clips.js` | The eight short website feature-card takes (about 5 s each). |
| `web-clips.sh` | Website clips per locale: `record` (three boots), `encode` (re-cut collected takes, no boot), `publish`. |
| `webclip-encode.sh` | Takes to 960x660 H.264 web clips + posters with `video/capture/tools/webclip.swift` (no ffmpeg on the runners). |
| `web-clips.crops.json` | Reviewed crop / trim / poster overrides per web clip (window points). |
| `lib/locale.js` | `FOOTAGE_LOCALE`: UI language and demo catalog of a run. |

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
