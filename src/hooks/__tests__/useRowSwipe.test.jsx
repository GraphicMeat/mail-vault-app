// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

vi.mock('../../stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useRowSwipe } = await import('../useRowSwipe');
const { registerRowActions } = await import('../../utils/rowActionRegistry');
const { useSettingsStore } = await import('../../stores/settingsStore');

// Stands in for RowQuickActions: the row's own quick-action descriptors,
// registered on the row the way the real component registers them.
const activated = vi.fn();
const describeRef = {
  current: (entry) => ({ id: entry.id, action: entry.action, disabled: false, onActivate: (event) => activated(entry.action, event) }),
};

function List() {
  const ref = useRef(null);
  const active = useRowSwipe(ref, {
    enabled: true,
    resolveRow: (el) => {
      const wrapper = el.closest('[data-index]');
      const row = wrapper?.querySelector('.virtual-row');
      return row ? { index: Number(wrapper.dataset.index), row, wrapper } : null;
    },
  });
  return (
    <div ref={ref}>
      <div data-index="0" data-testid="wrapper">
        {active && <span data-testid="backdrop" data-side={active.side} data-action={active.action} />}
        <div className="virtual-row" data-testid="row">
          <span hidden data-row-actions ref={(node) => registerRowActions(node, describeRef)} />
          A message
        </div>
      </div>
    </div>
  );
}

function wheel(deltaX, deltaY = 0) {
  const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true });
  act(() => { screen.getByTestId('row').dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  activated.mockClear();
  useSettingsStore.setState({ trackpadSwipeEnabled: true, swipeLeftAction: 'archive', swipeRightAction: 'toggleRead' });
  render(<List />);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRowSwipe', () => {
  it('a committed left swipe runs the configured left action on that row', () => {
    let last;
    for (let i = 0; i < 10; i++) last = wheel(16);
    expect(last.defaultPrevented).toBe(true);
    expect(screen.getByTestId('backdrop').dataset).toMatchObject({ side: 'left', action: 'archive' });
    act(() => { vi.advanceTimersByTime(200); });
    expect(activated).toHaveBeenCalledTimes(1);
    expect(activated.mock.calls[0][0]).toBe('archive');
    // Anchored to the untranslated wrapper, so a picker opens over the row.
    expect(activated.mock.calls[0][1].currentTarget).toBe(screen.getByTestId('wrapper'));
    expect(screen.queryByTestId('backdrop')).toBeNull();
  });

  it('a committed right swipe runs the right action', () => {
    for (let i = 0; i < 10; i++) wheel(-16);
    act(() => { vi.advanceTimersByTime(200); });
    expect(activated).toHaveBeenCalledWith('toggleRead', expect.anything());
  });

  it('a short swipe does nothing', () => {
    for (let i = 0; i < 4; i++) wheel(10);
    act(() => { vi.advanceTimersByTime(200); });
    expect(activated).not.toHaveBeenCalled();
  });

  it('a vertical scroll is never taken from the list', () => {
    const events = [wheel(0, 20), wheel(3, 30), wheel(0, 40)];
    expect(events.some(e => e.defaultPrevented)).toBe(false);
    act(() => { vi.advanceTimersByTime(200); });
    expect(activated).not.toHaveBeenCalled();
  });

  it('a side set to none moves nothing and runs nothing', () => {
    act(() => { useSettingsStore.setState({ swipeLeftAction: 'none' }); });
    for (let i = 0; i < 10; i++) wheel(16);
    expect(screen.queryByTestId('backdrop')).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(activated).not.toHaveBeenCalled();
  });
});
