// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { create } from 'zustand';
import { setLocale, useT } from '../../i18n/index.js';

vi.mock('lucide-react', () => {
  const icon = name => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_target, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))), has: () => true });
});

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: new Proxy({}, { get: () => React.forwardRef(({ children, ...props }, ref) => React.createElement('div', { ...props, ref }, children)) }),
}));

const cancelPendingSend = vi.fn();
const useComposeStoreMock = create(() => ({ pendingSend: null, cancelPendingSend }));
vi.mock('../../stores/composeStore', () => ({ useComposeStore: useComposeStoreMock }));

const { UndoSendToast } = await import('../UndoSendToast');

const pending = (delay, timestamp = Date.now()) => ({
  timestamp,
  delay,
  composeState: { initialData: { subject: 'A delayed note', to: 'nell@example.test' } },
});

beforeEach(async () => {
  vi.useFakeTimers();
  await setLocale('en');
  cancelPendingSend.mockReset();
  useComposeStoreMock.setState({ pendingSend: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UndoSendToast', () => {
  it('uses translated singular and plural seconds instead of a missing key', () => {
    useComposeStoreMock.setState({ pendingSend: pending(1) });
    render(<UndoSendToast />);
    expect(screen.getByTestId('undo-send-toast').textContent).toContain('1 second');

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByTestId('undo-send-toast').textContent).toContain('0 seconds');
  });

  it('switches from seconds to m:ss at the 60 second boundary and ticks', () => {
    useComposeStoreMock.setState({ pendingSend: pending(61) });
    render(<UndoSendToast />);
    expect(screen.getByTestId('undo-send-toast').textContent).toContain('1:01');

    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId('undo-send-toast').textContent).toContain('59 seconds');
  });

  it('undoes and hides without showing a sent success flash', () => {
    const restored = { initialData: { subject: 'Restored' } };
    cancelPendingSend.mockReturnValue(restored);
    const onUndo = vi.fn();
    useComposeStoreMock.setState({ pendingSend: pending(10) });
    render(<UndoSendToast onUndo={onUndo} />);

    fireEvent.click(screen.getByTestId('undo-send-btn'));
    expect(cancelPendingSend).toHaveBeenCalledTimes(1);
    expect(onUndo).toHaveBeenCalledWith(restored);
    act(() => { useComposeStoreMock.setState({ pendingSend: null }); });
    expect(screen.queryByTestId('undo-send-toast')).toBeNull();
    expect(screen.queryByText('Sent!')).toBeNull();
  });

  it('stays hidden when an in-flight send clears the undo slot', () => {
    const { rerender } = render(<UndoSendToast />);
    act(() => { useComposeStoreMock.setState({ pendingSend: pending(5) }); });
    rerender(<UndoSendToast />);
    act(() => { useComposeStoreMock.setState({ pendingSend: null }); });
    rerender(<UndoSendToast />);
    expect(screen.queryByTestId('undo-send-toast')).toBeNull();
  });

  it('re-renders the countdown when the locale changes', async () => {
    useComposeStoreMock.setState({ pendingSend: pending(5) });
    render(<UndoSendToast />);
    expect(screen.getByTestId('undo-send-toast').textContent).toContain('5 seconds');

    await act(async () => { await setLocale('es'); });
    expect(screen.getByTestId('undo-send-toast').textContent).toContain('5 segundos');
  });
});
