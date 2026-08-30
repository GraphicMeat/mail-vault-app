import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoScenarios, collectStrings } from '../../scripts/screenshots/demoData.js';
import { LOCALES } from '../../scripts/screenshots/locales.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = (code) => resolve(HERE, `../../scripts/screenshots/demo/${code}.json`);
const read = (code) => JSON.parse(readFileSync(catalog(code), 'utf-8'));
const tags = (s) => (s.match(/<([a-z][a-z0-9]*)\b/gi) || []).map((t) => t.toLowerCase()).sort();

describe('demoScenarios', () => {
  it('returns the three demo accounts in sidebar order', () => {
    const { DEMO_ACCOUNTS } = demoScenarios('en');
    expect(DEMO_ACCOUNTS.map((a) => a.email)).toEqual([
      'rowan@primecut.studio',
      'rowan.marsh@gmail.com',
      'accounts@primecut.studio',
    ]);
  });

  it('exposes the five markers the capture script looks rows up by', () => {
    const { MARKERS } = demoScenarios('en');
    expect(Object.keys(MARKERS).sort())
      .toEqual(['invoice', 'newsletter', 'phishing', 'replyTo', 'thread']);
    expect(MARKERS.phishing).toMatch(/Action required/);
  });

  it('builds a fresh mailbox per call, so one locale cannot leak into the next', () => {
    const a = demoScenarios('en').DEMO_ACCOUNTS[0].scenario();
    const b = demoScenarios('en').DEMO_ACCOUNTS[0].scenario();
    expect(a).not.toBe(b);
    expect(a.state.mailboxes[0].messages.length)
      .toBe(b.state.mailboxes[0].messages.length);
  });

  it('falls back to English for a locale with no catalog', () => {
    expect(demoScenarios('xx-NONE').MARKERS).toEqual(demoScenarios('en').MARKERS);
  });

  it('translates through the catalog, subject and body alike', () => {
    const { MARKERS } = demoScenarios('en');
    expect(MARKERS.thread).toBe('Rack & Rind — launch campaign, round three');
  });
});

describe('demo catalog', () => {
  const en = read('en');

  it('holds every string the mailbox asks for, and nothing else', () => {
    expect(Object.keys(en).sort()).toEqual(collectStrings());
  });

  it('maps each English string to itself', () => {
    for (const [k, v] of Object.entries(en)) expect(v).toBe(k);
  });
});

describe('demo catalog parity', () => {
  const en = read('en');
  // Until a locale's catalog lands, the suite checks English against itself —
  // trivially true, but it keeps these three cases from vanishing silently.
  const translated = LOCALES.filter(({ app }) => existsSync(catalog(app)));
  const present = translated.length ? translated : [{ app: 'en' }];

  it.each(present)('$app has the same keys as English', ({ app }) => {
    expect(Object.keys(read(app)).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(present)('$app keeps every tag English uses', ({ app }) => {
    const loc = read(app);
    for (const [key, value] of Object.entries(en)) {
      expect(tags(loc[key]), `tags drifted in ${app}: ${key}`).toEqual(tags(value));
    }
  });

  it.each(present)('$app leaves the brands and filenames alone', ({ app }) => {
    const loc = read(app);
    for (const [key, value] of Object.entries(en)) {
      for (const brand of ['Prime Cut Studio', 'Rack & Rind', 'MeatPad', 'Brisket Sans']) {
        if (value.includes(brand)) {
          expect(loc[key], `${app} translated a brand in: ${key}`).toContain(brand);
        }
      }
      for (const file of value.match(/\b[\w-]+\.(pdf|png|zip)\b/g) || []) {
        expect(loc[key], `${app} translated a filename in: ${key}`).toContain(file);
      }
    }
  });
});
