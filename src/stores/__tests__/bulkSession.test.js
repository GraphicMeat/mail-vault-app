// The bulk modal's range pick has to become real list selection, and that
// selection has to outlive the modal closing — otherwise minimizing to the
// bubble silently throws the user's 27-message selection away.
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) globalThis.window = {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});

vi.mock('../../services/db', () => ({
  initDB: vi.fn().mockResolvedValue(undefined),
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getAccounts: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../services/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useMailStore } = await import('../mailStore');

beforeEach(() => {
  useMailStore.setState({
    activeMailbox: 'INBOX.Spam',
    selectedEmailIds: new Set(),
    bulkModalOpen: false,
    bulkSession: null,
  });
});

describe('bulk session', () => {
  it('setSelection replaces the selection wholesale', () => {
    useMailStore.getState().setSelection([1, 2, 3]);
    expect([...useMailStore.getState().selectedEmailIds]).toEqual([1, 2, 3]);

    useMailStore.getState().setSelection([4]);
    expect([...useMailStore.getState().selectedEmailIds]).toEqual([4]);
  });

  it('minimize keeps the session and the selection, only hides the modal', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setSelection([1, 2]);
    useMailStore.getState().setBulkSession({ step: 2, range: { type: 'all' } });

    useMailStore.getState().minimizeBulkModal();

    const s = useMailStore.getState();
    expect(s.bulkModalOpen).toBe(false);
    expect(s.bulkSession.active).toBe(true);
    expect(s.bulkSession.step).toBe(2);
    expect(s.bulkSession.range).toEqual({ type: 'all' });
    expect(s.selectedEmailIds.size).toBe(2);
  });

  it('reopening restores the step and range the session was minimized at', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setBulkSession({ step: 2, range: { type: 'year', year: 2026 } });
    useMailStore.getState().minimizeBulkModal();

    useMailStore.getState().openBulkModal();

    const s = useMailStore.getState();
    expect(s.bulkModalOpen).toBe(true);
    expect(s.bulkSession.step).toBe(2);
    expect(s.bulkSession.range).toEqual({ type: 'year', year: 2026 });
  });

  it('ending the session clears both the session and the selection', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setSelection([1, 2, 3]);

    useMailStore.getState().endBulkSession();

    const s = useMailStore.getState();
    expect(s.bulkSession).toBe(null);
    expect(s.bulkModalOpen).toBe(false);
    expect(s.selectedEmailIds.size).toBe(0);
  });

  it('a hand-edited checkbox survives minimize — the bubble count follows it', () => {
    useMailStore.getState().openBulkModal();
    useMailStore.getState().setSelection([1, 2, 3]);
    useMailStore.getState().minimizeBulkModal();

    useMailStore.getState().toggleEmailSelection(2);

    expect(useMailStore.getState().selectedEmailIds.size).toBe(2);
    expect(useMailStore.getState().bulkSession.active).toBe(true);
  });
});
