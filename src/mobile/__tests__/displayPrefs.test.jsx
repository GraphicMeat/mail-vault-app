// @vitest-environment jsdom
// The display and mail preferences where they act, short of the whole app: the page's text size
// and font, list rows (height, density, preview lines, swipes), signatures in a message, the row
// after a delete in All Inboxes, and the desktop lists the phone copies.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import MessageRow, { ROW_HEIGHT } from '../MessageRow.jsx';
import { useMobileStore } from '../store.js';
import { revealSide } from './fixtures/swipe.js';
import {
  PREF_DEFAULTS, TEXT_SCALES, APP_FONTS, rowHeight, fontStack, applyLook, afterDeletePick, afterDeleteRow,
} from '../prefs.js';
import { foldSignatures, prepareMailBody } from '../mailFrame.js';
import * as desktopFonts from '../../utils/appFont.js';

afterEach(cleanup);
beforeEach(() => useMobileStore.setState({ prefs: { ...PREF_DEFAULTS } }));

const row = {
  uid: 7, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test',
  dateMs: Date.UTC(2024, 2, 3, 10, 0), snippet: 'Body text', seen: false, flagged: false,
};
const withPrefs = (patch) => useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, ...patch } });
const renderRow = () => render(<MessageRow row={row} index={0} start={0} onOpen={() => {}} onSwipe={() => {}} />);

describe('desktop parity', () => {
  it('text sizes and fonts are desktop\'s, bundled fonts only', () => {
    expect(TEXT_SCALES).toEqual(desktopFonts.TEXT_SCALES);
    expect(APP_FONTS).toEqual(desktopFonts.APP_FONTS);
    for (const f of APP_FONTS) expect(fontStack(f.id)).toBe(desktopFonts.fontStack(f.id));
  });
});

describe('text size and font', () => {
  it('scale the root font size and set the font stack; the default leaves the size alone', () => {
    const root = document.createElement('html');
    applyLook({ ...PREF_DEFAULTS, textScale: 1.25, appFont: 'atkinson' }, root);
    expect(root.style.fontSize).toBe('20px');
    expect(root.style.getPropertyValue('--app-font')).toContain('Atkinson Hyperlegible Next');
    applyLook({ ...PREF_DEFAULTS, appFont: 'system' }, root);
    expect(root.style.fontSize).toBe('');
    expect(root.style.getPropertyValue('--app-font')).toContain('system-ui');
    // A value the phone does not have is the default.
    applyLook({ ...PREF_DEFAULTS, textScale: 7, appFont: 'google:Lobster' }, root);
    expect(root.style.fontSize).toBe('');
    expect(root.style.getPropertyValue('--app-font')).toContain('Instrument Sans');
  });
});

describe('list rows', () => {
  it('the default row is the row the phone always had', () => {
    expect(rowHeight(PREF_DEFAULTS)).toBe(76);
    expect(ROW_HEIGHT).toBe(76);
  });

  it('density, preview lines and text size set the height, never under the tap minimum', () => {
    const h = (p) => rowHeight({ ...PREF_DEFAULTS, ...p });
    expect(h({ listDensity: 'compact' })).toBeLessThan(76);
    expect(h({ listPreviewLines: 0 })).toBeLessThan(76);
    expect(h({ listPreviewLines: 3 })).toBeGreaterThan(h({ listPreviewLines: 2 }));
    expect(h({ textScale: 1.5 })).toBeGreaterThan(76);
    expect(h({ textScale: 0.9, listDensity: 'compact', listPreviewLines: 0 })).toBeGreaterThanOrEqual(44);
  });

  it('a row shows its preview lines, its density and its height', () => {
    withPrefs({ listPreviewLines: 0, listDensity: 'compact' });
    let { container } = renderRow();
    expect(container.querySelector('.mv-row__snippet')).toBe(null);
    expect(container.querySelector('.mv-row').className).toContain('mv-row--compact');
    expect(container.querySelector('.mv-row-slot').style.height).toBe(`${rowHeight(useMobileStore.getState().prefs)}px`);
    cleanup();
    withPrefs({ listPreviewLines: 3 });
    ({ container } = renderRow());
    const snippet = container.querySelector('.mv-row__snippet');
    expect(snippet.dataset.mvPreviewLines).toBe('3');
    expect(snippet.className).toContain('mv-row__snippet--lines');
    expect(container.querySelector('.mv-row').className).not.toContain('mv-row--compact');
  });

  it('swipes off: the row reveals no action either way', () => {
    const revealed = (side) => {
      const { container } = renderRow();
      revealSide(container, side);
      const n = container.querySelectorAll(`[data-mv-swipe-action="${side}"]`).length;
      cleanup();
      return n;
    };
    expect([revealed('leading'), revealed('trailing')]).toEqual([1, 1]);
    withPrefs({ trackpadSwipeEnabled: false });
    expect([revealed('leading'), revealed('trailing')]).toEqual([0, 0]);
  });
});

