import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Every native notification in the app goes through `notify` in focusStore, so
 * a focus session can hold it back. A second caller reaching for the raw invoke
 * is not a style problem — it is a notification that fires through the lock.
 *
 * Two files are allowed to say it: `services/api.js` owns the Tauri invoke, and
 * `stores/focusStore.js` is the one thing that calls it.
 */
const SRC = resolve(process.cwd(), 'src');
const ALLOWED_CALL = ['src/services/api.js', 'src/stores/focusStore.js'];
const ALLOWED_INVOKE = ['src/services/api.js'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(SRC).map(f => ({
  rel: f.slice(resolve(process.cwd()).length + 1),
  src: readFileSync(f, 'utf8'),
}));

describe('notify is the only way out', () => {
  it('has no caller of sendNotification() outside api.js and focusStore.js', () => {
    const offenders = files
      .filter(f => !ALLOWED_CALL.includes(f.rel) && /\bsendNotification\s*\(/.test(f.src))
      .map(f => `${f.rel} — call notify() from stores/focusStore.js instead`);
    expect(offenders).toEqual([]);
  });

  it('names the send_notification command in api.js and nowhere else', () => {
    const offenders = files
      .filter(f => !ALLOWED_INVOKE.includes(f.rel) && f.src.includes('send_notification'))
      .map(f => `${f.rel} — go through notify() rather than invoking the command`);
    expect(offenders).toEqual([]);
  });
});
