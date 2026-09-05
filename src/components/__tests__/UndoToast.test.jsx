// @vitest-environment jsdom

// The toast is an affordance with a deadline; the slot behind it is not. After
// 8 s the toast goes and Cmd+Z still works, so the timer hides THIS slot's
// toast by id — a new action must bring it straight back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));

const runUndo = vi.fn().mockResolvedValue(true);
const useMailStoreMock = create(() => ({ undo: null, runUndo }));
const useComposeStoreMock = create(() => ({ pendingSend: null }));

vi.mock('../../stores/mailStore', () => ({ useMailStore: useMailStoreMock }));
vi.mock('../../stores/composeStore', () => ({ useComposeStore: useComposeStoreMock }));

const { UndoToast } = await import('../UndoToast');

let nextId = 0;
const slot = (extra = {}) => ({
  id: ++nextId, labelKey: 'undo.deleted', labelParams: { count: 2 },
  canUndo: true, run: vi.fn(), at: Date.now(), ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  runUndo.mockClear();
  useMailStoreMock.setState({ undo: null });
  useComposeStoreMock.setState({ pendingSend: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UndoToast', () => {
  it('shows nothing while the slot is empty', () => {
    render(<UndoToast />);
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });

  it('renders the slot label and an Undo button', () => {
    useMailStoreMock.setState({ undo: slot() });
    render(<UndoToast />);

    expect(screen.getByTestId('undo-toast')).toBeTruthy();
    expect(screen.getByText('Moved 2 messages to Trash')).toBeTruthy();
    expect(screen.getByTestId('undo-toast-button').textContent).toContain('Undo');
  });

  it('runs the undo when the button is clicked', () => {
    useMailStoreMock.setState({ undo: slot() });
    render(<UndoToast />);

    fireEvent.click(screen.getByTestId('undo-toast-button'));

    expect(runUndo).toHaveBeenCalledTimes(1);
  });

  it('states a permanent delete without offering a button', () => {
    useMailStoreMock.setState({ undo: slot({ labelKey: 'undo.deletedPermanently', canUndo: false, run: undefined }) });
    render(<UndoToast />);

    expect(screen.getByText('Deleted 2 messages permanently')).toBeTruthy();
    expect(screen.queryByTestId('undo-toast-button')).toBeNull();
  });

  it('hides after 8 s, and a new action brings it back', () => {
    useMailStoreMock.setState({ undo: slot() });
    render(<UndoToast />);
    expect(screen.getByTestId('undo-toast')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.queryByTestId('undo-toast')).toBeNull();

    // A NEW slot, not a repaint of the old one — the id is what the timer tracks.
    act(() => { useMailStoreMock.setState({ undo: slot({ labelKey: 'undo.starred', labelParams: { count: 1 } }) }); });
    expect(screen.getByTestId('undo-toast')).toBeTruthy();
    expect(screen.getByText('Starred 1 message')).toBeTruthy();
  });

  it('stands aside while a send is pending', () => {
    useComposeStoreMock.setState({ pendingSend: { timestamp: Date.now(), delay: 10 } });
    useMailStoreMock.setState({ undo: slot() });
    render(<UndoToast />);

    // Two "Undo" toasts on the midline is a coin toss; undo-send owns it.
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });
});
