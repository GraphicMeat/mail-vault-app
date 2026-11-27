// A thread's auto mark-read is a mark nobody asked for, like the single
// reader's (selectEmail): it must not take the undo slot, and its server half
// runs detached and quiet, off the click path.
import { describe, it, expect, vi } from 'vitest';

const mockApplyFlagToKeys = vi.fn().mockResolvedValue(undefined);
vi.mock('../messageMutations', () => ({ applyFlagToKeys: (...a) => mockApplyFlagToKeys(...a) }));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ markAsReadMode: 'immediate', markAsReadDelay: 3 }) },
}));
vi.mock('../../../stores/slices/unifiedHelpers', () => ({
  emailScopeKey: (e) => `a1-INBOX-${e.uid}`,
  selectionKey: (e) => e.uid,
}));
const state = { activeAccountId: 'a1', activeMailbox: 'INBOX', mailboxScope: null };
vi.mock('../boundStore', () => ({ useMailStore: { getState: () => state, setState: () => {} } }));

const { startThreadReadTimer } = await import('../threadReadTimer');

describe('startThreadReadTimer', () => {
  it('marks read quietly: not undoable, server half detached', async () => {
    await startThreadReadTimer('t1', { uid: 7, flags: [] });

    expect(mockApplyFlagToKeys).toHaveBeenCalledWith([7], '\\Seen', true, { undoable: false, detachTail: true });
  });
});
