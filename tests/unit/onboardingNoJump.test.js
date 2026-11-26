/**
 * Onboarding and the mail-arrival screen jumped (2026-09-28): steps were
 * vertically centred, so every tab or choice that changed the height moved the
 * title; the Colors tab's scrollbar shifted everything sideways; and the flying
 * hearts and envelopes added scroll range while they flew. jsdom cannot lay
 * out, so these pin the rules that prevent each one.
 */
import { describe, it, expect } from 'vitest';
import { readStyleSheet } from '../../src/styles/__tests__/readStyleSheet.js';
import postcss from 'postcss';

const css = readStyleSheet(new URL('../../src/styles/index.css', import.meta.url));

function decls(selector) {
  const out = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent?.type === 'atrule') return;
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((d) => { out[d.prop] = d.value; });
  });
  return out;
}

describe('onboarding layout stability', () => {
  // 2026-11-26: no onboarding screen scrolls at all. The page is the window,
  // so there is no scrollbar to shift anything and no gutter to reserve.
  it('never scrolls the page: each step is built to fit the window', () => {
    expect(decls('.onboarding-page').overflow).toBe('hidden');
    expect(decls('.onboarding-page').height).toBe('100dvh');
    expect(decls('.onboarding-screen-body').overflow).toBe('hidden');
  });

  it('pins the heading and the footer, so a tab or a choice never moves the title or Continue', () => {
    expect(decls('.onboarding-screen-heading')['flex-shrink']).toBe('0');
    expect(decls('.onboarding-footer')['flex-shrink']).toBe('0');
    expect(decls('.onboarding-screen-body').flex).toBe('1');
  });

  it('clips the thank-you hearts instead of scrolling sideways', () => {
    expect(decls('.onboarding-content').overflow).toBe('clip');
  });

  it('clips the arrival envelopes vertically and keeps its gutter', () => {
    expect(decls('.mail-arrival-content')['overflow-y']).toBe('clip');
    // A capped band clipped the envelopes well inside a tall window.
    expect(decls('.mail-arrival-content')['min-height']).toBe('calc(100dvh - 72px)');
    expect(decls('.mail-arrival')['scrollbar-gutter']).toBe('stable');
  });
});

// "Expandable" rendered as "Expandab / le" in a narrow column, and the same in
// es, it, pt-BR, fr, de and ja (2026-09-28): a button could shrink below its
// longest word. Now a choice that does not fit moves to the next row.
describe('onboarding choice labels', () => {
  it('wraps choices to a new row instead of breaking a word', () => {
    expect(decls('.onboarding-choices')['flex-wrap']).toBe('wrap');
    const button = decls('.onboarding-choices button');
    expect(button['min-width']).toBeUndefined();
    expect(button['max-width']).toBe('100%');
    expect(button['overflow-wrap']).toBe('break-word');
    expect(button['word-break']).toBe('keep-all');
  });
});
