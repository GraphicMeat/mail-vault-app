/**
 * The homepage hero's encoder spec from scripts/footage/hero-montage.json and
 * the takes of THIS run:
 *
 *   node scripts/footage/lib/heroSpec.mjs <hero-montage.json> <takes dir> > <takes dir>/hero-montage.webclip.json
 *
 * A cut names its take and either absolute seconds of that take's .mov
 * (`"t0": 7.8`) or a place relative to one of the take's own segments
 * (`"seg": "complete", "t0": ["end", -0.45]`): the segments come from the
 * take's `<take>.webclip.json`, measured from its own events, so a re-take
 * whose timing moved still cuts at the same moment of the action.
 * `<takes dir>` is flat (<take>.mov, <take>.webclip.json side by side).
 * Exits non-zero when a take or segment is missing, or a cut falls outside its take.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [heroPath, dir] = process.argv.slice(2);
if (!heroPath || !dir) { console.error('usage: heroSpec.mjs <hero-montage.json> <takes dir>'); process.exit(64); }
const hero = JSON.parse(readFileSync(heroPath, 'utf8'));
const fail = (m) => { console.error(`hero: ${m}`); process.exit(1); };

const specs = {};
const takeSpec = (take) => {
  if (specs[take]) return specs[take];
  const p = join(dir, `${take}.webclip.json`);
  if (!existsSync(join(dir, `${take}.mov`))) fail(`no take ${take}.mov in ${dir}`);
  if (!existsSync(p)) fail(`no ${take}.webclip.json in ${dir}`);
  const s = JSON.parse(readFileSync(p, 'utf8'));
  let movSeconds = null;
  try { movSeconds = JSON.parse(readFileSync(join(dir, `${take}.actions.json`), 'utf8')).durationSeconds; } catch { /* verify-less */ }
  specs[take] = { ...s, movSeconds };
  return specs[take];
};

const segments = hero.segments.map(({ take, seg, ...s }, i) => {
  const ts = takeSpec(take);
  let ref = null;
  if (seg != null) {
    ref = ts.segments.find((x, k) => x.label === seg || String(k) === String(seg));
    if (!ref) fail(`cut ${i} (${s.label}): ${take} has no segment "${seg}" (${ts.segments.map((x) => x.label ?? '-').join(', ')})`);
  }
  const at = (v, what) => {
    if (typeof v === 'number') return v;
    if (!Array.isArray(v) || !ref) fail(`cut ${i} (${s.label}): ${what} must be seconds, or [start|end, offset] with "seg"`);
    const [anchor, off = 0] = v;
    return (anchor === 'end' ? ref.t1 : ref.t0) + off;
  };
  const t0 = Number(at(s.t0, 't0').toFixed(3)), t1 = Number(at(s.t1, 't1').toFixed(3));
  if (!(t1 > t0 + 0.2)) fail(`cut ${i} (${s.label}): ${t0}..${t1} is empty`);
  if (t0 < 0 || (ts.movSeconds && t1 > ts.movSeconds)) fail(`cut ${i} (${s.label}): ${t0}..${t1} outside ${take} (0..${ts.movSeconds})`);
  return { ...s, t0, t1, src: `${take}.mov` };
});

const spec = { ...hero, segments };
delete spec.about;
let at = 0; spec.inspect = [];
for (const s of segments) { spec.inspect.push(Number((at + 0.15).toFixed(2)), Number((at + (s.t1 - s.t0) / 2).toFixed(2))); at += s.t1 - s.t0; }
spec.crop = segments[0].crop;
spec.durationSeconds = Number(at.toFixed(3));
console.error(`hero: ${segments.length} cuts, ${at.toFixed(2)} s: ${segments.map((s) => `${s.label} ${s.t0}-${s.t1}`).join(', ')}`);
process.stdout.write(JSON.stringify(spec, null, 2));
