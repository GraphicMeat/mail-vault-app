// @vitest-environment jsdom
// Multi-select on the phone (src/mobile/selection/): the ticked rows and what they stand for, the
// row that shows a check and ticks on a tap instead of opening or swiping, the strip that sweeps,
// the header, and the bar: desktop's selection surface running each action as one engine call per
// place the ticked rows live in.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method) => {
    if (method === 'mobile.tags.list') return { tags: [] };
    if (method === 'mobile.folders.list') return { folders: [] };
    throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
  }),
  listen: vi.fn(() => () => {}),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

const { useSelection, bulkGroups, bulkCount, selectionKey } = await import('../selection/selectionStore.js');
const { rowIndexAt, span, sweepMode } = await import('../selection/sweep.js');
const { default: SweepColumn } = await import('../selection/SweepColumn.jsx');
const { default: SelectionHeader } = await import('../selection/SelectionHeader.jsx');
const { default: SelectionBar } = await import('../selection/SelectionBar.jsx');
const { default: MessageRow } = await import('../MessageRow.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');
const { t } = await import('../i18n.js');

const mk = (uid, extra = {}) => ({ uid, subject: `S${uid}`, fromName: 'Ada', fromAddress: 'a@example.test', dateMs: uid, snippet: '', seen: false, flagged: false, ...extra });
const place = (folder = 'INBOX', accountId = 'a1') => ({ accountId, folder });
const entry = (row, p = place()) => ({ row, place: p });
const FOLDERS = [{ path: 'INBOX', name: 'INBOX' }, { path: 'Archive', name: 'Archive' }, { path: 'Junk', name: 'Junk', specialUse: '\\Junk' }];
const barPrefs = (actions) => ({
  ...PREF_DEFAULTS,
  quickActions: { defaults: { selection: { mode: 'inline', selectionActionLimit: 6, selectionDisplay: 'icon-label', entries: actions.map((a) => ({ id: a, action: a })) } } },
});

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
  useSelection.setState({ active: false, items: new Map() });
  useMobileStore.setState({ prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', folders: FOLDERS, accounts: [{ id: 'a1', email: 'a@example.test' }], actMany: vi.fn() });
  for (const f of Object.values(haptic)) f.mockClear();
});
afterEach(cleanup);

describe('the ticked rows', () => {
  it('start from a row, toggle, sweep and select all, ticking the haptics for each change', () => {
    const s = useSelection.getState();
    s.begin([entry(mk(1))]);
    expect(useSelection.getState().active).toBe(true);
    expect(useSelection.getState().items.size).toBe(1);
    expect(haptic.selection).toHaveBeenCalledTimes(1);
    s.toggle(entry(mk(2)));
    expect(useSelection.getState().items.size).toBe(2);
    s.toggle(entry(mk(2)));
    expect(useSelection.getState().items.size).toBe(1);
    expect(haptic.selection).toHaveBeenCalledTimes(3);
    s.setMany([entry(mk(1))], true);
    expect(haptic.selection).toHaveBeenCalledTimes(3);
    s.selectAll([entry(mk(1)), entry(mk(3)), entry(mk(4))]);
    expect(useSelection.getState().items.size).toBe(3);
    expect(haptic.selection).toHaveBeenCalledTimes(4);
    s.end();
    expect(useSelection.getState().active).toBe(false);
    expect(useSelection.getState().items.size).toBe(0);
  });

  it('are grouped by where they live, a conversation standing for all its messages', () => {
    useSelection.getState().begin([
      entry(mk(1)), entry(mk(2, { threadCount: 3, threadUids: [2, 20, 21] })), entry(mk(5), place('Archive')), entry(mk(6), place('INBOX', 'a2')),
    ]);
    const groups = bulkGroups(useSelection.getState().items);
    expect(groups).toEqual([
      { accountId: 'a1', folder: 'INBOX', uids: [1, 2, 20, 21] },
      { accountId: 'a1', folder: 'Archive', uids: [5] },
      { accountId: 'a2', folder: 'INBOX', uids: [6] },
    ]);
    expect(bulkCount(groups)).toBe(6);
    expect(bulkGroups(useSelection.getState().items, (row) => row.uid !== 1)[0].uids).toEqual([2, 20, 21]);
  });
});

