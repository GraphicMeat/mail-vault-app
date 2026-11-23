// @vitest-environment jsdom
// Settings > Appearance > Layout on the phone: message list density and preview lines share ONE
// sample, drawn with the list's own row (MessageRow.jsx), that follows both and the text size at
// once. Nothing moves while either control changes: the sample keeps the height of its tallest
// state (three lines, comfortable) and each hint the height of its longest. Then the real list
// (MessageList.jsx): its rows' heights and positions follow the same preferences when they change.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import { installMockEngine } from './fixtures/mockEngine.js';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let t;
let Appearance;
let MessageList;
let useMobileStore;
let PREF_DEFAULTS;
let rowHeight;

beforeAll(async () => {
  installMockEngine();
  ({ t } = await import('../i18n.js'));
  ({ default: Appearance } = await import('../settings/Appearance.jsx'));
  ({ default: MessageList } = await import('../MessageList.jsx'));
  ({ useMobileStore } = await import('../store.js'));
  ({ PREF_DEFAULTS, rowHeight } = await import('../prefs.js'));
});
// A fresh engine each time: its stored preferences come back with every write.
beforeEach(() => {
  installMockEngine();
  useMobileStore.setState({ prefs: { ...PREF_DEFAULTS } });
});
afterEach(cleanup);

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const prefs = () => useMobileStore.getState().prefs;
const samples = (root) => root.querySelectorAll('.preview-list-sample');
const live = (root) => samples(root)[0].querySelector(':scope > :not(.preview-list-sample-tallest)');
const tallest = (root) => samples(root)[0].querySelector(':scope > .preview-list-sample-tallest');
const slots = (el) => [...el.querySelectorAll('.mv-row-slot')];
const group = (name) => document.querySelector(`[role="group"][aria-labelledby="${[...document.querySelectorAll('.setting-row-copy > :first-child')].find((l) => l.textContent === name).id}"]`);
const press = (name, choice) => act(async () => { fireEvent.click(within(group(name)).getByRole('button', { name: choice })); });

async function layout() {
  const view = render(<Appearance section="layout" />);
  await settle();
  return view.container;
}

