import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../../scripts/screenshots/shots.js'), 'utf-8');

/**
 * A `browser.execute` callback is serialised and run in the PAGE. Anything it
 * closes over in this process — the label resolver, the demo markers — is
 * simply absent there, and WebDriver reports it as "Can't find variable: L",
 * retrying for ten seconds per call until the whole run times out with no shot
 * taken and nothing in the spec output naming the cause.
 *
 * Values have to arrive as arguments. This scans for the mistake instead of
 * waiting ten minutes to be told about it.
 */
function pageClosures(src) {
  const lines = src.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('browser.execute(')) continue;
    let brace = 0;
    let started = false;
    const body = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]);
      brace += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (lines[j].includes('{')) started = true;
      if (started && brace <= 0) break;
    }
    const text = body.join('\n');
    const inner = text.slice(0, text.lastIndexOf('}'));
    for (const token of ['L(', 'MARKERS', 'THREAD_NEEDLE']) {
      if (inner.includes(token)) found.push(`line ${i + 1}: ${token}`);
    }
  }
  return found;
}

/**
 * Assertions are the half that got missed. Every *click* was converted to a
 * catalog label, and the run still lost nine shots per locale — because the
 * checks that follow the clicks still matched English on screen:
 * `hasText('Bulk Email Operations')`, `/Operation Complete/i.test(s.text)`,
 * `/storage/i.test(s.text)`. A finder that misses is loud; an assertion that
 * misses is a SKIPPED line blaming the screen.
 */
function englishAssertions(src) {
  const found = [];
  for (const m of src.matchAll(/hasText\(\s*'([^']+)'/g)) found.push(`hasText('${m[1]}')`);
  for (const m of src.matchAll(/\/([^/\n]{3,})\/i\.test\(\s*s\.text\s*\)/g)) found.push(`/${m[1]}/i.test(s.text)`);
  return found;
}

describe('shots.js assertions', () => {
  it('asserts on catalog strings, never on English text', () => {
    expect(englishAssertions(SRC)).toEqual([]);
  });

  it('recognises both offending shapes', () => {
    expect(englishAssertions("await expectState(hasText('Bulk Email Operations'), 'x');"))
      .toEqual(["hasText('Bulk Email Operations')"]);
    expect(englishAssertions('if (/Operation Complete/i.test(s.text)) {}'))
      .toEqual(['/Operation Complete/i.test(s.text)']);
  });
});

describe('shots.js page callbacks', () => {
  it('never reaches for a host-side value inside a browser.execute body', () => {
    expect(pageClosures(SRC)).toEqual([]);
  });

  it('detects the mistake when it is there', () => {
    const bad = `
      const x = browser.execute(() => {
        return { viewerEmpty: text.includes(L('viewer.selectEmailRead')) };
      });
    `;
    expect(pageClosures(bad)).toEqual(['line 2: L(']);
  });
});
