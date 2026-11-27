// @vitest-environment jsdom
// Fix wave for multi-select: Select all reads the page cache when it changes, not on every render,
// and a sweep that is dragged back restores the rows it passed (iOS behaviour).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async () => ({})),
  listen: vi.fn(() => () => {}),
}));

const { useSelection } = await import('../selection/selectionStore.js');
const { default: SweepColumn } = await import('../selection/SweepColumn.jsx');
const { default: SelectionHeader } = await import('../selection/SelectionHeader.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');
const { t } = await import('../i18n.js');

const mk = (uid) => ({ uid, subject: `S${uid}`, fromName: 'Ada', fromAddress: 'a@example.test', dateMs: uid, snippet: '', seen: false, flagged: false });
const entry = (row) => ({ row, place: { accountId: 'a1', folder: 'INBOX' } });

beforeEach(() => {
  useSelection.setState({ active: false, items: new Map() });
  useMobileStore.setState({ prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', accounts: [{ id: 'a1', email: 'a@example.test' }] });
});
afterEach(cleanup);

describe('the header reads the cache, not every render', () => {
  function fakeList(rows) {
    const listeners = new Set();
    return {
      rows,
      get total() { return this.rows.length; },
      rowAt: vi.fn(function rowAt(i) { return this.rows[i]; }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      emit: () => listeners.forEach((fn) => fn()),
    };
  }
  const all = (c) => [...c.querySelectorAll('button')].find((b) => b.textContent === t('mobile.select.all'));

  it('does not scan the rows again when only the count changes', () => {
    const list = fakeList([mk(1), mk(2), mk(3)]);
    useMobileStore.setState({ list });
    useSelection.getState().begin([entry(mk(1))]);
    const { container } = render(<SelectionHeader />);
    const scanned = list.rowAt.mock.calls.length;
    act(() => { useSelection.getState().toggle(entry(mk(2))); });
    act(() => { useSelection.getState().toggle(entry(mk(3))); });
    act(() => { useSelection.getState().toggle(entry(mk(3))); });
    expect(list.rowAt.mock.calls.length).toBe(scanned);
    expect(all(container).disabled).toBe(false);
  });

  it('follows the cache as pages load', () => {
    const list = fakeList([mk(1)]);
    useMobileStore.setState({ list });
    useSelection.getState().begin([entry(mk(1))]);
    const { container } = render(<SelectionHeader />);
    expect(all(container).disabled).toBe(true);
    act(() => { list.rows = [mk(1), mk(2), mk(3)]; list.emit(); });
    expect(all(container).disabled).toBe(false);
    fireEvent.click(all(container));
    expect(useSelection.getState().items.size).toBe(3);
  });
});

describe('a sweep dragged back restores the rows', () => {
  const rows = [1, 2, 3, 4, 5].map(mk);
  const cache = { total: 5, rowAt: (i) => rows[i] };
  const strip = () => {
    const { container } = render(<SweepColumn cache={cache} height={76} />);
    const el = container.querySelector('[data-mv-checkcol]');
    el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 52, height: 380, right: 52, bottom: 380, x: 0, y: 0, toJSON() {} });
    return el;
  };
  const at = (el, type, y) => fireEvent[type](el, { pointerId: 1, clientX: 20, clientY: y, button: 0, isPrimary: true });
  const ticked = () => [...useSelection.getState().items.values()].map((e) => e.row.uid).sort();

  it('ticking: back over a row unticks it again', () => {
    useSelection.getState().begin([]);
    const el = strip();
    at(el, 'pointerDown', 10); // row 1
    at(el, 'pointerMove', 200); // rows 1..3
    at(el, 'pointerMove', 300); // rows 1..4
    expect(ticked()).toEqual([1, 2, 3, 4]);
    at(el, 'pointerMove', 120); // back to row 2
    expect(ticked()).toEqual([1, 2]);
    at(el, 'pointerUp', 120);
    expect(ticked()).toEqual([1, 2]);
  });

  it('ticking: a row that was ticked before the sweep stays ticked when the sweep backs off it', () => {
    useSelection.getState().begin([entry(rows[3])]);
    const el = strip();
    at(el, 'pointerDown', 10);
    at(el, 'pointerMove', 300); // rows 1..4, row 4 was already ticked
    at(el, 'pointerMove', 120); // back to row 2
    expect(ticked()).toEqual([1, 2, 4]);
  });

  it('unticking: back over a row ticks it again', () => {
    useSelection.getState().begin(rows.map(entry));
    const el = strip();
    at(el, 'pointerDown', 10); // row 1 is ticked: unticks
    at(el, 'pointerMove', 300); // rows 1..4 unticked
    expect(ticked()).toEqual([5]);
    at(el, 'pointerMove', 120); // back to row 2
    expect(ticked()).toEqual([3, 4, 5]);
  });

  it('dragging past the start toward the other side works from the start row', () => {
    useSelection.getState().begin([]);
    const el = strip();
    at(el, 'pointerDown', 200); // row 3
    at(el, 'pointerMove', 300); // rows 3..4
    expect(ticked()).toEqual([3, 4]);
    at(el, 'pointerMove', 20); // rows 1..3, row 4 restored
    expect(ticked()).toEqual([1, 2, 3]);
  });
});
