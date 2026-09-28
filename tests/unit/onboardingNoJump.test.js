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
