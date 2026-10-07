import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The list toolbar is one row at every list width. Labelled, its controls need
// about 600px; below that the labels are hidden (kept for assistive tech) so
// the same controls fit down to a narrow list, instead of wrapping a second
// row in, then out of, existence as a click adds or removes a control.
const css = readFileSync('src/styles/index.css', 'utf8');
const rule = (selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} in index.css`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
};
const compactBlock = () => {
  const start = css.search(/@container mail-list \(max-width: [6]\d\dpx\) \{/);
  expect(start, 'a compact @container mail-list block between 600px and 699px').toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open, i);
  }
  throw new Error('unterminated @container block');
};

describe('list toolbar labels', () => {
  it('are hidden visually, never removed from the accessibility tree, in a narrow list', () => {
    const block = compactBlock();
    const start = block.indexOf('.mail-toolbar-label {');
    expect(start, '.mail-toolbar-label rule in the compact block').toBeGreaterThan(-1);
    const label = block.slice(start, block.indexOf('}', start));
    expect(label).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(label).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });
});

// Icon-only, the controls need ~342px and the list pane can be dragged to
// 300px. Between those the row would wrap by a few pixels at a time, so the
// thread select drops to a row of its own for the whole narrow range, and the
// height is then the same whatever a click does.
describe('the thread select in the narrowest list', () => {
  it('takes its own row from a width that still fits the icon-only controls', () => {
    const at = css.search(/\.mail-thread-select \{ order: 1;/);
    expect(at, 'the select-on-its-own-row rule').toBeGreaterThan(-1);
    const opener = css.lastIndexOf('@container mail-list', at);
    const width = Number(css.slice(opener, at).match(/max-width: (\d+)px/)?.[1]);
    expect(width).toBeGreaterThanOrEqual(350);
  });
});

// A labelled button is 28px tall (one line of 12px text plus padding); an
// icon-only one was 26px, so the row changed height at the width the labels go.
describe('the list/explorer switch', () => {
  it('is as tall with its labels hidden as with them shown', () => {
    const explorer = readFileSync('src/styles/explorer.css', 'utf8');
    const start = explorer.indexOf('.mail-list-view-switch .mail-toolbar-button {');
    expect(start, 'switch button rule in explorer.css').toBeGreaterThan(-1);
    const height = Number(explorer.slice(start, explorer.indexOf('}', start)).match(/min-height:\s*(\d+)px/)?.[1]);
    expect(height).toBeGreaterThanOrEqual(28);
  });
});

describe('a toolbar button that cannot act', () => {
  it('is dimmed and does not answer the pointer', () => {
    expect(rule('.mail-toolbar-button:disabled')).toMatch(/opacity:\s*0?\.[34]/);
    expect(css).toContain('.mail-toolbar-button:hover:not(:disabled)');
    expect(css).not.toMatch(/\.mail-toolbar-button:hover \{/);
  });
});
