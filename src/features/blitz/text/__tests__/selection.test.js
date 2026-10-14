// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { selectionEndpoints, layerPlainText, selectLayer, selectionInLayer } from '../selection';

function layer(html) {
  document.body.innerHTML = `<p id="before">outside</p><div class="mv-blitz-text">${html}</div><p id="after">outside</p>`;
  return document.querySelector('.mv-blitz-text');
}
const span = (node, start, text) => `<span data-node="${node}" data-start="${start}">${text}</span>`;
function select(a, ao, b, bo) {
  const r = document.createRange(); r.setStart(a, ao); r.setEnd(b, bo);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return s;
}

describe('selectionEndpoints', () => {
  let el;
  beforeEach(() => {
    el = layer(`<div data-tile="0"><div class="mv-blitz-root">${span(5, 0, 'naïve 😀 東京')}${span(5, 17, ' end')}</div></div><div data-tile="1"><div class="mv-blitz-root">${span(9, 0, 'next')}</div></div>`);
  });
  it('endpoints convert utf16 to utf8 across emoji', () => {
    const [a] = el.querySelectorAll('span');
    const t = a.firstChild;
    expect(selectionEndpoints(select(t, 6, t, 8), el)).toEqual({ start: { node: 5, offset: 7 }, end: { node: 5, offset: 11 } });
  });
  it('across spans and roots', () => {
    const [a, , c] = el.querySelectorAll('span');
    expect(selectionEndpoints(select(a.firstChild, 0, c.firstChild, 2), el)).toEqual({ start: { node: 5, offset: 0 }, end: { node: 9, offset: 2 } });
  });
  it('element boundary points resolve to the nearest span edge', () => {
    const root = el.querySelector('.mv-blitz-root');
    expect(selectionEndpoints(select(root, 1, root, 2), el)).toEqual({ start: { node: 5, offset: 17 }, end: { node: 5, offset: 21 } });
  });
  it('a drag that starts or ends outside the layer clamps to its first/last span', () => {
    const before = document.getElementById('before').firstChild;
    const after = document.getElementById('after').firstChild;
    expect(selectionEndpoints(select(before, 2, after, 3), el)).toEqual({ start: { node: 5, offset: 0 }, end: { node: 9, offset: 4 } });
  });
  it('null when the selection does not touch the layer', () => {
    const before = document.getElementById('before').firstChild;
    expect(selectionEndpoints(select(before, 0, before, 3), el)).toBeNull();
    expect(selectionInLayer(window.getSelection(), el)).toBe(false);
  });
  it('layerPlainText joins roots with newlines', () => {
    const [a, , c] = el.querySelectorAll('span');
    expect(layerPlainText(select(a.firstChild, 6, c.firstChild, 4), el)).toBe('😀 東京 end\nnext');
  });
  it('ZWJ and combining sequences convert by code unit and never split a surrogate pair', () => {
    document.body.innerHTML = `<div class="mv-blitz-text"><div class="mv-blitz-root">${span(3, 0, 'e\u0301👨\u200d👩x')}</div></div>`;
    const e = document.querySelector('.mv-blitz-text');
    const t = e.querySelector('span').firstChild;
    // e + U+0301 = 3 bytes; the man is 4, ZWJ 3, the woman 4, then x.
    expect(selectionEndpoints(select(t, 2, t, 7), e)).toEqual({ start: { node: 3, offset: 3 }, end: { node: 3, offset: 14 } });
    // utf16 index 3 is inside the man's surrogate pair: snaps back before it.
    expect(selectionEndpoints(select(t, 3, t, 4), e).start).toEqual({ node: 3, offset: 3 });
  });
  it('an end boundary on an ancestor after the layer clamps to the last span', () => {
    const a = el.querySelector('span').firstChild;
    const body = document.body;
    expect(selectionEndpoints(select(a, 0, body, body.childNodes.length), el)).toEqual({ start: { node: 5, offset: 0 }, end: { node: 9, offset: 4 } });
  });
  it('layerPlainText reads a boundary on the span element itself', () => {
    const [a] = el.querySelectorAll('span');
    expect(layerPlainText(select(a, 0, a, 1), el)).toBe('naïve 😀 東京');
  });
  it('selectLayer selects first to last span', () => {
    const spans = el.querySelectorAll('span');
    selectLayer(el, spans[0], spans[spans.length - 1]);
    expect(selectionEndpoints(window.getSelection(), el)).toEqual({ start: { node: 5, offset: 0 }, end: { node: 9, offset: 4 } });
  });
});
