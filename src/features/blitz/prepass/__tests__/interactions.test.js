// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { markFolds, foldLabels } from '../folds';
import { markUnselectable } from '../unselectable';
import { markSearch } from '../search';
import { runPrepass } from '../index';
import { styleQuoteToggle } from '../../../../utils/foldDetection';

const parse = (body) => new DOMParser().parseFromString(`<!doctype html><body>${body}</body>`, 'text/html');

describe('markFolds', () => {
  it('marks a quote with ids, labels, closed state and the iframe toggle markup', () => {
    const doc = parse('<p>Answer above.</p><blockquote><p>Quoted line</p></blockquote>');
    expect(markFolds(doc, { labels: foldLabels() })).toEqual(['q0']);
    const region = doc.querySelector('[data-mv-fold="q0"]');
    const toggle = doc.querySelector('[data-mv-fold-toggle="q0"]');
    expect(region.tagName).toBe('BLOCKQUOTE');
    expect(region.dataset.quoteFolded).toBe('true');
    expect(region.dataset.mvFoldKind).toBe('quote');
    expect(region.dataset.mvFoldOpen).toBe('false');
    expect(region.style.display).toBe('none');
    expect(region.getAttribute('style')).toBe('display: none;');
    expect(toggle.dataset.quoteToggle).toBe('true');
    expect(toggle.hasAttribute('data-mv-noselect')).toBe(true);
    expect(toggle.textContent).toBe('⋯');
    expect(toggle.dataset.mvLabelOpen).toBe('▾ Hide quoted text');
    expect(toggle.dataset.mvDarkStyle).toBe('background:#374151;color:#9ca3af;border-color:#4b5563');
    // The shared styling, light. (jsdom's cssText parser drops this whole declaration list, so the
    // exact string is compared with what the shared function leaves on a fresh element, not hardcoded.)
    const probe = doc.createElement('div');
    styleQuoteToggle(probe, false);
    expect(toggle.getAttribute('style')).toBe(probe.getAttribute('style'));
  });

  it('smart and collapsed fold the signature the same way; always-hide has no toggle; always-show nothing', () => {
    const body = '<p>Body.</p><div class="gmail_signature"><div>Person B</div></div>';
    for (const mode of ['smart', 'collapsed']) {
      const doc = parse(body);
      expect(markFolds(doc, { signatureDisplay: mode, labels: foldLabels() })).toEqual(['s0']);
      expect(doc.querySelector('[data-mv-fold-toggle="s0"]').textContent).toBe('▸ Show signature');
      expect(doc.querySelector('[data-mv-fold-toggle="s0"]').getAttribute('style')).toContain('font-size: 12px');
    }
    const hide = parse(body);
    expect(markFolds(hide, { signatureDisplay: 'always-hide', labels: foldLabels() })).toEqual([]);
    expect(hide.querySelector('.gmail_signature').style.display).toBe('none');
    expect(hide.querySelector('[data-mv-fold-toggle]')).toBeNull();
    const show = parse(body);
    expect(markFolds(show, { signatureDisplay: 'always-show', labels: foldLabels() })).toEqual([]);
    expect(show.querySelector('.gmail_signature').style.display).toBe('');
  });

  it('quotes fold before signatures, and an open fold stays open (re-open carry)', () => {
    const doc = parse('<p>Reply.</p><blockquote><p>Q</p></blockquote><div class="gmail_signature">Sig</div>');
    expect(markFolds(doc, { openFolds: new Set(['q0']), labels: foldLabels() })).toEqual(['q0', 's0']);
    const region = doc.querySelector('[data-mv-fold="q0"]');
    expect(region.style.display).toBe('');
    expect(region.dataset.mvFoldOpen).toBe('true');
    expect(doc.querySelector('[data-mv-fold-toggle="q0"]').textContent).toBe('▾ Hide quoted text');
  });

  it('foldQuotes false leaves quotes alone (surfaces that never inject the quote script)', () => {
    const doc = parse('<p>A</p><blockquote>Q</blockquote>');
    expect(markFolds(doc, { foldQuotes: false, signatureDisplay: 'always-show', labels: foldLabels() })).toEqual([]);
  });

  it('an element two signature selectors both list gets one fold, not two', () => {
    // .gmail_signature and div[class*="signature"] both match; the iframe lists it twice.
    const doc = parse('<p>Body.</p><div class="gmail_signature">Sig</div>');
    markFolds(doc, { labels: foldLabels() });
    expect(doc.querySelectorAll('[data-mv-fold-toggle]')).toHaveLength(1);
    expect(doc.querySelectorAll('[data-mv-fold]')).toHaveLength(1);
  });
});

