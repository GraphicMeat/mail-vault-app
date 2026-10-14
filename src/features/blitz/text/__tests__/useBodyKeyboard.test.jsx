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
      <a href="https://x.test/" data-testid="srlink">link</a>
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

  it('A and C with Shift or Alt (or Ctrl on a Mac) are not select-all: no preventDefault, still stopped', () => {
    const selectAll = vi.fn();
    const { getByTestId } = render(<Harness selectAll={selectAll} />);
    const app = vi.fn();
    window.addEventListener('keydown', app);
    for (const mods of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { shiftKey: true, altKey: true }]) {
      expect(fireEvent.keyDown(getByTestId('root'), { key: 'a', metaKey: true, ...mods })).toBe(true);
      expect(fireEvent.keyDown(getByTestId('root'), { key: 'c', metaKey: true, ...mods })).toBe(true);
    }
    expect(selectAll).not.toHaveBeenCalled();
    expect(app).not.toHaveBeenCalled();
    window.removeEventListener('keydown', app);

    const sa2 = vi.fn();
    const { getAllByTestId } = render(<Harness selectAll={sa2} isMac={false} />);
    const root2 = getAllByTestId('root')[1];
    fireEvent.keyDown(root2, { key: 'A', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(root2, { key: 'a', ctrlKey: true, altKey: true });
    expect(sa2).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(root2, { key: 'A', ctrlKey: true })).toBe(false); // plain, caps lock on
    expect(sa2).toHaveBeenCalledTimes(1);
  });

  it('a non-Latin layout still selects all through the physical key; a Latin key on another position does not', () => {
    const selectAll = vi.fn();
    const { getByTestId } = render(<Harness selectAll={selectAll} />);
    expect(fireEvent.keyDown(getByTestId('root'), { key: '\u0444', code: 'KeyA', metaKey: true })).toBe(false);
    expect(selectAll).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByTestId('root'), { key: '\u0444', code: 'KeyA', metaKey: true, shiftKey: true });
    expect(selectAll).toHaveBeenCalledTimes(1);
    // AZERTY: the physical A key types q, and Cmd+Q is not ours.
    expect(fireEvent.keyDown(getByTestId('root'), { key: 'q', code: 'KeyA', metaKey: true })).toBe(true);
    expect(selectAll).toHaveBeenCalledTimes(1);
    // Cmd+C through the physical key is left to the webview like the Latin one.
    expect(fireEvent.keyDown(getByTestId('root'), { key: '\u0441', code: 'KeyC', metaKey: true })).toBe(true);
  });

  it('Enter and Space on a focused link inside the body are left to the browser (no preventDefault)', () => {
    const app = vi.fn();
    const { getByTestId } = render(<Harness selectAll={vi.fn()} />);
    window.addEventListener('keydown', app);
    expect(fireEvent.keyDown(getByTestId('srlink'), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(getByTestId('srlink'), { key: ' ' })).toBe(true);
    expect(app).not.toHaveBeenCalled(); // stopped at the body, like the iframe's
    window.removeEventListener('keydown', app);
  });

  it('a keydown from a descendant of the root is isolated and handled too', () => {
    const selectAll = vi.fn();
    const { getByTestId } = render(<Harness selectAll={selectAll} />);
    const app = vi.fn();
    window.addEventListener('keydown', app);
    fireEvent.keyDown(getByTestId('root').querySelector('span'), { key: 'j' });
    expect(app).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(getByTestId('srlink'), { key: 'a', metaKey: true })).toBe(false);
    expect(selectAll).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', app);
  });

  it('unmount removes the listener', () => {
    const selectAll = vi.fn();
    const { getByTestId, unmount } = render(<Harness selectAll={selectAll} />);
    const root = getByTestId('root');
    unmount();
    document.body.appendChild(root); // the element outlives the component
    const app = vi.fn();
    window.addEventListener('keydown', app);
    fireEvent.keyDown(root, { key: 'a', metaKey: true });
    expect(selectAll).not.toHaveBeenCalled();
    expect(app).toHaveBeenCalledTimes(1); // nobody stops it any more
    window.removeEventListener('keydown', app);
    root.remove();
  });
});
