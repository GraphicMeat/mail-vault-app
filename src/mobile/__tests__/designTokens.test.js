// @vitest-environment node
// The phone's own rules (mobile.css, not the shared settings views) hold to DESIGN.md: white text
// sits on `accent-fill`, never `accent`; corners come from the radius scale; nothing is lifted by
// a shadow; unread is the surface ground; toolbar tools are desktop's muted ghost tools; the
// drawer's active folder is desktop's accent tint.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../mobile.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** [selector, body] of every rule; @media blocks are flattened. */
const rules = [...css.replace(/@media[^{]*\{/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
const own = rules.filter(([sel]) => !sel.includes('.mv-shared-ui'));
const body = (selector) => rules.filter(([sel]) => sel === selector).map(([, b]) => b).join(';');

describe('the phone follows the design system', () => {
  it('white text on a fill uses accent-fill', () => {
    const offenders = own.filter(([, b]) => /color:\s*#fff\b/.test(b) && /background:\s*var\(--mail-accent\)/.test(b)).map(([s]) => s);
    expect(offenders).toEqual([]);
    // The primary buttons are desktop's Button (`primary`: bg-mail-accent-fill), phoneButtons.test.js.
    for (const sel of ['.mv-fab', '.mv-avatar', '.mv-avatar--all', '.mv-swipe__act--move']) {
      expect(body(sel), sel).toMatch(/background: var\(--mail-accent-fill\)/);
    }
    expect(body(".mv-search__chip[aria-pressed='true'] .mv-search__chip-face")).toMatch(/background: var\(--mail-accent-fill\)/);
  });

  it('corners come from the scale: 8px controls, 12px containers, 16px only for the sheet and the compose button, pills for state', () => {
    const allowed = new Set(['0', '8px', '12px', '50%', '999px', '16px 16px 0 0']);
    const off = [];
    for (const [sel, b] of own) {
      for (const m of b.matchAll(/border-radius:\s*([^;]+);?/g)) {
        const v = m[1].trim();
        if (allowed.has(v)) continue;
        if (v === '16px' && sel === '.mv-fab') continue;
        if (v === '2px' && sel === '.mv-sheet__grip') continue; // the grip bar, not a control
        if (v === '20px' && sel === '.mv-import-scan__frame') continue; // the camera's viewfinder
        off.push(`${sel}: ${v}`);
      }
    }
    expect(off).toEqual([]);
  });

  it('the toast and the compose button separate by tone, not shadow', () => {
    expect(body('.mv-toast')).not.toMatch(/box-shadow/);
    expect(body('.mv-fab')).not.toMatch(/box-shadow/);
  });

  it('an unread row is the surface ground, without the accent edge, and still shows a press', () => {
    expect(body('.mv-row--unread')).toMatch(/background: var\(--mail-surface\)/);
    expect(body('.mv-row--unread')).not.toMatch(/box-shadow/);
    expect(body('.mv-row:active')).toMatch(/background: var\(--mail-surface-hover\)/);
  });

  it('viewer tools are muted at rest and full text while pressed; flag and danger keep their colours', () => {
    expect(body('.mv-tool')).toMatch(/color: var\(--mail-text-muted\)/);
    expect(body('.mv-tool:active')).toMatch(/background: var\(--mail-surface-hover\)/);
    expect(body('.mv-tool:active:not(.mv-tool--danger):not([aria-pressed="true"])')).toMatch(/color: var\(--mail-text\)/);
    expect(body('.mv-tool[aria-pressed="true"]')).toMatch(/color: var\(--mv-flag\)/);
    expect(body('.mv-tool--danger')).toMatch(/color: var\(--mv-danger\)/);
  });

  it("the drawer's active folder is desktop's accent tint with the accent text", () => {
    const b = body('.mv-folder--active');
    expect(b).toMatch(/color: var\(--mail-accent-text\)/);
    expect(b).toMatch(/color-mix\(in srgb, var\(--mail-accent\) 10%, transparent\)/);
    expect(b).not.toMatch(/box-shadow/);
  });

  it("search's scope chips are desktop's chip inside a 44px hit area", () => {
    const hit = body('.mv-search__chip');
    expect(hit).toMatch(/min-height: 44px/);
    expect(hit).toMatch(/background: none/);
    expect(hit).not.toMatch(/border-radius|border: 1px/);
    const face = body('.mv-search__chip-face');
    expect(face).toMatch(/padding: 4px 12px/);
    expect(face).toMatch(/border: 1px solid var\(--mail-border\)/);
    expect(face).toMatch(/border-radius: 999px/);
    expect(face).toMatch(/background: transparent/);
    expect(face).toMatch(/font-size: 0\.8125rem/);
    expect(face).toMatch(/font-weight: 500/);
    const pressed = body(".mv-search__chip[aria-pressed='true'] .mv-search__chip-face");
    expect(pressed).toMatch(/background: var\(--mail-accent-fill\)/);
    expect(pressed).toMatch(/border-color: var\(--mail-accent-fill\)/);
    expect(pressed).toMatch(/color: #fff/);
    const search = readFileSync(new URL('../Search.jsx', import.meta.url), 'utf8');
    expect(search.match(/className="mv-search__chip"[^>]*>\s*<span className="mv-search__chip-face">/g)?.length).toBe(2);
  });
});
