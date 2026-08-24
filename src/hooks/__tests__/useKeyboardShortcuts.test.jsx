// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { useSettingsStore, DEFAULT_SHORTCUTS } from '../../stores/settingsStore';

function press(target, key) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('useKeyboardShortcuts — typing targets', () => {
  let handlers;

  beforeEach(() => {
    useSettingsStore.setState({
      keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
      keyboardShortcutsEnabled: true,
    });
    handlers = { focusSearch: vi.fn(), compose: vi.fn(), escape: vi.fn() };
    renderHook(() => useKeyboardShortcuts(handlers));
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('typing / into an input types a slash instead of focusing search', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, '/');
    expect(handlers.focusSearch).not.toHaveBeenCalled();
  });

  it('typing / into a contenteditable (compose body) is not intercepted', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    document.body.appendChild(div);
    // jsdom does not compute isContentEditable from the attribute
    Object.defineProperty(div, 'isContentEditable', { value: true });
    press(div, '/');
    expect(handlers.focusSearch).not.toHaveBeenCalled();
  });

  it('pressing / outside inputs still focuses search', () => {
    press(document.body, '/');
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
  });

  it('Escape still fires from inside an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, 'Escape');
    expect(handlers.escape).toHaveBeenCalledTimes(1);
  });

  it('plain letter shortcuts stay blocked while typing', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, 'c');
    expect(handlers.compose).not.toHaveBeenCalled();
  });
});
