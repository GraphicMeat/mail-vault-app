// Shift-click on a row's checkbox ticks every row between the anchor and the
// clicked one, in the order the list draws them.
import { describe, expect, it } from 'vitest';
import { emailsInRowRange } from '../emailParser';

const email = (uid, extra = {}) => ({ uid, ...extra });
const key = e => String(e.uid);
const row = e => ({ type: 'email', email: e });
const thread = (...emails) => ({ type: 'thread', thread: { emails } });

describe('emailsInRowRange', () => {
  const rows = [row(email(1)), row(email(2)), row(email(3)), row(email(4))];

  it('covers both ends and every row between, downward', () => {
    expect(emailsInRowRange(rows, '1', '3', key).map(key)).toEqual(['1', '2', '3']);
  });

  it('covers the same rows upward', () => {
    expect(emailsInRowRange(rows, '4', '2', key).map(key)).toEqual(['2', '3', '4']);
  });

  it('a thread row in the range brings its own members, not its Sent copies', () => {
    const list = [row(email(1)), thread(email(2), email(3), email(9, { _fromSentFolder: true })), row(email(4))];
    expect(emailsInRowRange(list, '1', '4', key).map(key)).toEqual(['1', '2', '3', '4']);
  });

  it('finds an anchor that is a thread member', () => {
    const list = [row(email(1)), thread(email(2), email(3)), row(email(4))];
    expect(emailsInRowRange(list, '3', '4', key).map(key)).toEqual(['2', '3', '4']);
  });

  it('is null when the anchor is no longer on screen', () => {
    expect(emailsInRowRange(rows, '99', '2', key)).toBeNull();
  });
});
