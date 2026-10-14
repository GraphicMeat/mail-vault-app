import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { isApproved, isValidKnownDiff, COLOR_FIELDS, BORDER_WIDTH_FIELDS } from '../compare';

const CORPUS = new URL('../../../../../tests/fixtures/blitz-corpus/', import.meta.url);
const read = (p) => readFileSync(new URL(p, CORPUS), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const known = JSON.parse(read('known-diffs.json'));
const FIELDS = new Set(['*', 'presence', 'rendered', ...COLOR_FIELDS, ...BORDER_WIDTH_FIELDS, 'fontSize', 'fontWeight', 'x', 'y', 'w', 'h', 'lineCount']);

describe('blitz corpus', () => {
  it('every fixture exists, ids are unique, and every source ships its licence', () => {
    const ids = manifest.fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of manifest.fixtures) {
      expect(existsSync(new URL(f.file, CORPUS))).toBe(true);
      if (f.source !== 'ours') {
        const src = manifest.sources[f.source];
        expect(src?.spdx).toBe('MIT');
        expect(existsSync(new URL(src.license, CORPUS))).toBe(true);
        expect(src.commit).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it('no fixture folds, phones home or loads a web font', () => {
    for (const f of manifest.fixtures) {
      const html = read(f.file);
      expect(html).not.toMatch(/<blockquote|gmail_quote|moz-cite-prefix|^-- $/im);
      expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
      expect(html.match(/(?:src|background|href)\s*=\s*["']https?:\/\/(?![^"']*\.invalid\/)[^"']+\.(?:png|jpe?g|gif|webp)/gi) || []).toEqual([]);
    }
  });

  it('no rewritten url() cuts the style attribute that holds it', () => {
    for (const f of manifest.fixtures) {
      expect(read(f.file).match(/\sstyle\s*=\s*"[^"]*url\(\s*"/gi) || []).toEqual([]);
    }
  });

  it('every known diff names a corpus fixture and a real field, and is approved by Rokas', () => {
    expect(known.version).toBe(1);
    const ids = new Set(manifest.fixtures.map((f) => f.id));
    for (const e of known.entries) {
      expect(ids.has(e.fixture)).toBe(true);
      expect(['light', 'dark', '*']).toContain(e.mode);
      expect(['wide', 375, '*']).toContain(e.width);
      expect(FIELDS.has(e.field)).toBe(true);
      expect(isValidKnownDiff(e)).toBe(true);
      expect(isApproved(e)).toBe(true);
    }
  });
});
