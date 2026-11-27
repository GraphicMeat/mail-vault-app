// @vitest-environment jsdom
// The gesture hooks and the edge zone on real elements: edge back (the layer follows the finger,
// springs back, pops through backStack), the drawer opening, sheets and the drawer dragged away,
// the viewer's prev/next, the long-press hook, and who wins each conflict.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { useRef } from 'react';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));

const { default: EdgeZone } = await import('../gestures/EdgeZone.jsx');
const { useStepSwipe } = await import('../gestures/useStepSwipe.js');
const { useLongPress } = await import('../gestures/useLongPress.js');
const { default: Sheet } = await import('../Sheet.jsx');
const { default: SwipeRow } = await import('../SwipeRow.jsx');
const { PullIndicator } = await import('../MessageList.jsx');
const { pushLayer } = await import('../backStack.js');

const rect = (width, height) => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} });
let releases = [];

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
  for (const f of Object.values(haptic)) f.mockClear();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.matchMedia;
  releases.forEach((r) => r());
  releases = [];
  // A released layer takes its history entry back with a popstate; let it land before the next test.
  await new Promise((r) => setTimeout(r, 40));
});

const reduceMotion = () => { window.matchMedia = vi.fn(() => ({ matches: true })); };
const down = (el, x, y = 300) => fireEvent.pointerDown(el, { pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });
const move = (el, x, y = 300) => fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y, isPrimary: true });
const up = (el, x, y = 300) => fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y, isPrimary: true });

// The edge swipe listens on the document (no strip over the page), so a touch is fired on the
// page's own root. `pushed(layer)` registers the layer the way the app's `useBackLayer` does.
function edge(props = {}) {
  const onDrawer = vi.fn();
  const onCloseDrawer = vi.fn();
  const r = render(
    <div data-root>
      <section role="dialog" aria-modal="true" aria-label="layer" data-layer />
      <EdgeZone onOpenDrawer={onDrawer} onCloseDrawer={onCloseDrawer} {...props} />
    </div>,
  );
  const layer = r.container.querySelector('[data-layer]');
  layer.getBoundingClientRect = () => rect(400, 800);
  return { ...r, layer, zone: r.container.querySelector('[data-root]'), onDrawer, onCloseDrawer };
}
const pushed = (close, layer) => pushLayer(close, () => layer);

