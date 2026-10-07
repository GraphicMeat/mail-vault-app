import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// House rule: no em dashes in visible copy. The Time Capsule header
// ("Snapshot — date") had to be cropped out of a website clip because of one.
// U+2015 and the two- and three-em dashes read the same, so they count too.
const DASH = /[—―⸺⸻]/;

const LOCALES = resolve(process.cwd(), 'src/i18n/locales');
const catalogs = readdirSync(LOCALES)
  .filter(name => name.endsWith('.json') && name !== 'IDENTICAL_OK.json')
  .map(name => [name, JSON.parse(readFileSync(join(LOCALES, name), 'utf8'))]);

// Mail the export preview renders as sample content, not app copy. Its
// subjects mirror the demo inbox, which keeps realistic sender punctuation.
const MAIL_CONTENT = /^util\.exportSampleData\./;

describe('locale catalogs', () => {
  it('hold no em dash in any value', () => {
    for (const [name, catalog] of catalogs) {
      const hits = Object.entries(catalog)
        .filter(([key, value]) => !MAIL_CONTENT.test(key) && DASH.test(String(value)))
        .map(([key]) => key);
      expect(hits, name).toEqual([]);
    }
  });

  // A doubled escape in the JSON source ("\\u2026", "\\n") parses to a
  // literal backslash, so the Settings shortcut chip read "Press key…"
  // and error alerts read "...try again.\n\nDetails:" on one line.
  it('hold no literal backslash escape in any value', () => {
    for (const [name, catalog] of catalogs) {
      const hits = Object.entries(catalog)
        .filter(([, value]) => /\\[nu]/.test(String(value)))
        .map(([key]) => key);
      expect(hits, name).toEqual([]);
    }
  });
});

// Visible strings hardcoded in components, utils, data and App, and the one
// service message the backup UI shows verbatim. Comments and console output
// are not visible copy.
describe('hardcoded UI copy', () => {
  const ROOT = resolve(process.cwd(), 'src');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(path);
    return /\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name) ? [path] : [];
  });
  const files = [
    ...walk(join(ROOT, 'components')),
    // exportSampleData.js is sample mail, the same exemption as MAIL_CONTENT.
    ...walk(join(ROOT, 'utils')).filter(file => !file.endsWith('exportSampleData.js')),
    ...walk(join(ROOT, 'data')),
    join(ROOT, 'App.jsx'),
    join(ROOT, 'services/authUtils.js'),
  ];
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

  it('holds no em dash outside comments and console output', () => {
    const hits = [];
    for (const file of files) {
      stripComments(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
        if (/\bconsole\.\w+\(/.test(line)) return;
        if (DASH.test(line) || /\\u(2014|2015)/i.test(line)) {
          hits.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
