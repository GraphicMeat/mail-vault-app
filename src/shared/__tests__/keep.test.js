// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  MAX_KEPT, DEFAULT_DOCK, keepId, senderKey, restoreKeep, withToggled, withoutSender, withoutId, keepActions,
  keptStacks, bubbleLabel, snapDock, nudgeDock,
} from '../keep.js';

const entry = (uid, address = 'sam@x', extra = {}) => ({
  accountId: 'a1', mailbox: 'INBOX', uid, subject: `s${uid}`, sender: { name: 'Sam', address }, ...extra,
});
const kept = (uid, keptAt, address, extra) => ({ ...entry(uid, address, extra), keptAt });

describe('keepId', () => {
  it('names account, folder and uid', () => {
    expect(keepId({ accountId: 'a1', mailbox: 'INBOX', uid: 7 })).toBe('a1|INBOX|7');
  });
});

describe('keptStacks', () => {
  it('stacks emails from one sender, newest first', () => {
    const items = [kept(1, 10, 'Sam@x'), kept(2, 30, 'sam@x'), kept(3, 20, 'SAM@x'), kept(4, 5, 'lena@x')];
    const stacks = keptStacks(items, ['a1']);
    expect(stacks).toHaveLength(2);
    expect(stacks[0].items.map(i => i.uid)).toEqual([2, 3, 1]);
  });
  it('orders stacks by their newest kept email', () => {
    const items = [kept(1, 10, 'lena@x'), kept(2, 30, 'sam@x'), kept(3, 20, 'lena@x')];
    expect(keptStacks(items, ['a1']).map(s => s.key)).toEqual(['sam@x', 'lena@x']);
  });
  it('drops kept email after account removal', () => {
    const items = [kept(1, 10, 'sam@x'), { ...kept(2, 20, 'sam@x'), accountId: 'a2' }, { ...kept(3, 30, 'gone@x'), accountId: 'a2' }];
    const stacks = keptStacks(items, ['a1']);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].items.map(i => i.uid)).toEqual([1]);
  });
});

describe('senderKey', () => {
  it('falls back to the name, then the id', () => {
    expect(senderKey({ sender: { name: 'Sam', address: '' } })).toBe('sam');
    expect(senderKey({ accountId: 'a', mailbox: 'M', uid: 1, sender: { name: '', address: '' } })).toBe('a|m|1');
  });
});

describe('bubbleLabel', () => {
  const stack = (n, sender) => ({ sender, items: Array.from({ length: n }, (_, i) => kept(i + 1, i)) });
  it('shows the count for a group and the initial for one email', () => {
    expect(bubbleLabel(stack(3, { name: 'Sam' }))).toBe('3');
    expect(bubbleLabel(stack(12, { name: 'Sam' }))).toBe('12');
    expect(bubbleLabel(stack(1, { name: 'lena Ortiz' }))).toBe('L');
    expect(bubbleLabel(stack(1, { name: '', address: 'x@y' }))).toBe('X');
    expect(bubbleLabel(stack(1, { name: '', address: '' }))).toBe('?');
  });
  it('takes a whole character, not half a surrogate pair', () => {
    expect(bubbleLabel(stack(1, { name: '\u{1D4D0}ria' }))).toBe('\u{1D4D0}');
  });
});

describe('withToggled', () => {
  it('keeps newest first and removes on the second toggle', () => {
    const one = withToggled([], entry(1), 10);
    const two = withToggled(one, entry(2), 20);
    expect(two.map(i => i.uid)).toEqual([2, 1]);
    expect(two[0].keptAt).toBe(20);
    expect(withToggled(two, entry(2), 30).map(i => i.uid)).toEqual([1]);
  });
  it('keeps one entry per message', () => {
    const once = withToggled([], entry(1), 10);
    expect(withToggled(once, entry(1), 20)).toEqual([]);
  });
  it('drops the oldest past twenty', () => {
    let items = [];
    for (let uid = 1; uid <= MAX_KEPT + 1; uid++) items = withToggled(items, entry(uid), uid);
    expect(items).toHaveLength(MAX_KEPT);
    expect(items.some(i => i.uid === 1)).toBe(false);
    expect(items[0].uid).toBe(MAX_KEPT + 1);
  });
});

describe('withoutSender', () => {
  it("removes only that sender's stack", () => {
    const items = [kept(1, 1, 'sam@x'), kept(2, 2, 'lena@x'), kept(3, 3, 'sam@x')];
    expect(withoutSender(items, 'sam@x').map(i => i.uid)).toEqual([2]);
  });
});