describe('markUnselectable', () => {
  it('marks privacy masks and fold toggles', () => {
    const doc = parse('<p>Hi <span class="mv-pii">••••</span></p><div data-quote-toggle="true">⋯</div>');
    markUnselectable(doc);
    expect(doc.querySelector('.mv-pii').hasAttribute('data-mv-noselect')).toBe(true);
    expect(doc.querySelector('[data-quote-toggle]').hasAttribute('data-mv-noselect')).toBe(true);
  });
});

describe('markSearch', () => {
  it('uses the iframe highlighter verbatim: marks, pinned style, never inside .mv-pii', () => {
    const doc = parse('<p>Invoice for <span class="mv-pii">Invoice Person</span>, invoice 2.</p>');
    expect(markSearch(doc, 'invoice')).toBe(2);
    expect(doc.querySelectorAll('mark.mv-search-hit')).toHaveLength(2);
    expect(doc.getElementById('mv-search-hit-style').textContent).toContain('background:#ffd54f');
    expect(doc.querySelector('.mv-pii mark')).toBeNull();
  });
  it('an empty or one-letter query marks nothing', () => {
    expect(markSearch(parse('<p>a b c</p>'), 'a')).toBe(0);
    expect(markSearch(parse('<p>abc</p>'), '')).toBe(0);
  });
  it('never marks inside a fold toggle: the worker rewrites the toggle label as one text node', () => {
    const doc = parse('<p>Body.</p><div class="gmail_signature">Sig</div><blockquote>Quoted</blockquote>');
    markFolds(doc, { openFolds: new Set(['q0']), labels: foldLabels() });
    // "signature" is in the closed signature label, "quoted" in the open quote label and in the quote.
    expect(markSearch(doc, 'signature quoted')).toBe(1); // only the blockquote's own "Quoted"
    expect(doc.querySelector('[data-mv-fold-toggle] mark')).toBeNull();
    expect(doc.querySelector('[data-mv-fold-toggle="s0"]').childNodes).toHaveLength(1);
    expect(doc.querySelector('[data-mv-fold-toggle="q0"]').childNodes).toHaveLength(1);
  });
});

describe('runPrepass order', () => {
  // Plan A's dictionary builder, the same one usePrivacyDict's source uses.
  const dictFor = async (names) => (await import('../../../../utils/privacy/piiDetector')).buildNameDictionary({ names });
  const base = { surface: 'reader', messageKey: 'k', theme: { dark: false, palette: 'graphite' }, signatureDisplay: 'smart', foldQuotes: true, sizing: 'content' };

  it('search after privacy keeps a matching name masked', async () => {
    // "Rokas" is a dictionary name; the query hits half of it. Search-first would
    // split the text node, and the redaction pass would no longer see the name.
    const props = { ...base, bodyHtml: '<p>Hello Rokas Ambrazevicius, your invoice.</p>', searchQuery: 'rok invoice' };
    const dict = await dictFor(['Rokas Ambrazevicius']);
    const { doc, html } = await runPrepass(props, { privacy: { active: true, dict }, openFolds: new Set() });
    expect(doc.body.textContent).not.toContain('Rokas');
    expect(html).not.toContain('Rokas');
    expect(doc.querySelectorAll('mark.mv-search-hit')).toHaveLength(1); // "invoice" only
    expect(doc.querySelector('.mv-pii').hasAttribute('data-mv-noselect')).toBe(true);
  });

  it('folds run on the built document, before privacy, and carry open folds', async () => {
    const props = { ...base, bodyHtml: '<p>Reply.</p><blockquote><p>Quoted by Rokas Ambrazevicius</p></blockquote>', searchQuery: '' };
    const dict = await dictFor(['Rokas Ambrazevicius']);
    const { doc, html } = await runPrepass(props, { privacy: { active: true, dict }, openFolds: new Set(['q0']) });
    expect(doc.querySelector('[data-mv-fold="q0"]').dataset.mvFoldOpen).toBe('true');
    expect(doc.querySelector('[data-mv-fold-toggle="q0"]').hasAttribute('data-mv-noselect')).toBe(true);
    expect(html).not.toContain('Rokas');
    expect(html).toMatch(/^<!DOCTYPE html>/i); // the whole built document, as A serializes it
  });

  it('the worker reads the toggle as light: the built document paints a white body', async () => {
    const { doc } = await runPrepass({ ...base, bodyHtml: '<p>Reply.</p><blockquote>Q</blockquote>', searchQuery: '' }, { privacy: { active: false, dict: null } });
    const css = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n');
    expect(css).toMatch(/html,\s*body\s*\{[^}]*background:\s*#ffffff/);
  });
});
