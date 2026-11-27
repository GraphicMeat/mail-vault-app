// @vitest-environment jsdom
// Fix wave for the gestures: the edge swipe moves the TOP back layer (not the last dialog in the
// document), the edge has no strip that eats taps, the issues sheet answers Back, and the viewer's
// prev/next slides the old message out and the new one in.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { useRef } from 'react';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async () => ({})),
  listen: vi.fn(() => () => {}),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: EdgeZone } = await import('../gestures/EdgeZone.jsx');
const { pushLayer, popTopLayer } = await import('../backStack.js');
const { default: IssuesHost } = await import('../issues/IssuesHost.jsx');
const { t } = await import('../i18n.js');

const rect = (width, height) => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} });
let releases = [];

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
  window.matchMedia = vi.fn(() => ({ matches: true }));
  try { window.sessionStorage.clear(); } catch { /* none */ }
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  delete window.matchMedia;
  releases.forEach((r) => r());
  releases = [];
  document.querySelectorAll('.mv-overlay').forEach((n) => n.remove());
  await new Promise((r) => setTimeout(r, 40));
});

const down = (el, x, y = 300) => fireEvent.pointerDown(el, { pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });
const move = (el, x, y = 300) => fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: y, isPrimary: true });
const up = (el, x, y = 300) => fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y, isPrimary: true });

describe('edge back picks the top back layer', () => {
  it('moves and pops the layer opened last, even when it renders earlier in the document', async () => {
    const closeSearch = vi.fn();
    const closeViewer = vi.fn();
    const r = render(
      <div data-root>
        <section role="dialog" aria-modal="true" aria-label="viewer" data-viewer />
        <section role="dialog" aria-modal="true" aria-label="search" data-search />
        <EdgeZone onOpenDrawer={vi.fn()} onCloseDrawer={vi.fn()} />
      </div>,
    );
    const viewer = r.container.querySelector('[data-viewer]');
    const search = r.container.querySelector('[data-search]');
    for (const el of [viewer, search]) el.getBoundingClientRect = () => rect(400, 800);
    // Search was open first, the viewer opened over it: the viewer is the top layer, though the
    // document lists it first.
    releases.push(pushLayer(closeSearch, () => search));
    releases.push(pushLayer(closeViewer, () => viewer));
    const root = r.container.querySelector('[data-root]');
    down(root, 4); move(root, 40); move(root, 160);
    expect(viewer.style.transform).toBe('translate3d(156px, 0, 0)');
    expect(search.style.transform).toBe('');
    up(root, 160);
    await waitFor(() => expect(closeViewer).toHaveBeenCalledTimes(1));
    expect(closeSearch).not.toHaveBeenCalled();
  });

  it('records the layer the app registers by a selector too, and ignores layers inside a sheet', () => {
    const r = render(
      <div data-root>
        <section role="dialog" aria-modal="true" className="mv-thread" data-thread />
        <div className="mv-overlay"><section role="dialog" aria-modal="true" className="mv-thread" data-inside /></div>
        <EdgeZone onOpenDrawer={vi.fn()} onCloseDrawer={vi.fn()} />
      </div>,
    );
    const thread = r.container.querySelector('[data-thread]');
    thread.getBoundingClientRect = () => rect(400, 800);
    releases.push(pushLayer(vi.fn(), '.mv-thread'));
    const root = r.container.querySelector('[data-root]');
    down(root, 4); move(root, 40); move(root, 100);
    expect(thread.style.transform).toBe('translate3d(96px, 0, 0)');
    expect(r.container.querySelector('[data-inside]').style.transform).toBe('');
  });
});

