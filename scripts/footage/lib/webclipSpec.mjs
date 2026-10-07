/**
 * The final encoder spec for one web clip:
 *
 *   node scripts/footage/lib/webclipSpec.mjs <dir> <clip> [variant] > spec.json
 *
 * Starts from `<dir>/<clip>.webclip.json` (what the take measured: crop,
 * segments of the .mov, poster) and applies the reviewed overrides in
 * scripts/footage/web-clips.crops.json for that clip, if any:
 *
 *   { "<clip>": {
 *       "crop": [x, y, w, h],          // window points; replaces the default crop
 *                                     // and every segment crop not named below
 *       "segmentCrops": { "<segment label or index>": [x, y, w, h] },
 *       "trim": { "<label or index>": { "t0": +s, "t1": -s } },  // nudges, seconds
 *       "poster": 3.2 } }             // output seconds
 *
 * Crops are forced to the output aspect (height follows width) and kept inside
 * the window below its 32 pt title bar. `variant` "wide" widens every crop by
 * 30 % about its centre (a review alternative).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [dir, clip, variant = 'main'] = process.argv.slice(2);
if (!dir || !clip) { console.error('usage: webclipSpec.mjs <dir> <clip> [main|wide]'); process.exit(64); }

const spec = JSON.parse(readFileSync(join(dir, `${clip}.webclip.json`), 'utf-8'));
const overridesPath = join(import.meta.dirname, '..', 'web-clips.crops.json');
const all = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf-8')) : {};
const o = all[clip] || {};

let win = { w: 1536, h: 960 };
try {
  const a = JSON.parse(readFileSync(join(dir, `${clip}.actions.json`), 'utf-8'));
  win = { w: a.window.logicalW, h: a.window.logicalH };
} catch { /* defaults */ }

const [outW, outH] = spec.size || [960, 660];
const aspect = outW / outH;
const TITLE = 32;
const inset = 2;

function fit([x, y, w, h], grow = 1) {
  const cx = x + w / 2, cy = y + h / 2;
  let W = w * grow;
  W = Math.min(W, win.w - 2 * inset, (win.h - TITLE - 2 * inset) * aspect);
  const H = W / aspect;
  let X = Math.max(inset, Math.min(cx - W / 2, win.w - inset - W));
  let Y = Math.max(TITLE + inset, Math.min(cy - H / 2, win.h - inset - H));
  return [X, Y, W, H].map((v) => Math.round(v * 2) / 2);
}

const key = (s, i) => [String(i), s.label].filter(Boolean);
const grow = variant === 'wide' ? 1.3 : 1;
if (o.crop) spec.crop = o.crop;
spec.crop = fit(spec.crop, grow);
spec.segments = spec.segments.map((s, i) => {
  const named = key(s, i).map((k) => o.segmentCrops?.[k]).find(Boolean);
  const trim = key(s, i).map((k) => o.trim?.[k]).find(Boolean) || {};
  const crop = named || (o.crop ? null : s.crop) || null;
  return {
    ...s,
    t0: s.t0 + (trim.t0 || 0),
    t1: s.t1 + (trim.t1 || 0),
    ...(crop ? { crop: fit(crop, grow) } : { crop: spec.crop }),
  };
});
const dur = spec.segments.reduce((a, s) => a + s.t1 - s.t0, 0);
if (o.poster != null) spec.poster = o.poster;
spec.poster = Math.min(spec.poster, dur - 0.1);
spec.frames = [0.1, ...[0.2, 0.4, 0.6, 0.8].map((f) => Number((dur * f).toFixed(2))), Number((dur - 0.1).toFixed(2))];
spec.variant = variant;
spec.overrides = Object.keys(o).length ? o : null;
process.stdout.write(JSON.stringify(spec, null, 2));
