// @vitest-environment jsdom
// Saved views on the phone: desktop's views in the folder drawer (desktop's icon, name, count; a
// starter by its translated name) and a view's mail in its own layer, with the note that a view
// on the phone finds only the mail the phone keeps offline, over `mobile.views.*` (engine views.rs).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], pages: [], available: true }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.views.evaluate': {
        if (!engine.available) return { available: false, reason: 'unavailable', rows: [], total: 0, cursor: null };
        const at = params.cursor ? params.cursor[0] : 0;
        return engine.pages[at];
      }
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: FolderDrawer } = await import('../FolderDrawer.jsx');
const { default: ViewResults } = await import('../ViewResults.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const flush = () => act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); });
const calls = (m) => engine.calls.filter(([n]) => n === m).map(([, p]) => p);
const row = (uid, subject) => ({ accountId: 'a1', folder: 'INBOX', uid, subject, fromName: 'Ada', fromAddress: 'ada@example.test', to: [], dateMs: Date.UTC(2026, 10, 3), snippet: '', seen: true, flagged: false });
const STARRED = { id: 'builtin-starred', name: '', icon: 'star', builtin: 'starred', position: 0, def: { starred: true } };
const BILLS = { id: 'v1', name: 'Bills', icon: 'emoji:🧾', builtin: null, position: 1, def: {} };

beforeEach(() => {
  engine.calls = [];
  engine.pages = [];
  engine.available = true;
  useMobileStore.setState({ prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', accounts: [{ id: 'a1', email: 'u@example.test' }] });
});
afterEach(cleanup);

describe('saved views on the phone', () => {
  it('the drawer lists the views under desktop\'s heading, with counts, and opens one', () => {
    const onView = vi.fn();
    render(<FolderDrawer account={{ email: 'u@example.test' }} folders={[]} onSelect={() => {}} onClose={() => {}}
      views={[STARRED, BILLS]} viewCounts={{ 'builtin-starred': 4, v1: 0 }} onView={onView} />);
    const section = document.querySelector('[data-mv-views]');
    expect(section.querySelector('h3').textContent).toBe(t('views.section'));
    const starred = section.querySelector('[data-mv-view-open="builtin-starred"]');
    expect(starred.textContent).toBe(`${t('views.builtin.starred')}4`);
    expect(section.querySelector('[data-mv-view-open="v1"]').textContent).toContain('Bills');
    fireEvent.click(starred);
    expect(onView).toHaveBeenCalledWith(STARRED);
  });

  it('no views, no section', () => {
    render(<FolderDrawer account={null} folders={[]} onSelect={() => {}} onClose={() => {}} views={[]} onView={() => {}} />);
    expect(document.querySelector('[data-mv-views]')).toBeNull();
  });

  it('a view shows its mail page by page under the offline note, and a row opens', async () => {
    engine.pages = [
      { available: true, rows: [row(1, 'one'), row(2, 'two')], total: 3, cursor: [2] },
      undefined,
      { available: true, rows: [row(3, 'three')], total: 3, cursor: null },
    ];
    const onOpen = vi.fn();
    render(<ViewResults view={BILLS} onOpen={onOpen} onClose={() => {}} />);
    await flush();
    expect(screen.getByRole('dialog', { name: 'Bills' })).toBeTruthy();
    expect(document.querySelector('[data-mv-view-note]').textContent).toBe(t('mobile.views.offlineNote'));
    expect(calls('mobile.views.evaluate')).toEqual([{ viewId: 'v1' }, { viewId: 'v1', cursor: [2] }]);
    const subjects = [...document.querySelectorAll('.mv-row__subject')].map((s) => s.textContent);
    expect(subjects).toEqual(['one', 'two', 'three']);
    fireEvent.click(screen.getByText('two'));
    expect(onOpen.mock.calls[0][0]).toMatchObject({ uid: 2, accountId: 'a1', folder: 'INBOX' });
  });

  it('an empty view says so; without an index it says why', async () => {
    engine.pages = [{ available: true, rows: [], total: 0, cursor: null }];
    render(<ViewResults view={STARRED} onOpen={() => {}} onClose={() => {}} />);
    await flush();
    expect(screen.getByRole('dialog', { name: t('views.builtin.starred') })).toBeTruthy();
    expect(screen.getByText(t('views.preview.empty'))).toBeTruthy();
    cleanup();

    engine.available = false;
    render(<ViewResults view={STARRED} onOpen={() => {}} onClose={() => {}} />);
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('views.unavailable.unavailable'));
  });
});
