// @vitest-environment jsdom
// Where the phone ticks (T1): the pull past its trigger, a swipe crossing its commit point and
// committing, and the toast Undo buttons.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: SwipeRow } = await import('../SwipeRow.jsx');
const { PullIndicator, PULL_TRIGGER } = await import('../MessageList.jsx');
const { default: Toasts } = await import('../Toasts.jsx');
const { useMobileStore } = await import('../store.js');
const { dragRow } = await import('./fixtures/swipe.js');

beforeEach(() => {
  for (const f of Object.values(haptic)) f.mockClear();
});
afterEach(cleanup);

function swipe() {
  const onAction = vi.fn();
  const r = render(
    <SwipeRow leading={{ label: 'Read' }} trailing={{ label: 'Delete' }} onAction={onAction}>
      <button type="button" className="mv-row">row</button>
    </SwipeRow>,
  );
  return { row: r.container.querySelector('.mv-row'), onAction };
}

describe('SwipeRow', () => {
  it('ticks once when the drag crosses the commit point, and again when it comes back', () => {
    const { row } = swipe();
    dragRow(row, 100, { release: false });
    expect(haptic.selection).not.toHaveBeenCalled();
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 20 + 260, clientY: 22, isPrimary: true });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 20 + 280, clientY: 22, isPrimary: true });
    expect(haptic.selection).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 20 + 100, clientY: 22, isPrimary: true });
    expect(haptic.selection).toHaveBeenCalledTimes(2);
  });

  it('a swipe that commits is a medium impact, a swipe that only opens is not', () => {
    let r = swipe();
    dragRow(r.row, 120);
    expect(r.onAction).not.toHaveBeenCalled();
    expect(haptic.impact).not.toHaveBeenCalled();
    cleanup();
    r = swipe();
    dragRow(r.row, 300);
    expect(r.onAction).toHaveBeenCalledWith('leading');
    expect(haptic.impact).toHaveBeenCalledTimes(1);
    expect(haptic.impact).toHaveBeenCalledWith('medium');
  });

  it('a tap on the open action commits with the same impact', () => {
    const { row, onAction } = swipe();
    dragRow(row, 120);
    const act1 = document.querySelector('[data-mv-swipe-action="leading"]');
    fireEvent.click(act1);
    expect(onAction).toHaveBeenCalledWith('leading');
    expect(haptic.impact).toHaveBeenCalledWith('medium');
  });
});

describe('PullIndicator', () => {
  const touch = (y) => ({ touches: [{ clientY: y }] });
  function pull() {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    document.body.appendChild(el);
    const onRefresh = vi.fn();
    render(<PullIndicator scrollRef={{ current: el }} onRefresh={onRefresh} refreshing={false} />);
    return { el, onRefresh };
  }

  it('ticks once as the pull passes the trigger, not on every move', () => {
    const { el, onRefresh } = pull();
    act(() => { fireEvent.touchStart(el, touch(0)); });
    act(() => { fireEvent.touchMove(el, touch(60)); });
    expect(haptic.impact).not.toHaveBeenCalled();
    act(() => { fireEvent.touchMove(el, touch(PULL_TRIGGER * 2 + 4)); });
    act(() => { fireEvent.touchMove(el, touch(PULL_TRIGGER * 2 + 10)); });
    expect(haptic.impact).toHaveBeenCalledTimes(1);
    expect(haptic.impact).toHaveBeenCalledWith('light');
    act(() => { fireEvent.touchEnd(el); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('ticks again for a second pull', () => {
    const { el } = pull();
    for (let i = 0; i < 2; i++) {
      act(() => { fireEvent.touchStart(el, touch(0)); });
      act(() => { fireEvent.touchMove(el, touch(PULL_TRIGGER * 2 + 4)); });
      act(() => { fireEvent.touchEnd(el); });
    }
    expect(haptic.impact).toHaveBeenCalledTimes(2);
  });
});

describe('toast Undo', () => {
  it('is a light impact, for a deferred action and for an undo send', () => {
    const undoDeferred = vi.fn();
    const undoSendNow = vi.fn();
    useMobileStore.setState({ undo: { id: 'u1', kind: 'delete', count: 1 }, undoDeferred, undoSend: { id: 'o1' }, undoSendNow, notice: null });
    const { container } = render(<Toasts />);
    fireEvent.click(container.querySelector('[data-mv-undo]'));
    expect(undoDeferred).toHaveBeenCalledWith('u1');
    expect(haptic.impact).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('[data-mv-undo-send] button'));
    expect(undoSendNow).toHaveBeenCalled();
    expect(haptic.impact).toHaveBeenCalledTimes(2);
    expect(haptic.impact.mock.calls.every((c) => c[0] === 'light')).toBe(true);
    useMobileStore.setState({ undo: null, undoSend: null });
  });
});
