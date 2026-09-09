// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// The hook now reads focusStore, which imports the notification bridge.
vi.mock('../../services/api', () => ({
  sendNotification: vi.fn(() => Promise.resolve()),
}));

const { useKeyboardShortcuts } = await import('../useKeyboardShortcuts');
const { useSettingsStore, DEFAULT_SHORTCUTS } = await import('../../stores/settingsStore');
const { useFocusStore } = await import('../../stores/focusStore');

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

  it('leaves native select navigation and type-ahead to the control', () => {
    const select = document.createElement('select');
    document.body.appendChild(select);
    press(select, 'c');
    press(select, '/');
    expect(handlers.compose).not.toHaveBeenCalled();
    expect(handlers.focusSearch).not.toHaveBeenCalled();
  });

  it('does not repeat a key already handled by a focused control', () => {
    const control = document.createElement('button');
    document.body.appendChild(control);
    control.addEventListener('keydown', event => event.preventDefault());
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    expect(handlers.compose).not.toHaveBeenCalled();
  });

  it('plain letter shortcuts stay blocked while typing', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, 'c');
    expect(handlers.compose).not.toHaveBeenCalled();
  });
});

// A locked window is the whole point of a focus session. Compose behind the
// overlay would open a window nobody can see, under a dialog that traps Tab.
describe('useKeyboardShortcuts — focus lock', () => {
  let handlers;

  beforeEach(() => {
    useSettingsStore.setState({
      keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
      keyboardShortcutsEnabled: true,
    });
    handlers = { compose: vi.fn() };
  });

  afterEach(() => {
    useFocusStore.setState({ endsAt: null });
    cleanup();
    document.body.innerHTML = '';
  });

  it('stands every app shortcut down while the app is locked', () => {
    useFocusStore.setState({ endsAt: Date.now() + 60_000 });
    renderHook(() => useKeyboardShortcuts(handlers));
    press(document.body, 'c');
    expect(handlers.compose).not.toHaveBeenCalled();
  });

  it('hands them back when the session ends', () => {
    useFocusStore.setState({ endsAt: null });
    renderHook(() => useKeyboardShortcuts(handlers));
    press(document.body, 'c');
    expect(handlers.compose).toHaveBeenCalledTimes(1);
  });
});

describe('workspace shortcut boundaries', () => {
  afterEach(cleanup);
  it('suppresses background mail actions while preserving explicitly allowed global actions', () => {
    useSettingsStore.setState({keyboardShortcuts:{...DEFAULT_SHORTCUTS},keyboardShortcutsEnabled:true});useFocusStore.setState({endsAt:null});
    const handlers={compose:vi.fn(),escape:vi.fn(),delete:vi.fn(),nextEmail:vi.fn(),goToInbox:vi.fn()};
    const {rerender}=renderHook(({allowedActions})=>useKeyboardShortcuts(handlers,{allowedActions}),{initialProps:{allowedActions:['compose','escape']}});
    for(const key of ['#','j','g','i','c','Escape'])press(document.body,key);
    expect(handlers.delete).not.toHaveBeenCalled();expect(handlers.nextEmail).not.toHaveBeenCalled();expect(handlers.goToInbox).not.toHaveBeenCalled();
    expect(handlers.compose).toHaveBeenCalledOnce();expect(handlers.escape).toHaveBeenCalledOnce();
    rerender({allowedActions:null});press(document.body,'j');expect(handlers.nextEmail).toHaveBeenCalledOnce();
  });
});
