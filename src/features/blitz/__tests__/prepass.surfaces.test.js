// @vitest-environment jsdom
//
// Two pre-pass rules the non-reader surfaces depend on, with the REAL privacy
// module: a surface that injects no fold scripts folds nothing (F10), and a
// documentHtml that carries the iframe's privacy gate loses it when privacy is
// off, as it does inside the iframe once a peek releases it (F11).
import { describe, it, expect } from 'vitest';
import { runPrepass } from '../prepass';
import { PRIVACY_GATE_ID, PRIVACY_GATE_CSS } from '../../../utils/emailIframeTemplate';

const SIG = '<div class="gmail_signature">-- <br>Alice, Acme</div>';
const QUOTE = '<blockquote><p>Quoted text</p></blockquote>';
const body = `<p>Reply.</p>${QUOTE}${SIG}`;
const base = { bodyHtml: body, theme: { dark: false } };
const off = { privacy: { active: false, dict: null }, openFolds: new Set() };

describe('foldQuotes === false: the surface injects no fold scripts (F10)', () => {
  it('marks no quote and no signature fold, even with the default signatureDisplay', async () => {
    const { html, doc } = await runPrepass({ ...base, foldQuotes: false }, off);
    expect(doc.querySelector('[data-mv-fold]')).toBeNull();
    expect(doc.querySelector('[data-mv-fold-toggle]')).toBeNull();
    expect(html).not.toContain('data-mv-fold');
    expect(doc.querySelector('blockquote').style.display).toBe('');
    expect(doc.querySelector('.gmail_signature').style.display).toBe('');
  });

  it('still strips handles the mail wrote itself', async () => {
    const own = '<p data-mv-fold="q0" data-mv-fold-toggle="q0" style="display:none">Mine</p>';
    const { html } = await runPrepass({ ...base, bodyHtml: own, foldQuotes: false }, off);
    expect(html).toContain('Mine');
    expect(html).not.toContain('data-mv-fold');
  });

  it('a surface that folds (foldQuotes true or unset) still gets both folds', async () => {
    for (const foldQuotes of [true, undefined]) {
      const { doc } = await runPrepass({ ...base, foldQuotes }, off);
      expect(doc.querySelector('[data-mv-fold="q0"]')).not.toBeNull();
      expect(doc.querySelector('[data-mv-fold="s0"]')).not.toBeNull();
    }
  });
});

describe('a documentHtml carrying the iframe privacy gate (F11)', () => {
  const gated = `<!DOCTYPE html><html style="opacity:0!important"><head><style id="${PRIVACY_GATE_ID}">${PRIVACY_GATE_CSS}</style></head><body><p>Hello</p></body></html>`;

  it('privacy off (a peek): the gate comes off, the body is drawn', async () => {
    const { html, doc } = await runPrepass({ ...base, documentHtml: gated }, off);
    expect(doc.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(html).not.toContain(PRIVACY_GATE_ID);
    expect(html).not.toMatch(/opacity:\s*0/);
    expect(html).toContain('Hello');
  });

  it('privacy on: the redaction pass removes it as before', async () => {
    const { html } = await runPrepass({ ...base, documentHtml: gated }, { privacy: { active: true, dict: null }, openFolds: new Set() });
    expect(html).not.toContain(PRIVACY_GATE_ID);
    expect(html).not.toMatch(/opacity:\s*0/);
  });
});
