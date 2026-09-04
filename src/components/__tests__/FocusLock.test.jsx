// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Every icon resolves — a hand-listed set breaks the moment ui/Button or
// ui/Dialog pulls in one more glyph.
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

const { useFocusStore, useFocusClock } = await import('../../stores/focusStore');
const { FocusLock } = await import('../FocusLock');

const NOW = 1_700_000_000_000;

beforeEach(() => {
  useFocusStore.setState({ endsAt: null, held: [], durationMin: 25 });
  useFocusClock.setState({ now: 0 });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function lock(extra = {}) {
  useFocusClock.setState({ now: NOW });
  useFocusStore.setState({ endsAt: NOW + 61_000, durationMin: 25, held: [], ...extra });
}

describe('FocusLock', () => {
  it('renders nothing while no session holds the window', () => {
    const { container } = render(<FocusLock />);
    expect(container.innerHTML).toBe('');
    expect(document.querySelector('[data-testid="focus-lock"]')).toBe(null);
  });

  it('shows the countdown and the escape hatch while locked', () => {
    lock();
    render(<FocusLock />);
    expect(screen.getByTestId('focus-remaining').textContent).toBe('01:01');
    expect(screen.getByTestId('focus-unlock-early')).toBeTruthy();
  });

  it('counts what is waiting behind the lock', () => {
    lock({ held: [{ title: 'a', body: 'a' }, { title: 'b', body: 'b' }] });
    render(<FocusLock />);
    expect(screen.getByTestId('focus-held').textContent).toBe('2 notifications waiting');
  });

  it('asks before it lets go, and takes no for an answer', () => {
    lock();
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    expect(screen.getByText('Keep going')).toBeTruthy();
    expect(screen.getByText('Unlock anyway')).toBeTruthy();

    fireEvent.click(screen.getByText('Keep going'));
    expect(screen.getByTestId('focus-remaining').textContent).toBe('01:01');
    expect(useFocusStore.getState().endsAt).toBe(NOW + 61_000);
  });

  // The confirm step is local state. A session that ends under it must not
  // leave the NEXT lock opening straight on "Unlock anyway?".
  it('drops the confirm step when the session ends under it', () => {
    lock();
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    expect(screen.getByText('Unlock anyway')).toBeTruthy();

    act(() => useFocusStore.setState({ endsAt: null }));
    act(() => lock());

    expect(screen.getByTestId('focus-remaining')).toBeTruthy();
    expect(screen.queryByText('Unlock anyway')).toBe(null);
  });

  it('unlocks on the second ask, then says exactly what was broken', () => {
    lock();
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    fireEvent.click(screen.getByTestId('focus-unlock-confirm'));

    expect(useFocusStore.getState().endsAt).toBe(null);

    const shame = screen.getByTestId('focus-shame');
    expect(shame.textContent).toContain('quietly disappointed');
    expect(shame.textContent).toContain('25 minutes');
    expect(shame.textContent).toContain('01:01');

    fireEvent.click(screen.getByText("I'll do better"));
    expect(document.querySelector('[data-testid="focus-shame"]')).toBe(null);
  });
});
