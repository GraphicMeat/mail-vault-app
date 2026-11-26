// @vitest-environment jsdom
// The row wheel on a phone: desktop's wheel (QuickActionsWheel.jsx) opened at the long press, a
// finger sliding over wedges lights them (data-hot, the centre label, a haptic tick per change)
// and letting go on one runs it; letting go anywhere else keeps the wheel for taps.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method) => {
    if (method === 'mobile.folders.list') return { folders: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Junk', name: 'Junk', specialUse: '\\Junk' }] };
    if (method === 'mobile.tags.list') return { tags: [] };
    throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
  }),
  listen: vi.fn(() => () => {}),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

const { default: RowWheel } = await import('../quickActions/RowWheel.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');
const { t } = await import('../i18n.js');

const row = { uid: 5, seen: false, flagged: false, subject: 'Hi', fromName: 'Ada', fromAddress: 'ada@example.test', dateMs: 1 };
const handlers = () => ({ onAction: vi.fn(), onMove: vi.fn(), onCompose: vi.fn(), onSelect: vi.fn() });
const wedges = () => [...document.querySelectorAll('.quick-action-radial-item')];
const wedge = (action) => document.querySelector(`.quick-action-radial-item[data-quick-action="${action}"]`);
const label = () => document.querySelector('.quick-actions-radial-center span')?.textContent;
const stubPoint = (el) => { document.elementFromPoint = vi.fn(() => el); };
const slide = (to) => act(() => { fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100, isPrimary: true, pointerType: 'touch' }); void to; });

function open(props = {}) {
  const h = handlers();
  const onClose = vi.fn();
  const view = render(<RowWheel target={{ row, key: 1, x: 180, y: 300 }} onClose={onClose} {...h} {...props} />);
  return { h, onClose, ...view };
}
const move = () => act(() => { fireEvent.pointerMove(window, { pointerId: 1, clientX: 90, clientY: 200, isPrimary: true }); });
const release = () => act(() => { fireEvent.pointerUp(window, { pointerId: 1, clientX: 90, clientY: 200, isPrimary: true }); });

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true });
  useMobileStore.setState({ prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', folders: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Junk', name: 'Junk', specialUse: '\\Junk' }], accounts: [{ id: 'a1', email: 'a@example.test' }] });
  for (const f of Object.values(haptic)) f.mockClear();
});
afterEach(() => { cleanup(); delete document.elementFromPoint; });

describe('the wheel opens as desktop\'s does', () => {
  it('is desktop\'s radial wheel, on a phone-wide window, with the phone\'s actions and Select', () => {
    open();
    expect(document.querySelector('.quick-actions-radial')).not.toBeNull();
    expect(wedges().map((w) => w.getAttribute('data-quick-action'))).toEqual(
      ['toggleRead', 'star', 'reply', 'replyAll', 'forward', 'move', 'spam', 'deleteServer', 'select'],
    );
    expect(wedge('unstar')).toBeNull();
  });

  it('shows an action only desktop has as a disabled wedge', () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, quickActions: { defaults: { row: { mode: 'radial', entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }] } } } } });
    open();
    expect(wedge('archive').disabled).toBe(true);
    expect(wedge('reply').disabled).toBe(false);
  });

  it('opens a menu where the saved layout is a menu', () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, quickActions: { defaults: { row: { mode: 'menu', entries: [{ id: 'reply', action: 'reply' }] } } } } });
    open();
    expect(document.querySelector('.quick-actions-radial')).toBeNull();
    expect(document.querySelector('.quick-actions-menu')).not.toBeNull();
  });
});

describe('a finger sliding over the wheel', () => {
  it('lights the wedge under it, names it in the centre and ticks once per change', () => {
    open();
    stubPoint(wedge('reply'));
    move();
    expect(wedge('reply').hasAttribute('data-hot')).toBe(true);
    expect(label()).toBe(t('emailActionBar.reply'));
    expect(haptic.selection).toHaveBeenCalledTimes(1);
    move();
    expect(haptic.selection).toHaveBeenCalledTimes(1);
    stubPoint(wedge('forward'));
    move();
    expect(wedge('reply').hasAttribute('data-hot')).toBe(false);
    expect(wedge('forward').hasAttribute('data-hot')).toBe(true);
    expect(haptic.selection).toHaveBeenCalledTimes(2);
    stubPoint(document.body);
    move();
    expect(wedge('forward').hasAttribute('data-hot')).toBe(false);
    expect(label()).toBeFalsy();
  });

  it('runs the wedge it lets go on, and closes', () => {
    const { h, onClose } = open();
    stubPoint(wedge('reply'));
    move();
    release();
    expect(h.onCompose).toHaveBeenCalledWith('reply', row);
    expect(onClose).toHaveBeenCalled();
  });

  it('runs Star and Select through the app\'s own paths', () => {
    let v = open();
    stubPoint(wedge('star'));
    move(); release();
    expect(v.h.onAction).toHaveBeenCalledWith('flag', expect.objectContaining({ uid: 5 }));
    cleanup();
    v = open();
    stubPoint(wedge('select'));
    move(); release();
    expect(v.h.onSelect).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }));
  });

  it('moves to Junk through the app when the account has one', async () => {
    const v = open();
    await act(async () => { await Promise.resolve(); });
    stubPoint(wedge('spam'));
    move(); release();
    expect(v.h.onMove).toHaveBeenCalledWith(expect.objectContaining({ uid: 5 }), 'Junk');
  });

  it('keeps the wheel when it lets go off every wedge, and does nothing on a disabled one', () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, quickActions: { defaults: { row: { mode: 'radial', entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }] } } } } });
    const { h, onClose } = open();
    stubPoint(document.body);
    move(); release();
    expect(onClose).not.toHaveBeenCalled();
    stubPoint(wedge('archive'));
    move(); release();
    expect(onClose).not.toHaveBeenCalled();
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it('keeps the list still while it is down: no scroll, no swipe, no tap on the row after', () => {
    const swipe = vi.fn();
    const tap = vi.fn();
    const { container } = render(
      <div className="mv-row-slot" onPointerMove={swipe} onClick={tap} data-row>
        <RowWheel target={{ row, key: 2, x: 180, y: 300 }} onClose={() => {}} {...handlers()} />
      </div>,
    );
    stubPoint(document.body);
    const slot = container.querySelector('[data-row]');
    fireEvent.pointerMove(slot, { pointerId: 1, clientX: 100, clientY: 100, isPrimary: true });
    expect(swipe).not.toHaveBeenCalled();
    const touch = new Event('touchmove', { bubbles: true, cancelable: true });
    document.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(true);
    release();
    fireEvent.click(slot);
    expect(tap).not.toHaveBeenCalled();
    // The tap after that one is a tap again.
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    fireEvent.click(slot);
    expect(tap).toHaveBeenCalledTimes(1);
    later.mockRestore();
  });
});
