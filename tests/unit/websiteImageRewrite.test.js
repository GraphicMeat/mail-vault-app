import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteSrcset, localizeShot, LOCALES } from '../../website/i18n/i18n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const de = LOCALES.find((l) => l.dir === 'de');
const SHOT_DIR = resolve(HERE, '../../website/screenshots/de');
const FIXTURE = resolve(SHOT_DIR, 'email-list-view-1440.webp');
let madeDir = false;
let madeFile = false;

beforeAll(() => {
  // localizeShot answers from the file system, so the locale shot has to exist.
  // An empty file is enough — the check is existence, not pixels.
  if (!existsSync(SHOT_DIR)) { mkdirSync(SHOT_DIR, { recursive: true }); madeDir = true; }
  if (!existsSync(FIXTURE)) { writeFileSync(FIXTURE, ''); madeFile = true; }
});

afterAll(() => {
  if (madeFile) rmSync(FIXTURE, { force: true });
  if (madeDir) rmSync(SHOT_DIR, { recursive: true, force: true });
});

describe('rewriteSrcset', () => {
  it('absolutizes every candidate and keeps its descriptor', () => {
    const out = rewriteSrcset(
      'screenshots/nope-720.webp 720w, screenshots/nope-1440.webp 1440w',
      'index.html', de,
    );
    expect(out).toBe('/screenshots/nope-720.webp 720w, /screenshots/nope-1440.webp 1440w');
  });

  it('leaves an absolute URL alone', () => {
    expect(rewriteSrcset('https://cdn.example/a.webp 2x', 'index.html', de))
      .toBe('https://cdn.example/a.webp 2x');
  });

  it('handles a candidate with no descriptor', () => {
    expect(rewriteSrcset('screenshots/nope.webp', 'index.html', de)).toBe('/screenshots/nope.webp');
  });

  it('routes a candidate to the locale when that shot exists', () => {
    expect(rewriteSrcset('screenshots/email-list-view-1440.webp 1440w', 'index.html', de))
      .toBe('/screenshots/de/email-list-view-1440.webp 1440w');
  });
});

describe('localizeShot', () => {
  it('redirects to the locale directory when that file exists', () => {
    expect(localizeShot('/screenshots/email-list-view-1440.webp', de))
      .toBe('/screenshots/de/email-list-view-1440.webp');
  });

  it('keeps English when the locale has no such shot', () => {
    expect(localizeShot('/screenshots/does-not-exist-1440.webp', de))
      .toBe('/screenshots/does-not-exist-1440.webp');
  });

  it('ignores a path that is not a screenshot', () => {
    expect(localizeShot('/assets/logo.svg', de)).toBe('/assets/logo.svg');
  });

  it('does not re-localize a path already in the locale directory', () => {
    expect(localizeShot('/screenshots/de/email-list-view-1440.webp', de))
      .toBe('/screenshots/de/email-list-view-1440.webp');
  });
});
