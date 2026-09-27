// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(cleanup);

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
  it('a contextmenu that follows only suppresses the OS menu, it does not reopen or move the wheel', () => {
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId('row'), { button: 2, clientX: 40, clientY: 60 });
    let event;
    act(() => {
      event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 99, clientY: 99 });
      screen.getByTestId('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId('menu').dataset).toMatchObject({ x: '40', y: '60' });
  });
});
