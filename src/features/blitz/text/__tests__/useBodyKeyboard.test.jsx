// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useBodyKeyboard } from '../useBodyKeyboard';

function Harness({ selectAll, isMac = true }) {
  const ref = useRef(null);
  useBodyKeyboard(ref, { selectAll, layerEl: () => ref.current?.querySelector('.mv-blitz-text'), isMac });
  return (
    <div ref={ref} tabIndex={-1} data-testid="root">
      <div className="mv-blitz-text"><span data-node="1" data-start="0">hello</span></div>
    </div>
  );
}

afterEach(cleanup); // vitest globals are off, so RTL does not unmount between tests

describe('useBodyKeyboard', () => {
  it('Cmd+A selects the body, not the app (Ctrl+A off a Mac)', () => {
    const selectAll = vi.fn();
    const { getByTestId } = render(<Harness selectAll={selectAll} />);
    const appListener = vi.fn();
    window.addEventListener('keydown', appListener);
    const ev = fireEvent.keyDown(getByTestId('root'), { key: 'a', metaKey: true });
    expect(ev).toBe(false); // defaultPrevented
    expect(selectAll).toHaveBeenCalledTimes(1);
    expect(appListener).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appListener);

    const sa2 = vi.fn();
    const { getAllByTestId } = render(<Harness selectAll={sa2} isMac={false} />);
    fireEvent.keyDown(getAllByTestId('root')[1], { key: 'a', ctrlKey: true });
    expect(sa2).toHaveBeenCalledTimes(1);
  });

  it('Escape clears a body selection and does not reach the app', () => {
    const { getByTestId } = render(<Harness selectAll={vi.fn()} />);
    const span = getByTestId('root').querySelector('span');
    const r = document.createRange(); r.selectNodeContents(span);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    const appListener = vi.fn();
    window.addEventListener('keydown', appListener);
    fireEvent.keyDown(getByTestId('root'), { key: 'Escape' });
    expect(window.getSelection().isCollapsed || window.getSelection().rangeCount === 0).toBe(true);
    expect(appListener).not.toHaveBeenCalled();
    window.removeEventListener('keydown', appListener);
  });

  it('app shortcut keys stop at the focused body like at the iframe; Tab passes; capture listeners still run', () => {
    const { getByTestId } = render(<Harness selectAll={vi.fn()} />);
    const bubble = vi.fn();
    const capture = vi.fn();
    window.addEventListener('keydown', bubble);
    document.addEventListener('keydown', capture, true);
    for (const key of ['j', 'e', '#', 'Delete']) fireEvent.keyDown(getByTestId('root'), { key });
    expect(bubble).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(4);
    fireEvent.keyDown(getByTestId('root'), { key: 'Tab' });
    expect(bubble).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', bubble);
    document.removeEventListener('keydown', capture, true);
  });

  it('Cmd+C is left to the webview (native copy fires the copy event)', () => {
    const { getByTestId } = render(<Harness selectAll={vi.fn()} />);
    expect(fireEvent.keyDown(getByTestId('root'), { key: 'c', metaKey: true })).toBe(true); // not prevented
  });

  it('a re-render with new callback identities keeps using the latest ones', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { getByTestId, rerender } = render(<Harness selectAll={first} />);
    rerender(<Harness selectAll={second} />);
    fireEvent.keyDown(getByTestId('root'), { key: 'a', metaKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
