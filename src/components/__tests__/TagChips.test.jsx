// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('../../i18n/index.js', () => ({ t: key => key, useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }));

let useMailStoreMock;
let useTagStoreMock;
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign(selector => useMailStoreMock(selector), { getState: () => useMailStoreMock.getState() }),
}));
// 'UNIFIED' resolves to nothing, exactly as the real helper does: a message in
// the unified list is not in any one folder.
vi.mock('../../stores/slices/unifiedHelpers', () => ({
  resolveEmailLocation: (email) => (email?._mailbox && email._mailbox !== 'UNIFIED'
    ? { accountId: 'acct-1', mailbox: email._mailbox } : null),
}));
const requestRowTags = vi.fn();
vi.mock('../../stores/tagStore', () => ({
  useTagStore: Object.assign(selector => useTagStoreMock(selector), { getState: () => useTagStoreMock.getState() }),
  requestRowTags: (...args) => requestRowTags(...args),
  tagRowKey: (a, m, u) => `${a}|${m}|${u}`,
}));

const { TagChips } = await import('../TagChips');

const RECEIPTS = { id: 't1', name: 'Receipts', color: '#f00', position: 0 };
const CLIENTS = { id: 't2', name: 'Clients', color: '', position: 1 };
const UNUSED = { id: 't3', name: 'Nobody', color: '', position: 2 };

const email = { uid: 7, messageId: '<abc@x>', _mailbox: 'INBOX' };

const chips = container => [...container.querySelectorAll('.local-mail-label')];

beforeEach(() => {
  requestRowTags.mockReset();
  useMailStoreMock = create(() => ({ activeAccountId: 'acct-1' }));
  useTagStoreMock = create(() => ({
    tags: [RECEIPTS, CLIENTS, UNUSED],
    byRow: { 'acct-1|INBOX|7': ['t1', 't2'] },
    removeTag: vi.fn(async () => true),
  }));
});
afterEach(cleanup);

describe('the tag chips on a row', () => {
  it('draws the tags this message carries, and not the ones nobody assigned', () => {
    const { container } = render(<TagChips email={email} />);
    expect(chips(container).map(node => node.textContent)).toEqual(['Receipts×', 'Clients×']);
  });

  it('a tag with a colour carries it; one without gets no style at all', () => {
    const { container } = render(<TagChips email={email} />);
    const [receipts, clients] = chips(container);
    expect(receipts.style.getPropertyValue('--tag-color')).toBe('#f00');
    expect(clients.style.getPropertyValue('--tag-color')).toBe('');
  });

  it('the × hands back the row identity the assignment is keyed by', () => {
    const { container } = render(<TagChips email={email} />);
    fireEvent.click(chips(container)[0].querySelector('button'));
    expect(useTagStoreMock.getState().removeTag).toHaveBeenCalledWith(
      email, { accountId: 'acct-1', mailbox: 'INBOX' }, 't1',
    );
  });

  // A thread row is several messages. Removing the tag from the one whose
  // chip was clicked would leave the chip on screen, fed by its siblings.
  it('a thread row loses the tag from every member that carries it, and only those', () => {
    const inbox = { uid: 7, _mailbox: 'INBOX' };
    const archived = { uid: 8, _mailbox: 'Archive' };
    const untagged = { uid: 9, _mailbox: 'INBOX' };
    useTagStoreMock.setState({
      tags: [RECEIPTS],
      byRow: { 'acct-1|INBOX|7': ['t1'], 'acct-1|Archive|8': ['t1'], 'acct-1|INBOX|9': [] },
    });
    const { container } = render(<TagChips email={[inbox, archived, untagged]} />);
    fireEvent.click(chips(container)[0].querySelector('button'));

    const { removeTag } = useTagStoreMock.getState();
    // Each member is removed in its own folder — not all of them under the
    // first row's location.
    expect(removeTag).toHaveBeenCalledWith(inbox, { accountId: 'acct-1', mailbox: 'INBOX' }, 't1');
    expect(removeTag).toHaveBeenCalledWith(archived, { accountId: 'acct-1', mailbox: 'Archive' }, 't1');
    expect(removeTag.mock.calls).toHaveLength(2);
  });

  it('renders nothing when there are no tags at all', () => {
    useTagStoreMock.setState({ tags: [] });
    const { container } = render(<TagChips email={email} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the assigned set is empty', () => {
    useTagStoreMock.setState({ byRow: {} });
    const { container } = render(<TagChips email={email} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for a message whose folder cannot be resolved', () => {
    const { container } = render(<TagChips email={{ uid: 7, _mailbox: 'UNIFIED' }} />);
    expect(container.textContent).toBe('');
  });
});
