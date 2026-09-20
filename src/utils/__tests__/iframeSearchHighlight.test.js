// @vitest-environment jsdom

/**
 * Search terms are highlighted inside the message the user opened from the
 * results list. The body lives in a same-origin iframe, so the parent walks
 * its text nodes directly — no script injected into the frame, no srcDoc
 * change (which would reload the frame on every keystroke).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { highlightTerms, applySearchHighlight, clearSearchHighlight } from '../iframeSearchHighlight';

let doc;

beforeEach(() => {
  doc = document.implementation.createHTMLDocument('body');
});

const body = (html) => { doc.body.innerHTML = html; return doc; };
const marks = () => [...doc.querySelectorAll('mark.mv-search-hit')].map(m => m.textContent);

describe('highlightTerms', () => {
  it('keeps terms of two characters or more, lowercased and deduped', () => {
    expect(highlightTerms('  Invoice  a  invoice PO ')).toEqual(['invoice', 'po']);
  });

  it('is empty for a blank query, so nothing is highlighted', () => {
    expect(highlightTerms('   ')).toEqual([]);
    expect(highlightTerms(null)).toEqual([]);
  });
});

describe('applySearchHighlight', () => {
  it('wraps every case-insensitive occurrence', () => {
    applySearchHighlight(body('<p>Invoice for the invoice you asked for</p>'), ['invoice']);
    expect(marks()).toEqual(['Invoice', 'invoice']);
    expect(doc.body.textContent).toBe('Invoice for the invoice you asked for');
  });

  it('never touches script or style text', () => {
    applySearchHighlight(body('<style>.invoice{color:red}</style><script>var invoice=1</script><p>invoice</p>'), ['invoice']);
    expect(marks()).toEqual(['invoice']);
    // The document's own style, not the one this module appends to <head>.
    expect(doc.body.querySelector('style').textContent).toBe('.invoice{color:red}');
  });

  it('treats a term with regex characters as literal text', () => {
    applySearchHighlight(body('<p>total (a+b) here</p>'), ['(a+b)']);
    expect(marks()).toEqual(['(a+b)']);
  });

  it('replaces the previous highlight instead of nesting marks', () => {
    const d = body('<p>invoice budget</p>');
    applySearchHighlight(d, ['invoice']);
    applySearchHighlight(d, ['budget']);
    expect(marks()).toEqual(['budget']);
    expect(d.body.textContent).toBe('invoice budget');
  });

  it('clears back to the original markup when the search is closed', () => {
    const d = body('<p>an <b>invoice</b> and an invoice</p>');
    applySearchHighlight(d, ['invoice']);
    applySearchHighlight(d, []);
    expect(marks()).toEqual([]);
    expect(d.body.innerHTML).toBe('<p>an <b>invoice</b> and an invoice</p>');
  });

  it('reports how many hits it drew', () => {
    expect(applySearchHighlight(body('<p>invoice invoice</p>'), ['invoice'])).toBe(2);
    expect(applySearchHighlight(body('<p>nothing here</p>'), ['invoice'])).toBe(0);
  });

  it('survives a document it cannot reach', () => {
    expect(() => clearSearchHighlight(null)).not.toThrow();
    expect(applySearchHighlight(null, ['invoice'])).toBe(0);
  });
});
