// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMenuAtPointer } from '../useMenuAtPointer';

function Row() {
  const [menuAt, handlers] = useMenuAtPointer();
  return (
    <div data-testid="row" {...handlers}>
      {menuAt && <span data-testid="menu" data-x={menuAt.x} data-y={menuAt.y} />}
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useMenuAtPointer', () => {
  it('opens on a right-button pointerdown, at that point, with no wait for contextmenu', () => {
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 2, clientX: 40, clientY: 60 });
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '40', y: '60' });
  });

  it('ignores a left or middle pointerdown', () => {
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 0, clientX: 10, clientY: 10 });
    expect(screen.queryByTestId('menu')).toBeNull();
  });

  // Windows fires `contextmenu` on mouse-up, after pointerdown already opened
  // the wheel: it must only swallow the OS menu, never reopen or move the one
  // already on screen.
  it('a real right-click opens exactly once: contextmenu after its pointerdown does not reopen or move the wheel', () => {
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 2, clientX: 40, clientY: 60 });
    let event;
    act(() => {
      event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 99, clientY: 99 });
      screen.getByTestId('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId('menu')).toHaveLength(1);
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '40', y: '60' });
  });

  // No button-2 pointerdown ever precedes these: a bare `contextmenu` is the
  // only signal the hook gets, so it must be the fallback opener rather than
  // just an OS-menu-suppressor.
  it('opens once from a bare contextmenu with no preceding pointerdown (e.g. a touch long-press)', () => {
    render(<Row />);
    let event;
    act(() => {
      event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 15, clientY: 25 });
      screen.getByTestId('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId('menu')).toHaveLength(1);
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '15', y: '25' });
  });

  // macOS Ctrl+click is a plain button-0 mousedown with ctrlKey, turned into a
  // `contextmenu` by the OS with no button-2 pointer event ever delivered.
  it('opens exactly once on a macOS Ctrl+click (pointerdown button 0 + ctrlKey, then contextmenu)', () => {
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 0, ctrlKey: true, clientX: 12, clientY: 34 });
    expect(screen.queryByTestId('menu')).toBeNull();
    let event;
    act(() => {
      event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
      screen.getByTestId('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId('menu')).toHaveLength(1);
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '12', y: '34' });
  });

  // The keyboard Menu key / Shift+F10 fires `contextmenu` with no pointer
  // position at all (0,0): anchor to the element instead of the origin.
  it('anchors a keyboard-triggered contextmenu (0,0) to the row instead of the screen origin', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 100, top: 200, width: 40, height: 20, right: 140, bottom: 220, x: 100, y: 200, toJSON() {} });
    render(<Row />);
    let event;
    act(() => {
      event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
      screen.getByTestId('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '120', y: '210' });
    rect.mockRestore();
  });

  // Windows fires `contextmenu` on mouse-up: a right-click held a long time
  // must not have any fixed-duration expiry clear the "pointerdown already
  // opened this" flag before its own contextmenu arrives, or that contextmenu
  // opens (or moves) the wheel a second time at the release point.
  it('a right-click held past 1000ms still opens exactly once, at the pointerdown point', () => {
    vi.useFakeTimers();
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 2, clientX: 40, clientY: 60 });
    act(() => { vi.advanceTimersByTime(1000); });
    let event;
    act(() => {
      event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
      screen.getByTestId('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId('menu')).toHaveLength(1);
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '40', y: '60' });
  });

  // A right-press that never gets a matching contextmenu (dragged off,
  // cancelled, whatever) must not leave the flag wedged on: the next
  // pointerdown, whatever its button, resets it, so a later Ctrl+click is
  // never swallowed by a stale earlier right-press.
  it('a right-press with no contextmenu does not swallow a later Ctrl+click', () => {
    vi.useFakeTimers();
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 2, clientX: 40, clientY: 60 });
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 0, ctrlKey: true, clientX: 12, clientY: 34 });
    let event;
    act(() => {
      event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
      screen.getByTestId('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '12', y: '34' });
  });
});
