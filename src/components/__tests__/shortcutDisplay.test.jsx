// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseKeybinding } from '../ShortcutsModal';
import { formatKeybindingDisplay } from '../settings/ShortcutsSettings';
import { DEFAULT_SHORTCUTS } from '../../stores/settingsStore';

describe('shortcut display', () => {
  it('shows Shift for the privacy binding in the shortcuts modal', () => {
    expect(parseKeybinding(DEFAULT_SHORTCUTS.togglePrivacyMode)).toEqual(['⌘', '⇧', 'P']);
  });
  it('shows Shift for the privacy binding in settings', () => {
    expect(formatKeybindingDisplay(DEFAULT_SHORTCUTS.togglePrivacyMode)).toBe('⌘⇧P');
  });
  it('leaves other bindings alone', () => {
    expect(parseKeybinding('Meta+,')).toEqual(['⌘', ',']);
    expect(parseKeybinding('Meta+z')).toEqual(['⌘', 'z']);
    expect(formatKeybindingDisplay('Meta+z')).toBe('⌘z');
    expect(formatKeybindingDisplay('j')).toBe('j');
    expect(formatKeybindingDisplay('g i')).toBe('g then i');
  });
});