describe('sweeping', () => {
  it('finds the row under a touch and the rows between two', () => {
    expect(rowIndexAt(190, 100, 76, 10)).toBe(1);
    expect(rowIndexAt(50, 100, 76, 10)).toBe(0);
    expect(rowIndexAt(5000, 100, 76, 10)).toBe(9);
    expect(rowIndexAt(10, 0, 76, 0)).toBe(-1);
    expect(span(2, 4)).toEqual([2, 3, 4]);
    expect(span(4, 2)).toEqual([2, 3, 4]);
    expect(sweepMode(false)).toBe(true);
    expect(sweepMode(true)).toBe(false);
  });

  const rows = [1, 2, 3, 4, 5].map((n) => mk(n));
  const cache = { total: 5, rowAt: (i) => rows[i] };
  const strip = () => {
    const { container } = render(<SweepColumn cache={cache} height={76} />);
    const el = container.querySelector('[data-mv-checkcol]');
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 52, height: 380, right: 52, bottom: 380, x: 0, y: 0, toJSON() {} });
    return el;
  };
  const at = (el, type, y) => fireEvent[type](el, { pointerId: 1, clientX: 20, clientY: y, button: 0, isPrimary: true });
  const ticked = () => [...useSelection.getState().items.values()].map((e) => e.row.uid).sort();

  it('a tap ticks the row, and a drag down ticks every row it passes', () => {
    useSelection.getState().begin([]);
    const el = strip();
    at(el, 'pointerDown', 10);
    at(el, 'pointerUp', 10);
    expect(ticked()).toEqual([1]);
    at(el, 'pointerDown', 100);
    at(el, 'pointerMove', 200);
    at(el, 'pointerMove', 300);
    at(el, 'pointerUp', 300);
    expect(ticked()).toEqual([1, 2, 3, 4]);
  });

  it('starting on a ticked row unticks what it passes', () => {
    useSelection.getState().begin(rows.map((r) => entry(r)));
    const el = strip();
    at(el, 'pointerDown', 100);
    at(el, 'pointerMove', 200);
    at(el, 'pointerUp', 200);
    expect(ticked()).toEqual([1, 4, 5]);
  });
});

describe('the row while selecting', () => {
  const renderRow = (props = {}) => render(<MessageRow row={mk(7)} index={0} start={0} onOpen={props.onOpen || (() => {})} onSwipe={props.onSwipe || (() => {})} />);

  it('ticks on a tap instead of opening, shows its check, and does not swipe', () => {
    const onOpen = vi.fn();
    const { container } = renderRow({ onOpen });
    expect(container.querySelector('.mv-row__check')).toBeNull();
    fireEvent.click(container.querySelector('.mv-row-slot'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => { useSelection.getState().begin([]); });
    expect(container.querySelector('.mv-row__check')).not.toBeNull();
    expect(container.querySelector('[role="checkbox"]').getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[data-mv-swipe-action]')).toBeNull();
    fireEvent.click(container.querySelector('.mv-row-slot'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="checkbox"]').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('.mv-row__check').hasAttribute('data-checked')).toBe(true);
    // A drag does not reveal an action while selecting.
    const face = container.querySelector('.mv-row');
    fireEvent.pointerDown(face, { pointerId: 1, clientX: 30, clientY: 20, button: 0, isPrimary: true });
    fireEvent.pointerMove(face, { pointerId: 1, clientX: 60, clientY: 21, isPrimary: true });
    fireEvent.pointerMove(face, { pointerId: 1, clientX: 300, clientY: 22, isPrimary: true });
    expect(face.style.transform || '').toBe('');
  });
});

describe('the header', () => {
  const list = { total: 3, rowAt: (i) => [mk(1), mk(2), mk(3)][i] };
  it('counts, cancels and selects every loaded row', () => {
    useMobileStore.setState({ list });
    useSelection.getState().begin([entry(mk(1))]);
    const { container } = render(<SelectionHeader />);
    expect(container.querySelector('h1').textContent).toBe(t('common.selectedCount', { count: 1 }));
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === t('mobile.select.all')));
    expect(useSelection.getState().items.size).toBe(3);
    expect([...container.querySelectorAll('button')].find((b) => b.textContent === t('mobile.select.all')).disabled).toBe(true);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent === t('common.cancel')));
    expect(useSelection.getState().active).toBe(false);
  });

  it('Escape leaves selecting', () => {
    useMobileStore.setState({ list });
    useSelection.getState().begin([entry(mk(1))]);
    render(<SelectionHeader />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSelection.getState().active).toBe(false);
  });
});

