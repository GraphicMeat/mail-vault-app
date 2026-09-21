// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { replySelection } from '../replySelection';

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
});
