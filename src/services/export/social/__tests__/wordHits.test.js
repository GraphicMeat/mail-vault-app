// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collectWords, plainHeaderWords, resolveWords, sameWord, contentPointAt, wordAt, MAX_WORDS } from '../wordHits';
import { layoutSocial } from '../socialLayout';

// jsdom has no layout: every character is 10 px wide and 10 px tall, rows 10 px apart per text node.
let original;
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  let row = 0;
  Range.prototype.getClientRects = function () {
    const r = { left: this.startOffset * 10, top: (row += 10), width: (this.endOffset - this.startOffset) * 10, height: 10 };
    return [r];
  };
});
afterEach(() => {
  if (original) Object.defineProperty(Range.prototype, 'getClientRects', original);
  else delete Range.prototype.getClientRects;
});

const docOf = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

describe('collectWords', () => {
  it('lists each word of the text with its rect scaled to canvas pixels, in document order', () => {
    const words = collectWords(docOf('<p>Hi Ana</p><p>bye</p>'), 2);
    expect(words.map(w => [w.i, w.text])).toEqual([[0, 'Hi'], [1, 'Ana'], [2, 'bye']]);
    expect(words[1].rects[0][0]).toBe(3 * 10 * 2); // starts at character 3 -> 30 px -> x2
    expect(words[1].rects[0][2]).toBe(3 * 10 * 2);
  });

  it('knows the mask a word sits in, and its place among that mask\'s words; plain words have none', () => {
    const doc = docOf('<p>Hi <span class="mv-pii" data-mv-i="4">xxx xxxxx</span></p>');
    const words = collectWords(doc);
    expect(words.map(w => [w.text, w.mask, w.ti])).toEqual([['Hi', null, 0], ['xxx', 4, 0], ['xxxxx', 4, 1]]);
  });

  it('skips scripts and styles, words with nothing on screen, but still counts them for the header match', () => {
    const doc = docOf('<style>a { b }</style><p>one</p><p>two</p><p>three</p>');
    const hidden = doc.querySelectorAll('p')[1].firstChild;
    const rects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () { return this.startContainer === hidden ? [] : rects.call(this); };
    const words = collectWords(doc);
    expect(words.map(w => [w.i, w.text])).toEqual([[0, 'one'], [2, 'three']]);
  });

  it('a word that wraps keeps every line\'s rect', () => {
    Range.prototype.getClientRects = function () { return [{ left: 0, top: 0, width: 20, height: 10 }, { left: 0, top: 10, width: 30, height: 10 }]; };
    expect(collectWords(docOf('<p>wrapped</p>'))[0].rects).toHaveLength(2);
  });

  it('without Range rects (no layout) finds nothing instead of throwing', () => {
    delete Range.prototype.getClientRects;
    expect(collectWords(docOf('<p>hello</p>'))).toEqual([]);
  });

  it('stops measuring at MAX_WORDS', () => {
    const many = Array.from({ length: MAX_WORDS + 50 }, (_, n) => `w${n}`).join(' ');
    expect(collectWords(docOf(`<p>${many}</p>`))).toHaveLength(MAX_WORDS);
  });
});

describe('plainHeaderWords', () => {
  const message = {
    subject: 'Lunch with Ana', date: new Date('2026-09-01T10:00:00Z'),
    from: { name: 'Ana Brandt', address: 'ana@x.co' }, to: [{ name: 'Rowan Marsh', address: 'rowan@y.co' }],
  };

  it('lists the header\'s words in the order it is drawn, the To row left out when hidden', () => {
    const keys = plainHeaderWords(message).map(w => w.key);
    expect(keys).toEqual(expect.arrayContaining(['lunch', 'ana', 'brandt', 'ana@x.co', 'rowan', 'marsh', 'rowan@y.co']));
    expect(keys.indexOf('lunch')).toBeLessThan(keys.indexOf('brandt'));
    expect(keys.indexOf('brandt')).toBeLessThan(keys.indexOf('rowan'));
    const noTo = plainHeaderWords(message, { hideTo: true }).map(w => w.key);
    expect(noTo).not.toContain('rowan');
    expect(noTo).toContain('brandt');
  });
});

describe('sameWord', () => {
  it('accepts the word itself and the word with letters turned to x, nothing else', () => {
    expect(sameWord('Ana', 'Ana')).toBe(true);
    expect(sameWord('Ana', 'xxx')).toBe(true);
    expect(sameWord("Brandt's", "xxxxxx'x")).toBe(true);
    expect(sameWord('Ana', 'Bob')).toBe(false);
    expect(sameWord('Ana', 'xx')).toBe(false);
    expect(sameWord('Ana', 'Anx')).toBe(true);
  });
});

