// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('../../stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] ?? null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

vi.mock('../../services/api', () => ({
  sendNotification: vi.fn(() => Promise.resolve()),
}));

const { useFocusStore } = await import('../../stores/focusStore');
const { FocusTimerButton } = await import('../FocusTimerButton');

beforeEach(() => {
  useFocusStore.getState().abandon();
  useFocusStore.setState({ endsAt: null, held: [], durationMin: 25 });
});

afterEach(() => {
  useFocusStore.getState().abandon();
  cleanup();
  document.body.innerHTML = '';
});

describe('FocusTimerButton — idle', () => {
  it('offers the session by name', () => {
    render(<FocusTimerButton />);
    expect(screen.getByTestId('focus-button').textContent).toContain('Focus session');
  });

  it('opens the dialog, takes a preset and starts', () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));
    expect(screen.getByTestId('focus-dialog')).toBeTruthy();

    fireEvent.click(screen.getByTestId('focus-preset-45'));
    expect(screen.getByTestId('focus-preset-45').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('focus-preset-25').getAttribute('aria-pressed')).toBe('false');

    const before = Date.now();
    fireEvent.click(screen.getByTestId('focus-start'));

    const s = useFocusStore.getState();
    expect(s.durationMin).toBe(45);
    expect(s.endsAt).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(s.endsAt).toBeLessThanOrEqual(Date.now() + 45 * 60_000);
    expect(document.querySelector('[data-testid="focus-dialog"]')).toBe(null);
  });

  // Persist hydration lands after mount in the real app, so the dialog has to
  // read the remembered preset when it opens, not when the sidebar mounted.
  it('opens on the remembered preset even when it arrives after mount', () => {
    render(<FocusTimerButton />);
    act(() => useFocusStore.setState({ durationMin: 45 }));

    fireEvent.click(screen.getByTestId('focus-button'));

    expect(screen.getByTestId('focus-preset-45').getAttribute('aria-pressed')).toBe('true');
  });
});

