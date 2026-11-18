// No dead settings: every phone preference (PREF_DEFAULTS) changes something. A key counts as read
// when phone code outside the settings pages and prefs.js reads it (`x.key` or a 'key' string),
// or when a prefs.js helper that reads it is used by such code (applyLook, markReadPlan, ...).
// A key only the engine or the shell acts on is listed in ENGINE_READ and must be read there
// (outside the PREFS table and the desktop import mapping).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PREF_DEFAULTS } from '../prefs.js';

const ROOT = resolve(process.cwd(), 'src/mobile');
// Where a key is set or merely listed, not acted on.
const NOT_READERS = new Set(['prefs.js', 'SettingsPrefs.jsx', 'Settings.jsx']);
// The settings containers (src/mobile/settings/) set the preferences too.
const NOT_READER_DIRS = ['settings/'];

// Acted on by the engine or the shell, not by the page:
const ENGINE_READ = {
  // Premium strips tracking pixels while it is on (settings.rs `tracker_blocking_on`, body.rs).
  trackerBlockingEnabled: true,
  // The background run's `sound` (settings.rs `notification_sound`, the shell's background.rs).
  notificationSound: true,
  // The background run's `badge` (settings.rs `badge_count`).
  badgeEnabled: true,
  badgeMode: true,
};

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'fixtures' ? [] : files(path);
    return /\.(jsx?|mjs)$/.test(name) ? [path] : [];
  });
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const reads = (src, key) => new RegExp(`(\\.|['"\`])${key}\\b`).test(src);

const readers = files(ROOT)
  .filter((p) => !NOT_READERS.has(relative(ROOT, p)) && !NOT_READER_DIRS.some((d) => relative(ROOT, p).startsWith(d)))
  .map((p) => ({ path: relative(ROOT, p), src: stripComments(readFileSync(p, 'utf8')) }));

/** prefs.js's exported functions (`function` or arrow), each with its body. */
function helpers() {
  const src = stripComments(readFileSync(join(ROOT, 'prefs.js'), 'utf8'));
  const starts = [...src.matchAll(/^export (?:function|const) (\w+)/gm)];
  return starts
    .map((m, i) => ({ name: m[1], body: src.slice(m.index, starts[i + 1]?.index ?? src.length) }))
    // Functions only: a list such as PREF_DEFAULTS names every key and reads none.
    .filter((h) => h.name !== h.name.toUpperCase());
}

function engineSource() {
  const dir = resolve(process.cwd(), 'src-mobile-engine/src');
  const shell = resolve(process.cwd(), 'src-tauri-mobile/src');
  return [dir, shell]
    .flatMap((d) => readdirSync(d).filter((n) => n.endsWith('.rs') && n !== 'transfer.rs').map((n) => readFileSync(join(d, n), 'utf8')))
    .join('\n')
    // The PREFS table lists every key: a listing is not a reader.
    .replace(/^\s*\("\w+", Kind::.*$/gm, '');
}

describe('every phone preference has a reader', () => {
  const used = helpers().filter((h) => readers.some((r) => new RegExp(`\\b${h.name}\\b`).test(r.src)));
  const engine = engineSource();

  for (const key of Object.keys(PREF_DEFAULTS)) {
    it(key, () => {
      if (ENGINE_READ[key]) {
        expect(engine.includes(`"${key}"`), `${key}: no engine reader`).toBe(true);
        return;
      }
      const direct = readers.filter((r) => reads(r.src, key)).map((r) => r.path);
      const viaHelper = used.filter((h) => reads(h.body, key)).map((h) => `prefs.js ${h.name}`);
      expect([...direct, ...viaHelper], `${key} is read nowhere on the phone`).not.toEqual([]);
    });
  }

  it('the guard sees a key nobody reads', () => {
    expect(readers.some((r) => reads(r.src, 'noSuchPreference'))).toBe(false);
  });
});
