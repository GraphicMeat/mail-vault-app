// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collectAppWords } from '../appWords';
import { captureMaskIndex, resetCaptureMasks } from '../../../../utils/privacy/captureMasks';
import { applyPrivacyRedaction } from '../../../../utils/iframePrivacyRedact';
import { buildNameDictionary } from '../../../../utils/privacy/piiDetector';

// jsdom lays nothing out: a character is 10 px wide, a word's row is the nearest data-top (default 0), 10 px tall.
const rectsOf = function () {
  const el = this.startContainer.parentElement;
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 0);
  return [{ left: this.startOffset * 10, top, width: (this.endOffset - this.startOffset) * 10, height: 10 }];
};
// A frame's window has a Range of its own.
const lay = (iframe) => { iframe.contentWindow.Range.prototype.getClientRects = rectsOf; };
let original;
beforeEach(() => {
  resetCaptureMasks();
  original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  Range.prototype.getClientRects = rectsOf;
});
afterEach(() => {
  if (original) Object.defineProperty(Range.prototype, 'getClientRects', original);
  else delete Range.prototype.getClientRects;
  document.body.innerHTML = '';
});

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function mount(html, rootBox = box(0, 0, 1000, 800)) {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  const root = document.getElementById('root');
  root.getBoundingClientRect = () => rootBox;
  return root;
}
const everything = { scale: 2, keep: null, visibleRect: (f) => f.getBoundingClientRect() };
const find = (words, k) => words.filter(w => w.k === k);

describe('collectAppWords', () => {
  it('lists the readable words of the app: key, not masked, rects in picture pixels from the root\'s corner', () => {
    const root = mount('<p data-top="30">Hello, World</p>', box(5, 7, 1000, 800));
    const words = collectAppWords(root, everything);
    expect(words.map(w => [w.k, w.on])).toEqual([['hello', false], ['world', false]]);
    // "World" starts at character 7: 70 px, 5 px of root offset out, 2x; row 30, 7 out, 2x.
    expect(words[1].rects[0]).toEqual([(70 - 5) * 2, (30 - 7) * 2, 50 * 2, 10 * 2]);
  });

  it('a masked run gives its words back under the original\'s keys, as masked', () => {
    const i = captureMaskIndex('Ana Brandt');
    const root = mount(`<p>Hi <span class="mv-private" aria-hidden="true" data-mv-i="${i}">xxx xxxxxx</span></p>`);
    const words = collectAppWords(root, everything);
    expect(words.map(w => [w.k, w.on])).toEqual([['hi', false], ['ana', true], ['brandt', true]]);
  });

  it('a run with some words shown reads word by word', () => {
    const i = captureMaskIndex('Ana Brandt');
    const root = mount(`<p><span class="mv-private" data-mv-i="${i}">Ana xxxxxx</span></p>`);
    expect(collectAppWords(root, everything).map(w => [w.k, w.on])).toEqual([['ana', false], ['brandt', true]]);
  });

  it('a plain word the user marked hide reads as masked: the clone pass masks it though the live UI shows it', () => {
    const root = mount('<p>Open Vault now</p>');
    const words = collectAppWords(root, { ...everything, hide: new Set(['vault']) });
    expect(words.map(w => [w.k, w.on])).toEqual([['open', false], ['vault', true], ['now', false]]);
  });

  it('leaves out a mask it cannot read back, and a word that is not the original in either form', () => {
    const i = captureMaskIndex('Ana');
    const root = mount(`<p>a <span class="mv-private" data-mv-i="${i}">xx</span> <span class="mv-private" data-mv-i="99">xxx</span> b</p>`);
    expect(collectAppWords(root, everything).map(w => w.k)).toEqual(['a', 'b']);
  });

  it('leaves out what the shot leaves out (the export dialog), and inputs and scripts', () => {
    const root = mount('<p>kept</p><div data-capture-exclude><p>dialog</p></div><input value="typed"><script>var secret</script><textarea>draft</textarea>');
    const words = collectAppWords(root, { ...everything, keep: n => !n.closest('[data-capture-exclude]') });
    expect(words.map(w => w.k)).toEqual(['kept']);
  });

  it('clips to every scrolling ancestor: words scrolled out are gone, a half-visible word keeps its visible part', () => {
    const root = mount('<div id="pane" style="overflow-x:auto;overflow-y:auto"><p data-top="5">seen</p><p data-top="95">half</p><p data-top="300">hidden</p></div>');
    document.getElementById('pane').getBoundingClientRect = () => box(0, 0, 500, 100);
    const words = collectAppWords(root, everything);
    expect(words.map(w => w.k)).toEqual(['seen', 'half']);
    expect(words[1].rects[0][3]).toBe(5 * 2); // 100 - 95
  });

  it('words of a message frame sit at the frame\'s place, its masks read from the pass that made them', () => {
    const root = mount('<iframe id="f"></iframe><p>app</p>');
    const iframe = document.getElementById('f');
    lay(iframe);
    iframe.contentDocument.body.innerHTML = '<p data-top="20">Hi John Smith ok</p>';
    applyPrivacyRedaction(iframe.contentDocument, buildNameDictionary({ names: ['John Smith'] }));
    iframe.getBoundingClientRect = () => box(100, 200, 400, 300);
    const words = collectAppWords(root, everything);
    expect(words.map(w => [w.k, w.on])).toEqual([['app', false], ['hi', false], ['john', true], ['smith', true], ['ok', false]]);
    // "Hi" at character 0 of the frame's text node: frame left 100, row 200 + 20, 2x.
    expect(find(words, 'hi')[0].rects[0]).toEqual([100 * 2, 220 * 2, 20 * 2, 10 * 2]);
  });

  it('a frame is clipped to the part of it on screen, and a frame off screen adds nothing', () => {
    const root = mount('<iframe id="f"></iframe>');
    const iframe = document.getElementById('f');
    lay(iframe);
    iframe.contentDocument.body.innerHTML = '<p data-top="0">top</p><p data-top="150">low</p>';
    iframe.getBoundingClientRect = () => box(0, 0, 400, 300);
    expect(collectAppWords(root, { ...everything, visibleRect: () => box(0, 0, 400, 100) }).map(w => w.k)).toEqual(['top']);
    expect(collectAppWords(root, { ...everything, visibleRect: () => box(0, 0, 0, 0) })).toEqual([]);
  });

  it('a word with nothing on screen is not listed, and without layout there are no words at all', () => {
    const root = mount('<p>one two</p>');
    const rects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () { return this.startOffset === 0 ? [] : rects.call(this); };
    expect(collectAppWords(root, everything).map(w => w.k)).toEqual(['two']);
    delete Range.prototype.getClientRects;
    expect(collectAppWords(root, everything)).toEqual([]);
  });
});
