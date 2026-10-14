// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { quoteText, replySelection, selectionWithin } from '../replySelection';

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
});
