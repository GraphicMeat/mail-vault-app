// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';

import '../../../services/workflows/bindStoreActions';

const order = [];
vi.mock('../../../utils/notificationOpen', () => ({
  openNotificationTarget: vi.fn(async target => { order.push(['open', target, useNotesStore.getState().isOpen]); }),
}));

const { useOverlayPages } = await import('../useOverlayPages');
const { useNotesStore } = await import('../../../stores/notesStore');
const { openNotificationTarget } = await import('../../../utils/notificationOpen');

beforeEach(() => { order.length = 0; });
afterEach(() => { cleanup(); useNotesStore.setState({ isOpen: false }); });

describe('openMailTarget', () => {
  it('closes the open page before opening the email', async () => {
    useNotesStore.setState({ isOpen: true });
    const { result } = renderHook(() => useOverlayPages());
    const target = { accountId: 'a1', mailbox: 'INBOX', uid: 4 };
    await act(async () => { await result.current.openMailTarget(target); });
    expect(openNotificationTarget).toHaveBeenCalledWith(target, expect.any(Function));
    expect(order).toEqual([['open', target, false]]);
  });
});
