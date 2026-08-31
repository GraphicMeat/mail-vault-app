/**
 * Copy the safety alert screenshots into the app bundle.
 *
 *   node scripts/screenshots/bundle-safety-shots.mjs
 *
 * Settings → Security shows each warning next to a picture of the dialog it
 * opens, so those captures have to ship INSIDE the app rather than being fetched
 * from the website. This mirrors what was done by hand for the premium gallery,
 * as a script, because the one thing that goes wrong here is silent:
 *
 *   `website/screenshots/<dir>/` uses the WEBSITE's locale names (`zh`, `pt-br`)
 *   and `src/assets/safety/<app>/` uses the APP's (`zh-Hans`, `pt-BR`).
 *
 * Get that mapping wrong and `safetyShotUrl()` misses, falls back to English
 * forever, and every test stays green — so the remap comes from `locales.js`,
 * which already owns it, and is never spelled out again here.
 *
 * 1440 only, matching the premium bundle: 2880 doubles the app for a picture
 * shown at ~500px, and 720 is soft on a retina screen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOT_DIRS, appCode } from './locales.js';
import { SAFETY_ALERTS } from '../../src/data/safetyAlerts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FROM = path.join(ROOT, 'website', 'screenshots');
const TO = path.join(ROOT, 'src', 'assets', 'safety');

// Two alerts can share one capture; copy each file once.
//
// `premium-*` shots are excluded: they already ship under src/assets/premium/
// and `safetyShotUrl()` reads that bundle too. Copying them here as well was
// 492KB of byte-identical duplicates and a second copy to keep in step.
const SHOTS = [...new Set(SAFETY_ALERTS.map((a) => a.shot))].filter((s) => !s.startsWith('premium-'));

let copied = 0;
const missing = [];

for (const dir of SHOT_DIRS) {
  const src = dir === 'en' ? FROM : path.join(FROM, dir);
  const dest = path.join(TO, appCode(dir));
  fs.mkdirSync(dest, { recursive: true });

  for (const shot of SHOTS) {
    const file = `${shot}-1440.webp`;
    const from = path.join(src, file);
    if (!fs.existsSync(from)) { missing.push(`${dir}/${file}`); continue; }
    fs.copyFileSync(from, path.join(dest, file));
    copied++;
  }
}

const expected = SHOT_DIRS.length * SHOTS.length;
console.log(`safety shots: ${copied}/${expected} copied into src/assets/safety/`);
console.log(`  ${SHOTS.length} shot(s) x ${SHOT_DIRS.length} locale(s): ${SHOTS.join(', ')}`);

if (missing.length) {
  // Loud, not silent: a missing capture degrades to the English image at
  // runtime, which looks like a working localized build.
  console.error(`\nMISSING ${missing.length} capture(s) — run scripts/screenshots/run-all.sh for these locales:`);
  for (const m of missing) console.error(`  ${m}`);
  process.exitCode = 1;
}
