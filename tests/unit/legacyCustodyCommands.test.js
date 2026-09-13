/**
 * The JS half of the Rust guard in src-core/tests/legacy_custody_files.rs: no
 * app source names a legacy custody file and nothing invokes the archived-cache
 * commands the store retired. A writer left on the old format is how v2.5.0
 * produced four months of misnamed vault files.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const REMOVED = ['maildir_read_archived_cached', 'maildir_save_archived_cache'];
const LITERALS = ['local-index.json', 'archived_headers.json'];
const SELF = basename(new URL(import.meta.url).pathname);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); }
    else if (/\.(js|jsx)$/.test(name) && name !== SELF) out.push(p);
  }
  return out;
};
const isTest = (p) => /__tests__|\.test\.jsx?$/.test(p);

describe('legacy custody files', () => {
  it('no source or spec invokes the removed archived-cache commands', () => {
    const files = [...walk('src'), ...walk('tests')];
    expect(files.length).toBeGreaterThan(50); // a walk that found nothing would pass for nothing
    const hits = files.filter((p) => REMOVED.some((c) => readFileSync(p, 'utf8').includes(`'${c}'`)));
    expect(hits).toEqual([]);
  });
  it('no app source names a legacy custody file', () => {
    const hits = walk('src').filter((p) => !isTest(p) && LITERALS.some((l) => readFileSync(p, 'utf8').includes(l)));
    expect(hits).toEqual([]);
  });
});
