// @vitest-environment jsdom
//
// A floating panel — a row menu, its Move-to-folder submenu, a sender popover —
// used to be placed by its anchor alone: `top = button.bottom + 4`, whatever
// the window's height. On a row near the bottom edge the panel ran off the
// window, and the only way to reach its last items was to scroll the list up
// and try again (bson73, discussion #1, 2026-09-03). This is the one sum every
// floating element now runs: how far to move to sit inside the viewport.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { render, cleanup } from '@testing-library/react';
import { viewportShift, useViewportShift, VIEWPORT_MARGIN } from '../useViewportShift';

const VIEW = { width: 1200, height: 800 };
const box = (top, left, height, width) => [{ top, left, width, height }, { width, height }];

describe('viewportShift', () => {
  it('leaves a panel that fits alone', () => {
    expect(viewportShift(...box(100, 100, 200, 160), VIEW)).toEqual({ x: 0, y: 0 });
  });

  it('lifts a panel that would run off the bottom until its bottom edge sits at the margin', () => {
    expect(viewportShift(...box(700, 100, 200, 160), VIEW)).toEqual({ x: 0, y: 800 - VIEWPORT_MARGIN - 900 });
  });

  it('pushes a panel that would start above the top down to the margin', () => {
    expect(viewportShift(...box(-40, 100, 200, 160), VIEW)).toEqual({ x: 0, y: VIEWPORT_MARGIN + 40 });
  });

  it('pins the top edge when the panel is taller than the window', () => {
    // The first items must stay reachable; the bottom may clip.
    expect(viewportShift(...box(300, 100, 1000, 160), VIEW).y).toBe(VIEWPORT_MARGIN - 300);
  });

  it('pulls a panel that runs off the right edge back in', () => {
    expect(viewportShift(...box(100, 1100, 200, 300), VIEW)).toEqual({ x: 1200 - VIEWPORT_MARGIN - 1400, y: 0 });
  });

  it('measures the layout box, not the mid-animation scaled one', () => {
    // framer scales the panel about its centre while it opens, so the rect is
    // 95% of the layout size. The sum must place the size the panel will have.
    const layout = { width: 160, height: 200 };
    const scaled = { top: 705, left: 104, width: 152, height: 190 };
    expect(viewportShift(scaled, layout, VIEW)).toEqual({ x: 0, y: 800 - VIEWPORT_MARGIN - 900 });
  });
});

// jsdom lays nothing out: every rect is zero and every offset is zero. The
// panel's geometry is stubbed on the prototype, keyed on the element under
// test, and restored after each case.
const descriptors = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};
export function stubGeometry(isTarget, rect, size) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (!isTarget(this)) return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
    return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height };
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return isTarget(this) ? size.width : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return isTarget(this) ? size.height : 0; } });
}
export function restoreGeometry() {
  vi.restoreAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptors.offsetWidth);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptors.offsetHeight);
}

describe('useViewportShift', () => {
  afterEach(() => { cleanup(); restoreGeometry(); });

  function Panel({ enabled = true }) {
    const ref = useRef(null);
    useViewportShift(ref, enabled);
    return <div ref={ref} data-testid="panel" />;
  }
  const isPanel = (el) => el.dataset?.testid === 'panel';

  it('moves a panel that would run off the bottom back inside', () => {
    window.innerWidth = 1200; window.innerHeight = 800;
    stubGeometry(isPanel, { top: 700, left: 100, width: 160, height: 200 }, { width: 160, height: 200 });
    const { getByTestId } = render(<Panel />);
    expect(getByTestId('panel').dataset.viewportShift).toBe('0,-108');
  });

  it('touches a panel that fits not at all', () => {
    window.innerWidth = 1200; window.innerHeight = 800;
    stubGeometry(isPanel, { top: 100, left: 100, width: 160, height: 200 }, { width: 160, height: 200 });
    const { getByTestId } = render(<Panel />);
    expect(getByTestId('panel').dataset.viewportShift).toBeUndefined();
  });

  it('does nothing while disabled', () => {
    window.innerWidth = 1200; window.innerHeight = 800;
    stubGeometry(isPanel, { top: 700, left: 100, width: 160, height: 200 }, { width: 160, height: 200 });
    const { getByTestId } = render(<Panel enabled={false} />);
    expect(getByTestId('panel').dataset.viewportShift).toBeUndefined();
  });
});
