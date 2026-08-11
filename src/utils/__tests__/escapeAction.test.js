// Escape is shared by several layers. The bulk modal listens on `window` in
// the bubble phase and so does the global shortcut, with App mounting first —
// so the global one runs first and must not act on state the modal owns.
//
// The regression this pins: pressing Escape to minimize the bulk modal used to
// clear the selection, because the global handler saw `selectedEmailIds.size > 0`
// and had no idea a bulk session was mid-gesture. The modal then minimized and
// its bubble read "0 selected" — the one gesture documented to preserve the
// selection was the one that destroyed it. Caught by the e2e suite on real
// hardware, not by any unit test.
import { describe, it, expect } from 'vitest';
import { resolveEscapeAction } from '../escapeAction';

describe('resolveEscapeAction', () => {
  it('does nothing while the bulk modal is open, even with a selection', () => {
    // The modal minimizes itself and keeps both session and selection.
    expect(resolveEscapeAction({ bulkModalOpen: true, selectedCount: 27 })).toBe('none');
  });

  it('does nothing while the bulk modal is open even if other layers are also open', () => {
    expect(resolveEscapeAction({
      bulkModalOpen: true,
      bulkSessionActive: true,
      selectedCount: 27,
      composeOpen: true,
      settingsOpen: true,
      shortcutsOpen: true,
    })).toBe('none');
  });

  it('ends a minimized bulk session rather than emptying the selection it counts', () => {
    expect(resolveEscapeAction({ bulkSessionActive: true, selectedCount: 27 }))
      .toBe('end-bulk-session');
  });

  it('clears a plain selection when no bulk session is involved', () => {
    expect(resolveEscapeAction({ selectedCount: 3 })).toBe('clear-selection');
  });

  it('keeps the pre-existing precedence below the selection: compose, settings, shortcuts', () => {
    expect(resolveEscapeAction({ composeOpen: true, settingsOpen: true, shortcutsOpen: true }))
      .toBe('close-compose');
    expect(resolveEscapeAction({ settingsOpen: true, shortcutsOpen: true })).toBe('close-settings');
    expect(resolveEscapeAction({ shortcutsOpen: true })).toBe('close-shortcuts');
  });

  it('a selection still wins over compose/settings/shortcuts, as before', () => {
    expect(resolveEscapeAction({ selectedCount: 1, composeOpen: true, settingsOpen: true }))
      .toBe('clear-selection');
  });

  it('does nothing when nothing is open and nothing is selected', () => {
    expect(resolveEscapeAction()).toBe('none');
    expect(resolveEscapeAction({})).toBe('none');
  });
});
