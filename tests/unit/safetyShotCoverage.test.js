/**
 * The safety captures have to exist, in every locale, under the APP's locale
 * code — and a miss is silent: `safetyShotUrl()` falls back to English, the page
 * renders, and every other test stays green while eight locales quietly show an
 * English screenshot.
 *
 * So this asserts the files on disk rather than anything the app computes.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { SAFETY_ALERTS } from '../../src/data/safetyAlerts.js';
import { SHOT_DIRS, appCode } from '../../scripts/screenshots/locales.js';

const SHOTS = [...new Set(SAFETY_ALERTS.map((a) => a.shot))];
// A `premium-*` capture already ships under src/assets/premium/ and is read
// from there — bundling it under safety/ too was 492KB of identical files.
const dirFor = (shot) => (shot.startsWith('premium-') ? 'premium' : 'safety');

describe('safety shot coverage', () => {
  it('names a capture for every alert, deduplicated', () => {
    expect(SHOTS.length).toBeGreaterThan(0);
    for (const a of SAFETY_ALERTS) expect(SHOTS, a.id).toContain(a.shot);
  });

  // The trap the bundling script exists to avoid: website dirs are `zh`/`pt-br`,
  // app codes are `zh-Hans`/`pt-BR`.
  it('maps every website locale directory to an app locale code', () => {
    expect(SHOT_DIRS).toContain('zh');
    expect(SHOT_DIRS).toContain('pt-br');
    expect(appCode('zh')).toBe('zh-Hans');
    expect(appCode('pt-br')).toBe('pt-BR');
    expect(appCode('en')).toBe('en');
  });

  it.each(SHOT_DIRS)('bundles every safety shot for %s', (dir) => {
    const app = appCode(dir);
    for (const shot of SHOTS) {
      const p = `src/assets/${dirFor(shot)}/${app}/${shot}-1440.webp`;
      expect(existsSync(p), `${p} missing — run scripts/screenshots/bundle-safety-shots.mjs`).toBe(true);
    }
  });

  // The dedupe only works while the resolver reads BOTH bundles; if it ever
  // stops, every tracker alert silently loses its picture.
  it('resolves premium captures from the premium bundle, not a second copy', () => {
    const src = readFileSync('src/components/onboarding/safetyShots.js', 'utf-8');
    expect(src).toContain('assets/premium/*/*-1440.webp');
    expect(src).toContain('assets/safety/*/*-1440.webp');
    for (const dir of SHOT_DIRS) {
      const dupe = `src/assets/safety/${appCode(dir)}/premium-tracker-blocking-1440.webp`;
      expect(existsSync(dupe), `${dupe} is a duplicate of the premium bundle`).toBe(false);
    }
  });

  // A zero-byte or HTML-error file passes existsSync and renders as a broken
  // image. webp files start with the RIFF magic.
  it.each(SHOT_DIRS)('ships a real webp for %s, not a placeholder', (dir) => {
    for (const shot of SHOTS) {
      const buf = readFileSync(`src/assets/${dirFor(shot)}/${appCode(dir)}/${shot}-1440.webp`);
      expect(buf.length, `${dir}/${shot}`).toBeGreaterThan(2000);
      expect(buf.subarray(0, 4).toString('ascii'), `${dir}/${shot}`).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('ascii'), `${dir}/${shot}`).toBe('WEBP');
    }
  });

  it('bundles nothing the catalog does not ask for', () => {
    const want = SHOTS.filter((s) => dirFor(s) === 'safety').map((s) => `${s}-1440.webp`);
    for (const dir of SHOT_DIRS) {
      const d = `src/assets/safety/${appCode(dir)}`;
      const extra = readdirSync(d).filter((f) => !want.includes(f));
      expect(extra, `${d} has files no alert references`).toEqual([]);
    }
  });

  // The capture steps are what produce the two new files; a renamed step would
  // leave the catalog pointing at a shot nothing shoots.
  it('has a capture step for each shot the catalog invented', () => {
    const shots = readFileSync('scripts/screenshots/shots.js', 'utf-8');
    for (const s of ['safety-sender-impersonation', 'safety-reply-to-modal']) {
      expect(shots, s).toContain(`step('${s}'`);
    }
  });
});