describe('restoreKeep', () => {
  const valid = kept(9, 5, 'sam@x');
  it('keeps only well-formed items and dock', () => {
    expect(restoreKeep({ items: 42, dock: { side: 'top', top: 'x' } })).toEqual({ items: [], dock: DEFAULT_DOCK });
    const restored = restoreKeep({
      items: [null, { uid: 'x' }, { accountId: 5, mailbox: 'INBOX', uid: 1 }, valid, valid],
      dock: { side: 'top', top: 'x' },
    });
    expect(restored.items).toEqual([valid]);
    expect(restored.dock).toEqual(DEFAULT_DOCK);
    expect(restoreKeep(null)).toEqual({ items: [], dock: DEFAULT_DOCK });
  });
  it('cuts a long subject and defaults a missing sender', () => {
    const [item] = restoreKeep({ items: [{ accountId: 'a', mailbox: 'M', uid: 1, keptAt: 1, subject: 'x'.repeat(900) }] }).items;
    expect(item.subject).toHaveLength(512);
    expect(item.sender).toEqual({ name: '', address: '' });
  });
  it('keeps a valid dock and at most twenty items', () => {
    const items = Array.from({ length: 30 }, (_, i) => kept(i + 1, i, 'sam@x'));
    const restored = restoreKeep({ items, dock: { side: 'left', top: 0.2 } });
    expect(restored.items).toHaveLength(MAX_KEPT);
    expect(restored.dock).toEqual({ side: 'left', top: 0.2 });
  });
});

describe('snapDock', () => {
  const viewport = { width: 1000, height: 800 };
  it('snaps to the nearer edge', () => {
    expect(snapDock({ left: 100, top: 400, width: 44, height: 60 }, viewport)).toEqual({ side: 'left', top: 0.5 });
    expect(snapDock({ left: 800, top: 400, width: 44, height: 60 }, viewport).side).toBe('right');
  });
  it('keeps the dock on screen above the bottom bar', () => {
    expect(snapDock({ left: 0, top: -50, width: 44, height: 60 }, viewport).top).toBe(0.04);
    const low = snapDock({ left: 0, top: 790, width: 44, height: 60 }, viewport);
    expect(low.top).toBeCloseTo((800 - 60 - 72) / 800);
  });
});

describe('nudgeDock', () => {
  it('moves 5 % and switches side with arrows', () => {
    const dock = { side: 'right', top: 0.4 };
    expect(nudgeDock(dock, 'ArrowLeft')).toEqual({ side: 'left', top: 0.4 });
    expect(nudgeDock(dock, 'ArrowRight')).toEqual(dock);
    expect(nudgeDock(dock, 'ArrowDown').top).toBeCloseTo(0.45);
    expect(nudgeDock(dock, 'ArrowUp').top).toBeCloseTo(0.35);
    expect(nudgeDock({ side: 'left', top: 0.04 }, 'ArrowUp').top).toBe(0.04);
    expect(nudgeDock(dock, 'a')).toBe(dock);
  });
  it('keeps the dock above the bottom bar when its height is known', () => {
    const fit = { height: 66, viewportHeight: 800 };
    const low = nudgeDock({ side: 'right', top: 0.8 }, 'ArrowDown', fit);
    expect(low.top).toBeCloseTo((800 - 66 - 72) / 800);
    expect(nudgeDock({ side: 'right', top: 0.4 }, 'ArrowDown', fit).top).toBeCloseTo(0.45);
  });
});

describe('withoutId', () => {
  it('removes only that message', () => {
    const items = [{ accountId: 'a1', mailbox: 'INBOX', uid: 1 }, { accountId: 'a1', mailbox: 'INBOX', uid: 2 }];
    expect(withoutId(items, 'a1|INBOX|1').map(i => i.uid)).toEqual([2]);
  });
});

describe('keepActions', () => {
  it('apply the rules to a store state through the injected set and clock', () => {
    let state = { items: [], dock: DEFAULT_DOCK };
    const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
    const actions = keepActions(set, () => 7);
    const entry = { accountId: 'a1', mailbox: 'INBOX', uid: 1, subject: 's', sender: { name: 'Sam', address: 'sam@x' } };
    actions.toggle(entry);
    expect(state.items).toEqual([{ ...entry, keptAt: 7 }]);
    actions.remove('a1|INBOX|1');
    expect(state.items).toEqual([]);
    actions.moveDock({ side: 'left', top: 0.2 });
    expect(state.dock).toEqual({ side: 'left', top: 0.2 });
    actions.moveDock({ side: 'up' });
    expect(state.dock).toEqual(DEFAULT_DOCK);
  });
});
