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