describe('edge swipe back', () => {
  it('the layer follows the finger without a React render', () => {
    const { zone, layer } = edge();
    releases.push(pushed(vi.fn(), layer));
    down(zone, 4);
    move(zone, 20);
    move(zone, 60);
    expect(layer.style.transform).toBe('translate3d(56px, 0, 0)');
    expect(layer.style.transition).toBe('none');
  });

  it('past a third of the width it pops the top back layer', async () => {
    reduceMotion();
    const close = vi.fn();
    const { zone, layer } = edge();
    releases.push(pushed(close, layer));
    down(zone, 4); move(zone, 40); move(zone, 160); up(zone, 160);
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('a short drag springs back and pops nothing', async () => {
    const close = vi.fn();
    const { zone, layer } = edge();
    releases.push(pushed(close, layer));
    down(zone, 4); move(zone, 30); move(zone, 80); up(zone, 80);
    expect(layer.style.transform).toBe('');
    await new Promise((r) => setTimeout(r, 30));
    expect(close).not.toHaveBeenCalled();
  });

  it('a quick flick pops even when short', async () => {
    reduceMotion();
    const close = vi.fn();
    const { zone, layer } = edge();
    releases.push(pushed(close, layer));
    down(zone, 4);
    move(zone, 30);
    await new Promise((r) => setTimeout(r, 20));
    move(zone, 70); up(zone, 70);
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it('a layer that stays (Compose asking to save) springs back after the pop', async () => {
    reduceMotion();
    const ask = vi.fn(); // Compose's requestLeave: it asks and does not close
    const { zone, layer } = edge();
    releases.push(pushed(ask, layer));
    down(zone, 4); move(zone, 40); move(zone, 200); up(zone, 200);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(layer.style.transform).toBe(''));
  });

  it('the spring is not animated under reduced motion', () => {
    reduceMotion();
    const { zone, layer } = edge();
    releases.push(pushed(vi.fn(), layer));
    down(zone, 4); move(zone, 40); move(zone, 80); up(zone, 80);
    expect(layer.style.transform).toBe('');
    expect(layer.style.transition).toBe('none');
  });

  it('a vertical drag claims nothing', () => {
    const { zone, layer } = edge();
    releases.push(pushed(vi.fn(), layer));
    down(zone, 4); move(zone, 6, 330); move(zone, 8, 420);
    expect(layer.style.transform).toBe('');
  });
});

// The drawer is mounted when the swipe is claimed and follows the finger (App.jsx mounts it without
// its entrance animation); this stands in for it.
function mountDrawer(width = 320) {
  return vi.fn(() => {
    const overlay = document.createElement('div');
    overlay.className = 'mv-overlay mv-overlay--drawer';
    overlay.innerHTML = '<div class="mv-overlay__backdrop"></div><div class="mv-drawer" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.mv-drawer').getBoundingClientRect = () => rect(width, 800);
  });
}
const drawerEl = () => document.querySelector('.mv-overlay--drawer .mv-drawer');
const backdropEl = () => document.querySelector('.mv-overlay--drawer .mv-overlay__backdrop');

describe('edge swipe on the list', () => {
  afterEach(() => { document.querySelectorAll('.mv-overlay').forEach((n) => n.remove()); });

  it('opens the folder drawer under the finger when no layer is open, with no haptic', () => {
    reduceMotion();
    const { zone, layer, onCloseDrawer } = edge({ onOpenDrawer: mountDrawer() });
    layer.remove();
    down(zone, 4); move(zone, 20); move(zone, 120);
    // dx 116 of a 320px drawer: it is 204px short of fully out, and the scrim has 116/320 of its weight.
    expect(drawerEl().style.transform).toBe('translate3d(-204px, 0, 0)');
    expect(Number(backdropEl().style.opacity)).toBeCloseTo(116 / 320, 2);
    up(zone, 200);
    expect(drawerEl().style.transform).toBe('');
    expect(onCloseDrawer).not.toHaveBeenCalled();
        expect(haptic.selection).not.toHaveBeenCalled();
    expect(haptic.impact).not.toHaveBeenCalled();
  });
  it('the drawer is asked for once, when the swipe is claimed', () => {
    const onOpenDrawer = mountDrawer();
    const { zone, layer } = edge({ onOpenDrawer });
    layer.remove();
    down(zone, 4);
    expect(onOpenDrawer).not.toHaveBeenCalled();
    move(zone, 20); move(zone, 60); move(zone, 90);
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });
  it('a short drag takes the drawer back', () => {
    reduceMotion();
    const { zone, layer, onCloseDrawer } = edge({ onOpenDrawer: mountDrawer() });
    layer.remove();
    down(zone, 4); move(zone, 30); move(zone, 50); up(zone, 50);
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);
  });
  it('a full-screen layer takes the swipe instead of the drawer', () => {
    reduceMotion();
    const onOpenDrawer = mountDrawer();
    const { zone, layer } = edge({ onOpenDrawer });
    releases.push(pushed(vi.fn(), layer));
    down(zone, 4); move(zone, 40); move(zone, 200); up(zone, 200);
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });
});

describe('arbitration: the edge zone beats the row swipe', () => {
  it('SwipeRow ignores a touch that starts in the edge zone', () => {
    const onAction = vi.fn();
    const r = render(
      <SwipeRow leading={{ label: 'Read' }} trailing={{ label: 'Del' }} onAction={onAction}>
        <button type="button" className="mv-row">row</button>
      </SwipeRow>,
    );
    const row = r.container.querySelector('.mv-row');
    down(row, 5, 20); move(row, 40, 21); move(row, 380, 22); up(row, 380, 22);
    expect(onAction).not.toHaveBeenCalled();
    expect(row.style.transform).toBe('');
  });
});

describe('arbitration: pull-to-refresh counts only from the top', () => {
  it('a pull that starts scrolled down does not refresh', () => {
    const onRefresh = vi.fn();
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollTop', { value: 30, writable: true });
    render(<PullIndicator scrollRef={{ current: scroller }} onRefresh={onRefresh} refreshing={false} />);
    const touch = (y) => ({ touches: [{ clientY: y }] });
    fireEvent(scroller, Object.assign(new Event('touchstart', { bubbles: true }), touch(100)));
    fireEvent(scroller, Object.assign(new Event('touchmove', { bubbles: true }), touch(400)));
    fireEvent(scroller, Object.assign(new Event('touchend', { bubbles: true }), { touches: [] }));
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('sheets', () => {
  function sheet(kind = 'sheet') {
    const onClose = vi.fn();
    const r = render(
      <Sheet kind={kind} label="s" onClose={onClose}>
        <div className="mv-sheet__grip" data-grip />
        <h2 className="mv-sheet__title" data-title>t</h2>
        <button type="button" data-body>body</button>
      </Sheet>,
    );
    const panel = r.container.querySelector('[role="dialog"]');
    panel.getBoundingClientRect = () => rect(kind === 'drawer' ? 320 : 400, kind === 'drawer' ? 800 : 300);
    return { ...r, panel, onClose, grip: r.container.querySelector('[data-grip]'), body: r.container.querySelector('[data-body]'), backdrop: r.container.querySelector('.mv-overlay__backdrop') };
  }

  it('dragging the grip down follows the finger and fades the backdrop', () => {
    const { grip, panel, backdrop } = sheet();
    down(grip, 200, 100); move(grip, 200, 130); move(grip, 200, 170);
    expect(panel.style.transform).toBe('translate3d(0, 70px, 0)');
    expect(Number(backdrop.style.opacity)).toBeLessThan(1);
  });
  it('past 30% of the height it dismisses', async () => {
    reduceMotion();
    const { grip, onClose } = sheet();
    down(grip, 200, 100); move(grip, 200, 130); move(grip, 200, 200); up(grip, 200, 200);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
  it('a short drag springs back', async () => {
    const { grip, panel, onClose } = sheet();
    down(grip, 200, 100); move(grip, 200, 130); move(grip, 200, 150); up(grip, 200, 150);
    expect(panel.style.transform).toBe('');
    await new Promise((r) => setTimeout(r, 30));
    expect(onClose).not.toHaveBeenCalled();
  });
  it('the header drags it too, an upward drag does not move it', () => {
    const { panel, container } = sheet();
    const title = container.querySelector('[data-title]');
    down(title, 200, 100); move(title, 200, 90); move(title, 200, 60);
    expect(panel.style.transform).toBe('');
  });
  it('a drag that starts in the body does not dismiss it', () => {
    const { body, panel, onClose } = sheet();
    down(body, 200, 200); move(body, 200, 230); move(body, 200, 400); up(body, 200, 400);
    expect(panel.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('the drawer closes by swiping it toward its edge', async () => {
    reduceMotion();
    const { body, onClose, panel } = sheet('drawer');
    down(body, 250, 300); move(body, 235, 301); move(body, 120, 302);
    expect(panel.style.transform).toBe('translate3d(-130px, 0, 0)');
    up(body, 120, 302);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
  it('a vertical move in the drawer is left to its scroll', () => {
    const { body, panel, onClose } = sheet('drawer');
    down(body, 250, 300); move(body, 252, 330); move(body, 200, 500); up(body, 200, 500);
    expect(panel.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('the click that follows a sheet drag', () => {
  it('is swallowed for a window of time, not one tick (iOS sends it late)', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const r = render(
      <Sheet kind="sheet" label="s" onClose={onClose}>
        <div className="mv-sheet__grip" data-grip />
        <button type="button" data-body>body</button>
      </Sheet>,
    );
    const panel = r.container.querySelector('[role="dialog"]');
    panel.getBoundingClientRect = () => rect(400, 300);
    const grip = r.container.querySelector('[data-grip]');
    const body = r.container.querySelector('[data-body]');
    const onTap = vi.fn();
    body.addEventListener('click', onTap);
    down(grip, 200, 100); move(grip, 200, 130); move(grip, 200, 150); up(grip, 200, 150);
    act(() => { vi.advanceTimersByTime(80); });
    fireEvent.click(body);
    expect(onTap).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.click(body);
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

describe('viewer prev/next', () => {
  function header(extra) {
    const onStep = vi.fn();
    function H() {
      const ref = useRef(null);
      useStepSwipe(ref, { onStep });
      return (
        <div ref={ref} data-header>
          <span data-text>subject</span>
          {extra}
        </div>
      );
    }
    const r = render(<H />);
    return { ...r, onStep, el: r.container.querySelector('[data-header]'), text: r.container.querySelector('[data-text]') };
  }

  it('a left swipe is next with a selection tick, a right swipe is previous', () => {
    let r = header();
    down(r.text, 300, 50); move(r.text, 280, 51); move(r.text, 200, 52); up(r.text, 200, 52);
    expect(r.onStep).toHaveBeenCalledWith('next');
    expect(haptic.selection).toHaveBeenCalledTimes(1);
    cleanup();
    r = header();
    down(r.text, 100, 50); move(r.text, 120, 51); move(r.text, 220, 52); up(r.text, 220, 52);
    expect(r.onStep).toHaveBeenCalledWith('prev');
  });
  it('a short or vertical swipe steps nowhere', () => {
    const r = header();
    down(r.text, 300, 50); move(r.text, 280, 51); move(r.text, 260, 52); up(r.text, 260, 52);
    down(r.text, 300, 50); move(r.text, 301, 80); move(r.text, 300, 150); up(r.text, 300, 150);
    expect(r.onStep).not.toHaveBeenCalled();
    expect(haptic.selection).not.toHaveBeenCalled();
  });
  it('does not start in the edge zone (that is back)', () => {
    const r = header();
    down(r.text, 8, 50); move(r.text, 30, 51); move(r.text, 150, 52); up(r.text, 150, 52);
    expect(r.onStep).not.toHaveBeenCalled();
  });
  it('does not claim a touch that starts inside horizontally scrollable content', () => {
    const wide = <div data-wide style={{ overflowX: 'auto' }}><span data-in>wide table</span></div>;
    const r = header(wide);
    const box = r.container.querySelector('[data-wide]');
    Object.defineProperty(box, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(box, 'clientWidth', { value: 300, configurable: true });
    const inner = r.container.querySelector('[data-in]');
    down(inner, 300, 50); move(inner, 280, 51); move(inner, 150, 52); up(inner, 150, 52);
    expect(r.onStep).not.toHaveBeenCalled();
  });
});

describe('long press hook', () => {
  function target(onFire) {
    function T() {
      const ref = useRef(null);
      useLongPress(ref, { onFire });
      return <div ref={ref} data-t />;
    }
    const r = render(<T />);
    return r.container.querySelector('[data-t]');
  }
  it('fires after 350ms of holding still', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const el = target(onFire);
    down(el, 100, 100);
    act(() => { vi.advanceTimersByTime(360); });
    expect(onFire).toHaveBeenCalledWith({ x: 100, y: 100 });
  });
  it('a horizontal swipe on the row cancels it, so it never fights SwipeRow', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const el = target(onFire);
    down(el, 100, 100); move(el, 120, 101);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onFire).not.toHaveBeenCalled();
  });
  it('a scroll cancels it', () => {
    vi.useFakeTimers();
    const onFire = vi.fn();
    const el = target(onFire);
    down(el, 100, 100);
    fireEvent.scroll(el);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onFire).not.toHaveBeenCalled();
  });
});
