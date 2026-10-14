// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { altBodyQuote, quoteText, replySelection, selectionWithin } from '../replySelection';

describe('replySelection', () => {
  it('escapes selected plain text and preserves line breaks', () => {
    const root = document.createElement('div');
    root.textContent = 'first <line>\nsecond';
    document.body.append(root);
    const range = document.createRange();
    range.selectNodeContents(root);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    expect(replySelection(root)).toBe('first &lt;line&gt;<br>second');
  });

  it('ignores a selection outside the message being answered', () => {
    const root = document.createElement('div');
    const other = document.createElement('div');
    root.textContent = 'answer';
    other.textContent = 'wrong message';
    document.body.append(root, other);
    const range = document.createRange();
    range.selectNodeContents(other);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    expect(replySelection(root)).toBe('');
  });

  it('quoteText is the escape replySelection applies, for text read elsewhere', () => {
    expect(quoteText('a & <b>\r\nc\n\nd')).toBe('a &amp; &lt;b&gt;<br>c<br><br>d');
  });

  it('selectionWithin is replySelection\'s gate: a live selection inside the root', () => {
    const root = document.createElement('div');
    const other = document.createElement('div');
    root.textContent = 'answer';
    other.textContent = 'elsewhere';
    document.body.append(root, other);
    const range = document.createRange();
    range.selectNodeContents(root);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    expect(selectionWithin(root, document.getSelection())).toBe(true);
    expect(selectionWithin(other, document.getSelection())).toBe(false);
    document.getSelection().collapseToStart();
    expect(selectionWithin(root, document.getSelection())).toBe(false);
  });

  describe('altBodyQuote (the reader seam for an alternative body)', () => {
    const setup = () => {
      document.body.innerHTML = '<div id="layer"><span>Brline one </span><span>Brline two</span></div><div id="plain">plain body</div><p id="out">elsewhere</p>';
      return { layer: document.getElementById('layer'), plain: document.getElementById('plain'), out: document.getElementById('out') };
    };
    const selectIn = (el) => {
      const range = document.createRange(); range.selectNodeContents(el);
      document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
      return document.getSelection();
    };
    const body = (root, text) => ({ selectionRoot: () => root, selectionText: () => text });

    it('quotes the body\'s own selection text, escaped like replySelection', () => {
      const { layer } = setup();
      expect(altBodyQuote(body(layer, 'Brline one\nBrline two & <3>'), selectIn(layer))).toBe('Brline one<br>Brline two &amp; &lt;3&gt;');
    });

    it('a selection outside the body\'s root quotes nothing, whatever its text', () => {
      const { layer, out } = setup();
      expect(altBodyQuote(body(layer, 'Brline one\nBrline two'), selectIn(out))).toBe('');
    });

    it('no own text: the selected DOM text of its root', () => {
      const { layer } = setup();
      expect(altBodyQuote(body(layer, ''), selectIn(layer))).toBe('Brline one Brline two');
      expect(altBodyQuote({ selectionRoot: () => layer }, selectIn(layer))).toBe('Brline one Brline two');
    });

    it('no root (held, failed) or no body: the plain body, as replySelection', () => {
      const { layer, plain } = setup();
      expect(altBodyQuote(body(null, 'ignored'), selectIn(plain), plain)).toBe('plain body');
      expect(altBodyQuote(null, selectIn(plain), plain)).toBe('plain body');
      expect(altBodyQuote(body(null, 'ignored'), selectIn(layer), null)).toBe('');
    });
  });
});