describe('resolveWords', () => {
  const r = (x) => [[x, 0, 10, 10]];
  const plainHead = [{ text: 'Lunch', key: 'lunch' }, { text: 'Ana', key: 'ana' }, { text: '<ana@x.co>', key: 'ana@x.co' }];

  it('header: a masked word reads as on, a plain one as off, both under the plain word\'s key', () => {
    const out = resolveWords({
      plainHead,
      head: [{ i: 0, text: 'Lunch', rects: r(0) }, { i: 1, text: 'xxx', rects: r(1) }, { i: 2, text: '<xxx@x.xx>', rects: r(2) }],
    });
    expect(out).toEqual([
      { k: 'lunch', on: false, rects: r(0) },
      { k: 'ana', on: true, rects: r(1) },
      { k: 'ana@x.co', on: true, rects: r(2) },
    ]);
  });

  it('header: a word that is not the plain one at its place is left out, so a click never hits the wrong word', () => {
    const out = resolveWords({ plainHead, head: [{ i: 1, text: 'Bob', rects: r(0) }, { i: 7, text: 'extra', rects: r(1) }] });
    expect(out).toEqual([]);
  });

  it('body: a word in a mask is on under the original\'s key; a plain word is off under its own', () => {
    const out = resolveWords({
      masks: ['Kowalczyk'],
      body: [{ mask: 0, ti: 0, text: 'xxxxxxxxx', rects: r(0) }, { mask: null, ti: 0, text: 'Hello,', rects: r(1) }],
    });
    expect(out).toEqual([
      { k: 'kowalczyk', on: true, rects: r(0) },
      { k: 'hello', on: false, rects: r(1) },
    ]);
  });

  it('body: the words of a multi-word mask map to the original\'s words in order', () => {
    const out = resolveWords({
      masks: ['Ana Brandt'],
      body: [{ mask: 0, ti: 0, text: 'xxx', rects: r(0) }, { mask: 0, ti: 1, text: 'xxxxxx', rects: r(1) }],
    });
    expect(out.map(w => w.k)).toEqual(['ana', 'brandt']);
  });

  it('body: a mask whose original is unknown, or does not match in size, is left out', () => {
    expect(resolveWords({ masks: [], body: [{ mask: 3, ti: 0, text: 'xxx', rects: r(0) }] })).toEqual([]);
    expect(resolveWords({ masks: ['Ana'], body: [{ mask: 0, ti: 0, text: 'xxxx', rects: r(0) }] })).toEqual([]);
  });
});

describe('contentPointAt and wordAt', () => {
  const layout = layoutSocial({ contentW: 1000, contentH: 2000, size: { w: 500, h: 500 }, padding: 20, chrome: true });
  const full = { w: layout.canvasW, h: layout.canvasH };
  const c = layout.content;

  it('maps a point on the preview to the content canvas, through the fit scaling', () => {
    // Preview shown at a quarter of the image's size.
    const shown = { w: full.w / 4, h: full.h / 4 };
    const p = contentPointAt({ x: (c.dx + c.dw / 2) / 4, y: (c.dy + c.dh / 2) / 4, shown, full, layout });
    expect(p.x).toBeCloseTo(500, 0);
    expect(p.y).toBeCloseTo(1000, 0);
    const corner = contentPointAt({ x: (c.dx + 1) / 4, y: (c.dy + 1) / 4, shown, full, layout });
    expect(corner.x).toBeCloseTo(c.sw / c.dw, 1);
  });

  it('a point on the background, the title bar or past the card is not content', () => {
    const shown = { w: full.w, h: full.h };
    expect(contentPointAt({ x: 2, y: 2, shown, full, layout })).toBeNull();
    expect(contentPointAt({ x: c.dx + 5, y: c.dy - 5, shown, full, layout })).toBeNull();
    expect(contentPointAt({ x: c.dx + c.dw + 1, y: c.dy + 10, shown, full, layout })).toBeNull();
  });

  it('without a fixed size the content is drawn 1:1, offset by the padding and frame', () => {
    const auto = layoutSocial({ contentW: 800, contentH: 600, size: null, padding: 10, chrome: true });
    const f = { w: auto.canvasW, h: auto.canvasH };
    const p = contentPointAt({ x: auto.content.dx + 30, y: auto.content.dy + 40, shown: f, full: f, layout: auto });
    expect([p.x, p.y]).toEqual([30, 40]);
  });

  it('finds the word under a point, any of its rects, and none elsewhere', () => {
    const words = [{ k: 'a', on: false, rects: [[0, 0, 10, 10], [0, 10, 20, 10]] }, { k: 'b', on: true, rects: [[30, 0, 10, 10]] }];
    expect(wordAt(words, { x: 15, y: 15 }).k).toBe('a');
    expect(wordAt(words, { x: 35, y: 5 }).k).toBe('b');
    expect(wordAt(words, { x: 25, y: 5 })).toBeNull();
    expect(wordAt(words, null)).toBeNull();
    expect(wordAt(undefined, { x: 1, y: 1 })).toBeNull();
  });
});
