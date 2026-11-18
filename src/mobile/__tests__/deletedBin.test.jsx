// @vitest-environment jsdom
// Settings > Storage > Deleted emails on the phone: desktop's view over the engine's bin. The page
// lists `mobile.deleted.list` a page at a time, recovers through the journal (`mobile.deleted.
// recover`) and says in desktop's copy when that cannot be done, deletes a row for good, and keeps
// the retention as the `deletedRetentionDays` preference. No Recover locally: the phone has no vault.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], rows: [], next: null, listeners: {}, recover: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.deleted.list':
        if (params.after) return { rows: [{ ...engine.rows[0], id: 'b9', row: { subject: 'Older one' } }], next: null };
        return { rows: structuredClone(engine.rows), next: engine.next };
      case 'mobile.deleted.recover':
        return engine.recover || { queued: params.ids.map((id) => ({ id, seq: 41 })), failed: [] };
      case 'mobile.deleted.discard':
        engine.rows = engine.rows.filter((r) => !params.ids.includes(r.id));
        return { removed: 1 };
      case 'mobile.prefs.set':
        return { ...params };
      case 'mobile.sync.refresh':
        return { queued: true };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn((name, handler) => {
    (engine.listeners[name] ||= []).push(handler);
    return () => { engine.listeners[name] = engine.listeners[name].filter((h) => h !== handler); };
  }),
}));

const { default: DeletedEmails } = await import('../settings/DeletedEmails.jsx');
const { MobileViewEnv } = await import('../settings/MobileViewEnv.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const ROW = {
  id: 'b1', accountId: 'a1', mailbox: 'INBOX', uid: 7, deletedAt: Date.UTC(2026, 10, 17, 10), hasEml: false,
  row: { subject: 'Quarterly report', from: { name: 'Ann Lee', address: 'ann@example.com' }, date: Date.UTC(2026, 10, 10) },
};
const emit = (name, payload) => act(() => { for (const h of engine.listeners[name] || []) h(payload); });
const page = () => render(<MobileViewEnv><DeletedEmails /></MobileViewEnv>);
const row = async () => within(await screen.findByTestId('deleted-list')).getByText('Quarterly report').closest('tr');

beforeEach(() => {
  engine.calls = [];
  engine.rows = [ROW];
  engine.next = null;
  engine.listeners = {};
  engine.recover = null;
  useMobileStore.setState({ prefs: { ...PREF_DEFAULTS }, accounts: [{ id: 'a1', email: 'ann.me@example.com', displayName: 'Work' }] });
});
afterEach(cleanup);

describe('Settings > Storage > Deleted emails on the phone', () => {
  it('lists each kept email with desktop\'s columns and no Recover locally', async () => {
    page();
    const tr = await row();
    expect(tr.textContent).toContain('Ann Lee');
    expect(tr.textContent).toContain('Work');
    expect(tr.querySelector('[data-action="recover-server"]')).toBeTruthy();
    expect(tr.querySelector('[data-action="delete-now"]')).toBeTruthy();
    expect(tr.querySelector('[data-action="recover-local"]')).toBeNull();
    expect(screen.getByText(t('mobile.deletedBin.intro'))).toBeTruthy();
    expect(screen.getByText(t('deletedBin.title'))).toBeTruthy();
  });

  it('keeps the retention as a preference, a day by default', async () => {
    page();
    const select = await screen.findByTestId('deleted-retention');
    expect(select.value).toBe('1');
    fireEvent.change(select, { target: { value: '14' } });
    await waitFor(() => expect(engine.calls).toContainEqual(['mobile.prefs.set', { deletedRetentionDays: 14 }]));
  });

  it('recovers through the journal, then syncs the folder it went back to', async () => {
    page();
    fireEvent.click((await row()).querySelector('[data-action="recover-server"]'));
    await waitFor(() => expect(engine.calls).toContainEqual(['mobile.deleted.recover', { ids: ['b1'] }]));
    engine.rows = [];
    emit('mobile.action.result', { seq: 41, accountId: 'a1', outcome: 'done' });
    await waitFor(() => expect(engine.calls).toContainEqual(['mobile.sync.refresh', { accountId: 'a1', folder: 'INBOX' }]));
    expect(await screen.findByTestId('deleted-empty')).toBeTruthy();
  });

  it('says so in desktop\'s copy when the message is gone from Trash', async () => {
    page();
    fireEvent.click((await row()).querySelector('[data-action="recover-server"]'));
    await waitFor(() => expect(engine.calls).toContainEqual(['mobile.deleted.recover', { ids: ['b1'] }]));
    emit('mobile.action.result', { seq: 41, accountId: 'a1', outcome: 'dropped', reason: 'GONE_FROM_TRASH' });
    expect((await screen.findByRole('alert')).textContent).toBe(t('deletedBin.goneFromTrash'));
  });

  it('shows a refusal the engine answers at once', async () => {
    engine.recover = { queued: [], failed: [{ id: 'b1', error: 'deletedBin.deleteStillQueued' }] };
    page();
    fireEvent.click((await row()).querySelector('[data-action="recover-server"]'));
    expect((await screen.findByRole('alert')).textContent).toBe(t('deletedBin.deleteStillQueued'));
  });

  it('deletes a row for good', async () => {
    page();
    fireEvent.click((await row()).querySelector('[data-action="delete-now"]'));
    await waitFor(() => expect(engine.calls).toContainEqual(['mobile.deleted.discard', { ids: ['b1'] }]));
    expect(await screen.findByTestId('deleted-empty')).toBeTruthy();
  });

  it('reads the next page on Load more', async () => {
    engine.next = { deletedAt: ROW.deletedAt, id: 'b1' };
    page();
    await row();
    fireEvent.click(screen.getByText(t('explorer.loadMore')));
    expect(await screen.findByText('Older one')).toBeTruthy();
    expect(engine.calls).toContainEqual(['mobile.deleted.list', { after: { deletedAt: ROW.deletedAt, id: 'b1' } }]);
    expect(screen.queryByText(t('explorer.loadMore'))).toBeNull();
  });
});