describe('the bar', () => {
  const act1 = (container, action) => fireEvent.click(container.querySelector(`.quick-action-button[data-quick-action="${action}"]`));
  const bar = (actions, entries, confirm = (n, run) => run()) => {
    useMobileStore.setState({ prefs: barPrefs(actions) });
    useSelection.getState().begin(entries);
    return render(<SelectionBar confirm={confirm} />);
  };

  it('is desktop\'s bar: the count, the configured actions and Clear', () => {
    const { container } = bar(['markRead', 'star', 'deleteServer'], [entry(mk(1)), entry(mk(2))]);
    expect(container.querySelector('[data-selection-label]').textContent).toBe(t('common.selectedCount', { count: 2 }));
    expect([...container.querySelectorAll('.quick-action-button')].map((b) => b.getAttribute('data-quick-action'))).toEqual(['markRead', 'star', 'deleteServer']);
    expect(container.querySelector('button[title]')).not.toBeNull();
    fireEvent.click(container.querySelector(`button[title="${t('selection.clearSelection')}"]`));
    expect(useSelection.getState().active).toBe(false);
  });

  it('shows nothing with nothing ticked', () => {
    const { container } = bar(['markRead'], []);
    expect(container.querySelector('[data-mv-selbar]')).toBeNull();
  });

  it('marks read in one call per place, only what is unread, and keeps the ticks', () => {
    const { container } = bar(['markRead', 'markUnread'], [entry(mk(1)), entry(mk(2, { seen: true })), entry(mk(3), place('Archive'))]);
    act1(container, 'markRead');
    expect(useMobileStore.getState().actMany).toHaveBeenCalledWith('seen', [
      { accountId: 'a1', folder: 'INBOX', uids: [1] },
      { accountId: 'a1', folder: 'Archive', uids: [3] },
    ], undefined);
    expect(haptic.notify).toHaveBeenCalledWith('success');
    expect(useSelection.getState().active).toBe(true);
    // Every ticked row reads as read now: Mark as read has nothing left to do.
    expect([...useSelection.getState().items.values()].every((e) => e.row.seen)).toBe(true);
    expect(container.querySelector('.quick-action-button[data-quick-action="markRead"]').disabled).toBe(true);
  });

  it('stars in one call', () => {
    const { container } = bar(['star'], [entry(mk(1)), entry(mk(2))]);
    act1(container, 'star');
    expect(useMobileStore.getState().actMany).toHaveBeenCalledWith('flag', [{ accountId: 'a1', folder: 'INBOX', uids: [1, 2] }], undefined);
  });

  it('asks once with the count before a delete, runs it as one call, and leaves selecting', () => {
    const confirm = vi.fn();
    const { container } = bar(['deleteServer'], [entry(mk(1)), entry(mk(2, { threadCount: 2, threadUids: [2, 9] }))], confirm);
    act1(container, 'deleteServer');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toBe(3);
    expect(useMobileStore.getState().actMany).not.toHaveBeenCalled();
    act(() => { confirm.mock.calls[0][1](); });
    expect(useMobileStore.getState().actMany).toHaveBeenCalledWith('delete', [{ accountId: 'a1', folder: 'INBOX', uids: [1, 2, 9] }], undefined);
    expect(haptic.notify).toHaveBeenCalledWith('success');
    expect(useSelection.getState().active).toBe(false);
  });

  it('moves to the folder picked, and to Junk, leaving selecting', () => {
    let v = bar(['move'], [entry(mk(1)), entry(mk(2))]);
    act1(v.container, 'move');
    const pick = [...document.querySelectorAll('.mv-folder')].find((b) => b.textContent.includes('Archive'));
    fireEvent.click(pick);
    expect(useMobileStore.getState().actMany).toHaveBeenCalledWith('move', [{ accountId: 'a1', folder: 'INBOX', uids: [1, 2] }], { target: 'Archive' });
    expect(useSelection.getState().active).toBe(false);
    cleanup();
    useMobileStore.getState().actMany.mockClear();
    v = bar(['spam'], [entry(mk(1))]);
    act1(v.container, 'spam');
    expect(useMobileStore.getState().actMany).toHaveBeenCalledWith('move', [{ accountId: 'a1', folder: 'INBOX', uids: [1] }], { target: 'Junk' });
  });

  it('cannot move or send to Junk what spans two accounts', () => {
    const { container } = bar(['move', 'spam'], [entry(mk(1)), entry(mk(2), place('INBOX', 'a2'))]);
    expect(container.querySelector('.quick-action-button[data-quick-action="move"]').disabled).toBe(true);
    expect(container.querySelector('.quick-action-button[data-quick-action="spam"]').disabled).toBe(true);
  });

  it('shows what only desktop can do disabled, on desktop', () => {
    const { container } = bar(['archive'], [entry(mk(1))]);
    const b = container.querySelector('.quick-action-button[data-quick-action="archive"]');
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-label')).toBe(t('mobile.quickActions.onDesktop', { name: t('common.archive') }));
  });
});
