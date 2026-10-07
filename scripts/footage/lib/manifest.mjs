/**
 * manifest.json for a collected footage dir (scripts/footage/collect.sh layout).
 *
 *   node scripts/footage/lib/manifest.mjs <footage dir> [verdicts.json]
 *
 * One entry per clip dir: duration, pixel size, fps and frame counts from
 * framestats (the finished file, not the recorder's intent), the guard results
 * (blank capture, title-bar badge, event lag), events by type, cuts, notes, the
 * overlays census at the start of the take, and the human verdict (PASS/FAIL
 * plus notes) from verdicts.json, which is written after LOOKING at the frames:
 * a green log is not a verdict.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, verdictsPath] = process.argv.slice(2);
if (!dir) { console.error('usage: manifest.mjs <footage dir> [verdicts.json]'); process.exit(2); }
const verdicts = verdictsPath && existsSync(verdictsPath) ? JSON.parse(readFileSync(verdictsPath, 'utf-8')) : {};
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null);

const clips = [];
for (const name of readdirSync(dir).sort()) {
  const d = join(dir, name);
  if (name.startsWith('_') || !statSync(d).isDirectory() || !existsSync(join(d, `${name}.mov`))) continue;
  const stats = read(join(d, `${name}.stats.json`)) || {};
  const actions = read(join(d, `${name}.actions.json`)) || {};
  const rec = read(join(d, `${name}.mov.json`)) || {};
  const census = read(join(d, `${name}.census.json`));
  const events = actions.events || [];
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  const v = verdicts[name] || {};
  clips.push({
    clip: `${name}/${name}.mov`,
    actions: `${name}/${name}.actions.json`,
    durationSeconds: Number((stats.durationSeconds ?? actions.durationSeconds ?? 0).toFixed(3)),
    pixelSize: stats.width ? `${stats.width}x${stats.height}` : `${rec.pixelW}x${rec.pixelH}`,
    fps: stats.measuredFps ? Number(stats.measuredFps.toFixed(3)) : null,
    frames: stats.frames ?? null,
    codec: stats.codec ?? null,
    megabytes: Number((statSync(join(d, `${name}.mov`)).size / 1048576).toFixed(1)),
    guards: {
      blankSuspect: stats.blankSuspect ?? rec.blankSuspect ?? null,
      titleBarFramesDifferent: stats.titleBarCorner?.framesDifferentFromFirst ?? null,
      eventLagFrames: stats.eventLagFrames ?? null,
      dropped: rec.dropped ?? null,
      delivered: rec.delivered ?? null,
    },
    events: byType,
    cuts: events.filter((e) => e.type === 'cut').map((e) => ({ t: e.t, label: e.label, note: e.note })),
    notes: actions.notes || {},
    overlaysAtStart: census ? census.left : null,
    run: existsSync(join(d, 'run.txt')) ? readFileSync(join(d, 'run.txt'), 'utf-8').trim() : null,
    verdict: v.verdict || 'UNREVIEWED',
    avoid: v.cuts || [],
    review: v.notes || '',
  });
}
const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  window: 'app window 1536x960 pt (32 pt title bar + 1536x928 web content) at 2x = 3072x1920 px, HEVC, 60 fps constant, no cursor',
  clips,
  extra: verdicts._extra || {},
};
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(clips.map((c) => [c.clip, c.durationSeconds, c.pixelSize, c.fps, c.verdict])));
