import { describe, expect, it } from 'vitest';
import { codeRuns } from '../codeText';

const runs = (text) => codeRuns(text).map(r => [r.code, r.text]);

describe('codeRuns: `inline` and ```fenced``` code in a plain-text message', () => {
  it('leaves text with no code as one plain run, and nothing as nothing', () => {
    expect(runs('just words')).toEqual([[null, 'just words']]);
    expect(runs('')).toEqual([]);
    expect(codeRuns(undefined)).toEqual([]);
  });

  it('marks a `span` between backticks as inline code, and drops the ticks', () => {
    expect(runs('run `npm test` now')).toEqual([[null, 'run '], ['inline', 'npm test'], [null, ' now']]);
    expect(runs('`a` and `b`')).toEqual([['inline', 'a'], [null, ' and '], ['inline', 'b']]);
  });

  it('leaves alone what only looks like a span', () => {
    for (const text of ['it`s fine', 'a`b`c', 'one ` tick', '`` empty ``', 'a `b\nc` d', 'x ```y``` z']) {
      expect(runs(text), text).toEqual([[null, text]]);
    }
  });

  it('marks a fenced block, dropping the fence lines and their line breaks', () => {
    const text = 'before\n```js\nconst a = 1;\n\nb();\n```\nafter';
    expect(runs(text)).toEqual([[null, 'before\n'], ['block', 'const a = 1;\n\nb();'], [null, 'after']]);
  });

  it('a block at the very start or end has no plain run beside it', () => {
    expect(runs('```\nx\n```')).toEqual([['block', 'x']]);
    expect(runs('```\nx\n```\n')).toEqual([['block', 'x']]);
  });

  it('an unclosed fence is plain text', () => {
    const text = 'see:\n```\nno end here';
    expect(runs(text)).toEqual([[null, text]]);
  });

  it('keeps a block\'s content exactly, backticks and all, and never reads inline inside it', () => {
    expect(runs('```\nuse `x` here\n```')).toEqual([['block', 'use `x` here']]);
  });

  it('reads every block and span in a longer message', () => {
    const text = 'Try `a`.\n```\none\n```\nthen `b`\n```\ntwo\n```';
    expect(runs(text)).toEqual([
      [null, 'Try '], ['inline', 'a'], [null, '.\n'], ['block', 'one'],
      [null, 'then '], ['inline', 'b'], [null, '\n'], ['block', 'two'],
    ]);
  });

  it('joins back to the message with only the ticks and fence lines removed', () => {
    const text = 'a `b` c\nplain line\n```\nd\n```\ne';
    expect(codeRuns(text).map(r => r.text).join('')).toBe('a b c\nplain line\nde');
  });
});
