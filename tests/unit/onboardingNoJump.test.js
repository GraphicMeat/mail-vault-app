/**
 * Onboarding and the mail-arrival screen jumped (2026-09-28): steps were
 * vertically centred, so every tab or choice that changed the height moved the
 * title; the Colors tab's scrollbar shifted everything sideways; and the flying
 * hearts and envelopes added scroll range while they flew. jsdom cannot lay
 * out, so these pin the rules that prevent each one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const css = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8');

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
  it('reserves the scrollbar gutter so a scrolling tab does not shift the others', () => {
    expect(decls('.onboarding-page')['scrollbar-gutter']).toBe('stable');
  });

  it('starts steps at the top and centres only the splash and thank-you', () => {
    expect(decls('.onboarding-step')['align-items']).toBe('flex-start');
    expect(decls('.onboarding-step-splash')['align-items']).toBe('center');
    expect(decls('.onboarding-step-cta')['align-items']).toBe('center');
  });

  it('clips the thank-you hearts instead of scrolling sideways', () => {
    expect(decls('.onboarding-content:has(> .onboarding-step-cta)').overflow).toBe('clip');
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