describe('the row after a delete', () => {
  // All Inboxes: rows of accounts a and b; the deleted row is index 2 (account a).
  const list = [{ k: 0, accountId: 'a' }, { k: 1, accountId: 'b' }, { k: 2, accountId: 'a' }, { k: 3, accountId: 'b' }, { k: 4, accountId: 'a' }];
  const at = (i) => list[i];
  const same = (r) => r.k === 2;

  it('without the preference: the neighbour, whatever its account', () => {
    expect(afterDeletePick('next', 2, at, same)).toEqual({ row: list[3], index: 3 });
    expect(afterDeleteRow('previous', 2, at, same)).toBe(list[1]);
  });

  it('afterDeleteSameAccount: the nearest of the deleted one\'s account, that way first', () => {
    expect(afterDeletePick('next', 2, at, same, 'a')).toEqual({ row: list[4], index: 4 });
    expect(afterDeletePick('previous', 2, at, same, 'a')).toEqual({ row: list[0], index: 0 });
    // None of that account loaded: the neighbour after all.
    const others = [{ k: 0, accountId: 'b' }, { k: 2, accountId: 'a' }, { k: 3, accountId: 'b' }];
    expect(afterDeletePick('next', 1, (i) => others[i], (r) => r.k === 2, 'a')).toEqual({ row: others[2], index: 2 });
    expect(afterDeletePick('none', 2, at, same, 'a')).toBe(undefined);
  });
});

describe('signatures in a message', () => {
  const mail = '<p>Hi Ann</p><div class="gmail_signature"><p>Bob</p><div class="signature-inner">Bob Ltd</div></div>';
  const doc = (html) => new DOMParser().parseFromString(html, 'text/html');

  it('always-show leaves the mail as it is', () => {
    expect(foldSignatures(mail, { mode: 'always-show', label: 'Show signature' })).toBe(mail);
  });

  it('smart and collapsed fold each signature once under a details', () => {
    for (const mode of ['smart', 'collapsed']) {
      const d = doc(foldSignatures(mail, { mode, label: 'Show signature' }));
      const folds = d.querySelectorAll('details[data-mv-signature]');
      expect(folds).toHaveLength(1);
      expect(folds[0].open).toBe(false);
      expect(folds[0].querySelector('summary').textContent).toBe('Show signature');
      expect(folds[0].textContent).toContain('Bob Ltd');
      expect(d.body.textContent).toContain('Hi Ann');
    }
  });

  it('always-hide takes the signature out', () => {
    const d = doc(foldSignatures(mail, { mode: 'always-hide', label: '' }));
    expect(d.body.textContent).toContain('Hi Ann');
    expect(d.body.textContent).not.toContain('Bob');
  });

  it('the folded mail is cleaned like any other', () => {
    const prepared = prepareMailBody({ html: `${mail}<script>alert(1)</script>` }, undefined, null, { mode: 'smart', label: 'Show signature' });
    expect(prepared.kind).toBe('html');
    expect(prepared.markup).toContain('<details data-mv-signature=""');
    expect(prepared.markup).not.toContain('<script');
  });
});