describe('the edge never eats a tap', () => {
  it('has no strip over the page, and a tap at x=5 is left to what is under it', () => {
    const onMenu = vi.fn();
    const onOpenDrawer = vi.fn();
    const r = render(
      <div>
        <button type="button" onClick={onMenu}>menu</button>
        <EdgeZone onOpenDrawer={onOpenDrawer} onCloseDrawer={vi.fn()} />
      </div>,
    );
    expect(document.querySelector('.mv-edge, [data-mv-edge]')).toBeNull();
    const menu = r.container.querySelector('button');
    down(menu, 5, 40); up(menu, 5, 40);
    fireEvent.click(menu);
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });

  it('a horizontal drag that starts on a row at x=5 still opens the drawer', () => {
    const onOpenDrawer = vi.fn(() => {
      const overlay = document.createElement('div');
      overlay.className = 'mv-overlay mv-overlay--drawer';
      overlay.innerHTML = '<div class="mv-overlay__backdrop"></div><div class="mv-drawer"></div>';
      document.body.appendChild(overlay);
      overlay.querySelector('.mv-drawer').getBoundingClientRect = () => rect(320, 800);
    });
    const r = render(
      <div>
        <button type="button" className="mv-row">row</button>
        <EdgeZone onOpenDrawer={onOpenDrawer} onCloseDrawer={vi.fn()} />
      </div>,
    );
    const row = r.container.querySelector('.mv-row');
    down(row, 5, 40); move(row, 30, 41); move(row, 120, 42);
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
  });

  it('listens on the document with passive listeners, so it never blocks a scroll', () => {
    const add = vi.spyOn(document, 'addEventListener');
    render(<EdgeZone onOpenDrawer={vi.fn()} onCloseDrawer={vi.fn()} />);
    const downs = add.mock.calls.filter(([type]) => type === 'pointerdown');
    expect(downs.length).toBeGreaterThan(0);
    for (const [, , opts] of downs) expect(opts).toMatchObject({ passive: true });
  });

  it('ignores a touch that starts on a sheet or the drawer (they own their drag)', () => {
    const onOpenDrawer = vi.fn();
    const r = render(
      <div>
        <div className="mv-overlay"><div className="mv-drawer" data-in /></div>
        <EdgeZone onOpenDrawer={onOpenDrawer} onCloseDrawer={vi.fn()} />
      </div>,
    );
    const inside = r.container.querySelector('[data-in]');
    down(inside, 5); move(inside, 30); move(inside, 150); up(inside, 150);
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });
});

describe('the issues sheet answers system Back', () => {
  it('Back closes the sheet instead of leaving the app', async () => {
    render(<IssuesHost accounts={[{ id: 'a1', email: 'ada@gmail.test', needsAuth: true, oauth: true }]} onUpdatePassword={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.issues.fix') }));
    expect(document.querySelector('.mv-overlay [role="dialog"]')).not.toBeNull();
    expect(popTopLayer()).toBe(true);
    await waitFor(() => expect(document.querySelector('.mv-overlay [role="dialog"]')).toBeNull());
  });
});

describe('the viewer steps with a slide', () => {
  let hook;
  async function load() {
    hook = (await import('../gestures/useStepSlide.js')).useStepSlide;
  }
  function Harness({ onStep }) {
    const root = useRef(null);
    const slide = hook(root, { onStep });
    return (
      <section ref={root} data-root>
        <button type="button" data-next onClick={() => slide('next')}>n</button>
        <button type="button" data-prev onClick={() => slide('prev')}>p</button>
      </section>
    );
  }

  it('the old message slides out toward the swipe, then the step runs', async () => {
    await load();
    let seen = null;
    const onStep = vi.fn(() => { seen = document.querySelector('[data-root]').style.transform; return true; });
    const r = render(<Harness onStep={onStep} />);
    fireEvent.click(r.container.querySelector('[data-next]'));
    expect(onStep).toHaveBeenCalledWith('next');
    expect(seen).toBe('translate3d(-100%, 0, 0)');
    cleanup();
    const prev = vi.fn(() => { seen = document.querySelector('[data-root]').style.transform; return true; });
    const r2 = render(<Harness onStep={prev} />);
    fireEvent.click(r2.container.querySelector('[data-prev]'));
    expect(seen).toBe('translate3d(100%, 0, 0)');
  });

  it('a step with nowhere to go brings the message back', async () => {
    await load();
    const r = render(<Harness onStep={() => false} />);
    fireEvent.click(r.container.querySelector('[data-next]'));
    expect(r.container.querySelector('[data-root]').style.transform).toBe('');
  });

  it('the next message slides in from the side it was swiped to, and a plain mount does not', async () => {
    await load();
    // A plain mount: nothing to animate.
    const first = render(<Harness onStep={() => true} />);
    expect(first.container.querySelector('[data-root]').style.transition).toBe('');
    fireEvent.click(first.container.querySelector('[data-next]'));
    cleanup();
    // The viewer for the next message mounts: it comes in with a transition (reduced motion off).
    window.matchMedia = vi.fn(() => ({ matches: false }));
    const second = render(<Harness onStep={() => true} />);
    expect(second.container.querySelector('[data-root]').style.transition).toContain('transform');
    cleanup();
    // And only once: the one after that is a plain mount again.
    const third = render(<Harness onStep={() => true} />);
    expect(third.container.querySelector('[data-root]').style.transition).toBe('');
  });

  it('reduced motion steps at once, with no transition', async () => {
    await load();
    const onStep = vi.fn(() => true);
    const r = render(<Harness onStep={onStep} />);
    fireEvent.click(r.container.querySelector('[data-next]'));
    cleanup();
    const next = render(<Harness onStep={onStep} />);
    expect(next.container.querySelector('[data-root]').style.transition).toBe('none');
    expect(next.container.querySelector('[data-root]').style.transform).toBe('');
  });
});
