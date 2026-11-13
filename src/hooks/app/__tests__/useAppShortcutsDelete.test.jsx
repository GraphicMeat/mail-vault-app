// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  sendNotification: vi.fn(() => Promise.resolve()),
}));

const { useAppShortcuts } = await import('../useAppShortcuts');
const { useSettingsStore, DEFAULT_SHORTCUTS } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');

function press(key) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const props = {
  setComposeState: vi.fn(), composeState: null, insightsOpen: false, notesOpen: false, contactsOpen: false,
  overlayOpen: false, showSettings: false, showShortcutsModal: false, setShowShortcutsModal: vi.fn(),
  closeInsights: vi.fn(), closeNotes: vi.fn(), closeContacts: vi.fn(), closeSettings: vi.fn(),
  openSettings: vi.fn(), setShowMoveDropdown: vi.fn(), setSnoozeKeys: vi.fn(),
};

// Ticked rows with a message open in the reader: the delete key used to
// delete only the open message and leave the ticked ones where they were.
describe('delete shortcut over a selection', () => {
  let deleteSelectedFromServer;
  let deleteEmailFromServer;

  beforeEach(() => {
    useSettingsStore.setState({ keyboardShortcuts: { ...DEFAULT_SHORTCUTS }, keyboardShortcutsEnabled: true });
    deleteSelectedFromServer = vi.fn(() => Promise.resolve({ deleted: [] }));
    deleteEmailFromServer = vi.fn(() => Promise.resolve());
    useMailStore.setState({
      selectedEmailIds: new Set(['a:INBOX:1', 'a:INBOX:2']),
      selectedEmailId: 'a:INBOX:3',
      selectedEmail: { uid: 3 },
      deleteSelectedFromServer,
      deleteEmailFromServer,
    });
    renderHook(() => useAppShortcuts(props));
  });

  afterEach(() => cleanup());

  it('# deletes every ticked message, not the open one', () => {
    press('#');
    expect(deleteSelectedFromServer).toHaveBeenCalledTimes(1);
    expect(deleteEmailFromServer).not.toHaveBeenCalled();
  });

  it.each(['Backspace', 'Delete'])('%s deletes the selection too', (key) => {
    press(key);
    expect(deleteSelectedFromServer).toHaveBeenCalledTimes(1);
  });

  it('with nothing ticked, deletes the open message', () => {
    useMailStore.setState({ selectedEmailIds: new Set() });
    press('Backspace');
    expect(deleteEmailFromServer).toHaveBeenCalledWith('a:INBOX:3');
    expect(deleteSelectedFromServer).not.toHaveBeenCalled();
  });

  it('Backspace inside a text field stays the field\'s', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    input.remove();
    expect(deleteSelectedFromServer).not.toHaveBeenCalled();
    expect(deleteEmailFromServer).not.toHaveBeenCalled();
  });

  it('a cleared delete binding leaves Backspace unbound', () => {
    cleanup();
    useSettingsStore.setState({ keyboardShortcuts: { ...DEFAULT_SHORTCUTS, delete: '' } });
    renderHook(() => useAppShortcuts(props));
    press('Backspace');
    expect(deleteSelectedFromServer).not.toHaveBeenCalled();
  });
});
