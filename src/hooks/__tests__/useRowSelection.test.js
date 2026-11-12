// @vitest-environment jsdom
//
// Checkbox ticks in the message list, moved out of EmailListComponent into
// useRowSelection. These pin what the code did in the component: Shift ticks
// every row between the last box ticked (or, before any, the open message)
// and this one, and the anchor is forgotten when the selection empties.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../services/workflows/bindStoreActions';

const { useMailStore } = await import('../../stores/mailStore');
const { useRowSelection } = await import('../emailList/useRowSelection');

const rows = [1, 2, 3, 4, 5].map(uid => ({ type: 'email', email: { uid } }));
const uids = call => call[0].map(e => e.uid);

const setup = (selectedEmailIds = new Set()) => {
  const setEmailsSelected = vi.fn();
  const hook = renderHook(
    props => useRowSelection({
      threadedDisplay: rows, setEmailsSelected, activeAccountId: 'a1', activeMailbox: 'INBOX', ...props,
    }),
    { initialProps: { selectedEmailIds } },
  );
  return { setEmailsSelected, ...hook };
};

beforeEach(() => {
  useMailStore.setState({
    activeAccountId: 'a1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmailId: null, selectedEmailIds: new Set(),
  });
});

describe('useRowSelection', () => {
  it('Shift ticks every row between the last box ticked and this one', () => {
    const { result, setEmailsSelected } = setup();
    act(() => result.current.checkEmailRow(2, undefined, undefined, false));
    act(() => result.current.checkEmailRow(5, undefined, undefined, true));
    expect(uids(setEmailsSelected.mock.calls[0])).toEqual([2]);
    expect(setEmailsSelected.mock.calls[0][1]).toBe(true);
    expect(uids(setEmailsSelected.mock.calls[1])).toEqual([2, 3, 4, 5]);
    expect(setEmailsSelected.mock.calls[1][1]).toBe(true);
  });

  it('a plain tick passes the toggled state of the row, read from the store', () => {
    useMailStore.setState({ selectedEmailIds: new Set([3]) });
    const { result, setEmailsSelected } = setup();
    act(() => result.current.checkEmailRow(3, undefined, undefined, false));
    expect(uids(setEmailsSelected.mock.calls[0])).toEqual([3]);
    expect(setEmailsSelected.mock.calls[0][1]).toBe(false);
  });

  it('with no box ticked yet, Shift measures from the open message', () => {
    useMailStore.setState({ selectedEmailId: 1 });
    const { result, setEmailsSelected } = setup();
    act(() => result.current.checkEmailRow(3, undefined, undefined, true));
    expect(uids(setEmailsSelected.mock.calls[0])).toEqual([1, 2, 3]);
  });

  it('forgets the anchor when the selection empties', () => {
    const { result, rerender, setEmailsSelected } = setup();
    act(() => result.current.checkEmailRow(2, undefined, undefined, false));
    rerender({ selectedEmailIds: new Set([2]) });
    rerender({ selectedEmailIds: new Set() });
    useMailStore.setState({ selectedEmailId: 1 });
    act(() => result.current.checkEmailRow(5, undefined, undefined, true));
    // The anchor fell back to the open message (1), not the stale box (2).
    expect(uids(setEmailsSelected.mock.calls[1])).toEqual([1, 2, 3, 4, 5]);
  });

  it('selKey keys a row of the open folder by its bare uid', () => {
    const { result } = setup();
    expect(result.current.selKey({ uid: 4 })).toBe(4);
  });
});
