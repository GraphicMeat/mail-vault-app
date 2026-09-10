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
  const found = [];
  const CALL = 'browser.execute(';
  for (let at = src.indexOf(CALL); at !== -1; at = src.indexOf(CALL, at + 1)) {
    // Walk to the call's own closing paren. A brace counter cannot find the
    // end of `browser.execute(() => el?.click())` — there is no brace to
    // count — so it reads on into the next block and reports whatever it
    // finds there against this line.
    let depth = 1;
    let i = at + CALL.length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    // Only the callback is serialised; the arguments after it are host-side by
    // design and `L(...)` is exactly how a label is meant to reach the page.
    const args = src.slice(at + CALL.length, i - 1);
    const brace = args.lastIndexOf('}');
    const body = brace === -1 ? args : args.slice(0, brace);
    const line = src.slice(0, at).split('\n').length;
    for (const token of ['L(', 'MARKERS', 'THREAD_NEEDLE']) {
      if (body.includes(token)) found.push(`line ${line}: ${token}`);
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

  it('never derives an on-screen string by deleting placeholders', () => {
    // `{{n}} emails selected` survives that trick; `已选择 {{n}} 封邮件` does
    // not — it collapses to a double space where the number belongs. Take the
    // longest literal run between placeholders instead.
    expect(SRC).not.toMatch(/replace\(\/\\\{\\\{[^)]*\)\s*\.trim\(\)/);
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

  // The shape that broke the scan: no braces to count, so the body ends at the
  // call's closing paren or nowhere.
  it('reads a brace-less callback, and reads no further than it', () => {
    expect(pageClosures("await browser.execute(() => document.title = L('x'));"))
      .toEqual(['line 1: L(']);
    expect(pageClosures([
      "await browser.execute(() => document.querySelector('[data-testid=\"x\"]')?.click());",
      'await expectState((s) => s.text.includes(L(\'settings.colors.palette\')));',
    ].join('\n'))).toEqual([]);
  });
});
