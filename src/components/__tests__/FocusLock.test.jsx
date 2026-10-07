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

// The real scene needs WebGL, which jsdom has not got; scenes.test.js and
// view.test.js cover it. This stand-in hands back the props the lock passed.
const sceneProps = vi.hoisted(() => ({ current: null }));
vi.mock('../focus/FocusScene', () => ({
  FocusScene: (props) => {
    sceneProps.current = props;
    return React.createElement('div', { 'data-testid': 'focus-scene', 'data-scene': props.scene });
  },
}));

const { useFocusStore, useFocusClock } = await import('../../stores/focusStore');
const { FocusLock } = await import('../FocusLock');

const NOW = 1_700_000_000_000;

beforeEach(() => {
  useFocusStore.setState({ endsAt: null, held: [], durationMin: 25, scene: 'countryside' });
  useFocusClock.setState({ now: 0 });
  sceneProps.current = null;
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

  it('unlocks on the second ask, then counts the cost without scolding', () => {
    lock();
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    fireEvent.click(screen.getByTestId('focus-unlock-confirm'));

    expect(useFocusStore.getState().endsAt).toBe(null);

    const early = screen.getByTestId('focus-early');
    expect(early.textContent).toContain('Back so soon?');
    expect(early.textContent).toContain('We believe in you');
    expect(early.textContent).toContain('25 minutes');
    expect(early.textContent).toContain('01:01');

    fireEvent.click(screen.getByText("I'll finish the next one"));
    expect(document.querySelector('[data-testid="focus-early"]')).toBe(null);
  });
});

describe('FocusLock — scenes', () => {
  const timerIcon = () => document.querySelector('[data-icon="Timer"]');

  it('opens on the chosen scene, its day spanning the session, with the countdown on top', () => {
    lock({ scene: 'sea' });
    render(<FocusLock />);
    expect(screen.getByTestId('focus-scene').getAttribute('data-scene')).toBe('sea');
    expect(sceneProps.current.endsAt).toBe(NOW + 61_000);
    expect(sceneProps.current.startedAt).toBe(NOW + 61_000 - 25 * 60_000);
    expect(screen.getByTestId('focus-remaining').textContent).toBe('01:01');
    expect(timerIcon()).toBe(null);
  });

  it('is the plain lock when the scene is none', () => {
    lock({ scene: 'none' });
    render(<FocusLock />);
    expect(screen.queryByTestId('focus-scene')).toBe(null);
    expect(timerIcon()).toBeTruthy();
    expect(screen.getByTestId('focus-remaining').textContent).toBe('01:01');
  });

  it('falls back to the plain lock when the scene cannot run, and keeps counting', () => {
    lock();
    render(<FocusLock />);
    act(() => sceneProps.current.onUnavailable(new Error('no WebGL')));
    expect(screen.queryByTestId('focus-scene')).toBe(null);
    expect(timerIcon()).toBeTruthy();
    expect(screen.getByTestId('focus-remaining').textContent).toBe('01:01');
    expect(useFocusStore.getState().endsAt).toBe(NOW + 61_000);
  });

  it('gives the scene another try on the next session', () => {
    lock();
    render(<FocusLock />);
    act(() => sceneProps.current.onUnavailable());
    act(() => useFocusStore.setState({ endsAt: null }));
    act(() => lock());
    expect(screen.getByTestId('focus-scene')).toBeTruthy();
  });

  it('asks before unlocking over a scene too, and keeps the scene behind the question', () => {
    lock({ scene: 'town' });
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    expect(screen.getByText('Keep going')).toBeTruthy();
    expect(screen.getByTestId('focus-scene')).toBeTruthy();
    fireEvent.click(screen.getByTestId('focus-unlock-confirm'));
    expect(useFocusStore.getState().endsAt).toBe(null);
  });

  // The scene insets itself from the text block's height; removing the link
  // on confirm shrank the block and the diorama jumped up behind the dialog.
  it('keeps the countdown block its full height while confirming', () => {
    lock({ scene: 'town' });
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    expect(screen.getByTestId('focus-remaining')).toBeTruthy();
    const link = screen.getByTestId('focus-unlock-early');
    expect(link.style.visibility).toBe('hidden');
    fireEvent.click(screen.getByText('Keep going'));
    expect(screen.getByTestId('focus-unlock-early').style.visibility).toBe('');
  });
});

// The plain lock is also where a failed scene lands, so its confirm step is
// pinned on its own, not only through the scene mode the cases above run in.
describe('FocusLock — plain lock', () => {
  it('asks before it lets go, and takes no for an answer', () => {
    lock({ scene: 'none' });
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    expect(screen.getByText('Unlock anyway')).toBeTruthy();
    expect(screen.queryByTestId('focus-remaining')).toBe(null);
    fireEvent.click(screen.getByText('Keep going'));
    expect(screen.getByTestId('focus-remaining').textContent).toBe('01:01');
    expect(useFocusStore.getState().endsAt).toBe(NOW + 61_000);
  });

  it('unlocks on the second ask', () => {
    lock({ scene: 'none' });
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    fireEvent.click(screen.getByTestId('focus-unlock-confirm'));
    expect(useFocusStore.getState().endsAt).toBe(null);
    expect(screen.getByTestId('focus-early').textContent).toContain('Back so soon?');
  });

  it('drops the confirm step when the session ends under it', () => {
    lock({ scene: 'none' });
    render(<FocusLock />);
    fireEvent.click(screen.getByTestId('focus-unlock-early'));
    act(() => useFocusStore.setState({ endsAt: null }));
    act(() => lock({ scene: 'none' }));
    expect(screen.getByTestId('focus-remaining')).toBeTruthy();
    expect(screen.queryByText('Unlock anyway')).toBe(null);
  });
});
