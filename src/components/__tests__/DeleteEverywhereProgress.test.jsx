// @vitest-environment jsdom
/**
 * Delete everywhere leaves the list at the click and runs in the daemon for as
 * long as the server takes. While it runs, a corner chip says how far it is;
 * it never blocks, and it goes when the run settles. Other bulk runs keep
 * their own panel.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});

const subs = new Set();
vi.mock('../../services/BulkOperationManager.js', () => ({
  bulkOperationManager: {
    subscribe: (listener) => { subs.add(listener); return () => subs.delete(listener); },
  },
}));
const emit = (op, meta = { settled: false, panel: false }) => act(() => { for (const l of subs) l(op, meta); });

const { DeleteEverywhereProgress, RENDER_EVERY_MS } = await import('../DeleteEverywhereProgress');
const en = (await import('../../i18n/locales/en.json')).default;
const of = (completed, total) => en['bulk.progress.completedOfTotal']
  .replace('{{completed}}', completed).replace('{{total}}', total);
const op = (o = {}) => ({ type: 'delete_everywhere', status: 'deleting', total: 362, completed: 0, ...o });
const chip = () => screen.queryByTestId('delete-everywhere-chip');

beforeEach(() => { vi.useFakeTimers(); subs.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('DeleteEverywhereProgress', () => {
  it('shows nothing until a delete everywhere runs', () => {
    render(<DeleteEverywhereProgress />);
    expect(chip()).toBeNull();
  });

  it('shows the run and its count while it runs', () => {
    render(<DeleteEverywhereProgress />);
    emit(op({ status: 'starting', completed: 0 }));
    expect(chip()).not.toBeNull();
    expect(chip().textContent).toContain(en['bulk.progress.deleting']);
    expect(chip().textContent).toContain(of(0, 362));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('goes when the run settles, whatever the outcome', () => {
    render(<DeleteEverywhereProgress />);
    emit(op({ completed: 10 }));
    expect(chip()).not.toBeNull();
    emit(op({ status: 'complete', completed: 362 }), { settled: true, panel: false });
    expect(chip()).toBeNull();
    emit(op({ completed: 1 }));
    emit(op({ status: 'error' }), { settled: true, panel: false });
    expect(chip()).toBeNull();
  });

  it('leaves other bulk runs to their own panel', () => {
    render(<DeleteEverywhereProgress />);
    emit(op({ type: 'archive', status: 'archiving' }));
    emit(op({ type: 'delete', status: 'deleting' }));
    expect(chip()).toBeNull();
  });

  it('renders a burst of counts at most once per interval', () => {
    render(<DeleteEverywhereProgress />);
    emit(op({ completed: 1 }));
    expect(chip().textContent).toContain(of(1, 362));
    for (let i = 2; i <= 50; i++) emit(op({ completed: i }));
    expect(chip().textContent).toContain(of(1, 362));
    act(() => { vi.advanceTimersByTime(RENDER_EVERY_MS); });
    expect(chip().textContent).toContain(of(50, 362));
  });

  it('picks up a run already going when it mounts', () => {
    subs.clear();
    render(<DeleteEverywhereProgress />);
    expect(subs.size).toBe(1);
  });
});