describe('the list sample', () => {
  it('is one sample, beside both list rows, drawn with the list\'s own row', async () => {
    const root = await layout();
    expect(samples(root)).toHaveLength(1);
    // Preview lines follows density directly; the sample sits under the pair.
    const labels = [...root.querySelectorAll('.setting-row-copy > :first-child')].map((l) => l.textContent);
    expect(labels.indexOf(t('listPreview.title'))).toBe(labels.indexOf(t('workspace.listDensity')) + 1);
    const rows = slots(live(root));
    expect(rows).toHaveLength(2);
    for (const slot of rows) {
      expect(slot.querySelector('.mv-row .mv-row__sender')).not.toBe(null);
      expect(slot.querySelector('.mv-row .mv-row__subject')).not.toBe(null);
      expect(slot.style.height).toBe(`${rowHeight(prefs())}px`);
    }
    // A picture: nothing in it takes a tap.
    expect(samples(root)[0].closest('figure').querySelector('button, a, input')).toBe(null);
  });

  it('follows density, preview lines and the text size together', async () => {
    const root = await layout();
    await press(t('workspace.listDensity'), t('workspace.sidebarDensityCompact'));
    expect(prefs().listDensity).toBe('compact');
    for (const slot of slots(live(root))) {
      expect(slot.querySelector('.mv-row').className).toContain('mv-row--compact');
      expect(slot.style.height).toBe(`${rowHeight(prefs())}px`);
    }
    await press(t('listPreview.title'), t('listPreview.three'));
    for (const slot of slots(live(root))) {
      // Still compact: the one sample shows both choices.
      expect(slot.querySelector('.mv-row').className).toContain('mv-row--compact');
      expect(slot.querySelector('.mv-row__snippet').dataset.mvPreviewLines).toBe('3');
      expect(slot.style.height).toBe(`${rowHeight({ ...PREF_DEFAULTS, listDensity: 'compact', listPreviewLines: 3 })}px`);
    }
    await press(t('listPreview.title'), t('listPreview.off'));
    expect(live(root).querySelector('.mv-row__snippet')).toBe(null);
    await act(async () => { useMobileStore.setState({ prefs: { ...prefs(), textScale: 1.25 } }); });
    expect(slots(live(root))[0].style.height).toBe(`${rowHeight({ ...PREF_DEFAULTS, listDensity: 'compact', listPreviewLines: 0, textScale: 1.25 })}px`);
  });

  it('keeps the height of its tallest state, whatever either control shows', async () => {
    const root = await layout();
    const reserve = tallest(root);
    expect(reserve.getAttribute('aria-hidden')).toBe('true');
    const tall = rowHeight({ ...PREF_DEFAULTS, listDensity: 'comfortable', listPreviewLines: 3 });
    expect(slots(reserve).map((s) => s.style.height)).toEqual([`${tall}px`, `${tall}px`]);
    expect(reserve.querySelectorAll('.mv-row__snippet[data-mv-preview-lines="3"]')).toHaveLength(2);
    const before = reserve.outerHTML;
    await press(t('listPreview.title'), t('listPreview.off'));
    await press(t('workspace.listDensity'), t('workspace.sidebarDensityCompact'));
    await press(t('listPreview.title'), t('listPreview.two'));
    expect(tallest(root).outerHTML).toBe(before);
  });

  it('a hint that follows the choice keeps the height of the longest', async () => {
    const root = await layout();
    const hint = (name) => {
      const label = [...root.querySelectorAll('.setting-row-copy > :first-child')].find((l) => l.textContent === name);
      return label.parentElement.querySelector('p');
    };
    const shown = (p) => [...p.querySelectorAll('.setting-hint-stack > :not([aria-hidden="true"])')].map((s) => s.textContent);
    const lines = hint(t('listPreview.title'));
    const text = lines.textContent;
    expect(text).toContain(t('listPreview.linesHint'));
    expect(text).toContain(t('listPreview.offHint'));
    expect(shown(lines)).toEqual([t('listPreview.linesHint')]);
    await press(t('listPreview.title'), t('listPreview.off'));
    expect(hint(t('listPreview.title')).textContent).toBe(text);
    expect(shown(hint(t('listPreview.title')))).toEqual([t('listPreview.offHint')]);
    const density = hint(t('workspace.listDensity'));
    expect(density.textContent).toContain(t('workspace.listDensityCompactHint'));
    expect(shown(density)).toEqual([t('workspace.listDensityComfortableHint')]);
  });
});

describe('the real list', () => {
  let offsetHeight;
  beforeEach(() => { offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800); });
  afterEach(() => offsetHeight.mockRestore());

  const ROWS = Array.from({ length: 12 }, (_, i) => ({ uid: 100 - i, accountId: 'a1', folder: 'INBOX', subject: `S${i}`, fromName: 'Ann', fromAddress: 'ann@example.test', dateMs: 1, snippet: 'Body', seen: true, flagged: false }));
  const cache = () => ({
    total: ROWS.length, version: 1, pageSize: 100, topIndex: 0, anchor: null,
    subscribe: () => () => {}, rowAt: (i) => ROWS[i], ensure: async () => {}, clearAnchor() {},
  });
  const placed = (root) => [...root.querySelectorAll('[data-mv-list] .mv-row-slot')].slice(0, 4).map((s) => [s.style.height, s.style.transform]);
  const expected = (h) => [0, 1, 2, 3].map((i) => [`${h}px`, `translateY(${i * h}px)`]);

  it('rows take the new height and every position moves with it when a preference changes', async () => {
    const { container } = render(<MessageList cache={cache()} onOpen={() => {}} onSwipe={() => {}} onRefresh={() => {}} />);
    await settle();
    expect(placed(container)).toEqual(expected(rowHeight(PREF_DEFAULTS)));
    const inner = () => container.querySelector('.mv-list__inner').style.height;
    for (const patch of [{ listPreviewLines: 3 }, { listDensity: 'compact' }, { listPreviewLines: 0, textScale: 1.5 }]) {
      await act(async () => { useMobileStore.setState({ prefs: { ...prefs(), ...patch } }); });
      await settle();
      const h = rowHeight(prefs());
      expect(placed(container)).toEqual(expected(h));
      expect(inner()).toBe(`${ROWS.length * h}px`);
    }
  });
});
