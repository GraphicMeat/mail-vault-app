// @vitest-environment jsdom
//
// Settings > Storage > Deleted emails: the daemon's deleted-mail bin. The page
// lists what `deleted.list` answers, keeps the retention in settings (the
// daemon reads it from the settings file), and hands each row's action to the
// daemon: recover to the server, recover into the vault, or delete for good.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const ROW = {
  id: 'b1', accountId: 'a1', mailbox: 'INBOX', uid: 7, deletedAt: Date.UTC(2026, 8, 27, 10),
  row: { subject: 'Quarterly report', from: { name: 'Ann Lee', address: 'ann@example.com' }, date: '2026-09-20T08:00:00Z' },
};
let listed = [ROW];
const daemonCall = vi.fn(async (method, { ids = [] } = {}) => {
  if (method === 'deleted.list') return listed;
  if (method === 'deleted.recover') {
    listed = listed.filter(d => !ids.includes(d.id));
    return { recovered: ids.map(id => ({ id })), failed: [] };
  }
  if (method === 'deleted.discard') {
    listed = listed.filter(d => !ids.includes(d.id));
    return { discarded: ids.length };
  }
  return null;
});
vi.mock('../../../services/daemonClient', () => ({
  daemonCall: (...a) => daemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));

const { DeletedEmailsSettings } = await import('../DeletedEmailsSettings');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useMailStore } = await import('../../../stores/mailStore');

beforeEach(() => {
  listed = [ROW];
  daemonCall.mockClear();
  useSettingsStore.setState({ deletedRetentionDays: 1 });
  // A recover reloads the list on screen; here it only has to be callable.
  useMailStore.setState({ accounts: [{ id: 'a1', email: 'me@example.com' }], activeMailbox: 'INBOX', loadEmails: vi.fn() });
});
afterEach(cleanup);

const row = async () => within(await screen.findByTestId('deleted-list')).getByText('Quarterly report').closest('tr');

describe('DeletedEmailsSettings', () => {
  it('lists each kept email with its sender, subject, account and when it was deleted', async () => {
    render(<DeletedEmailsSettings />);
    const tr = await row();
    expect(tr.textContent).toContain('Ann Lee');
    expect(tr.textContent).toContain('me@example.com');
    expect(daemonCall).toHaveBeenCalledWith('deleted.list');
  });

  it('keeps a day by default and stores a longer retention the daemon reads', async () => {
    render(<DeletedEmailsSettings />);
    const select = screen.getByTestId('deleted-retention');
    expect(select.value).toBe('1');
    expect([...select.options].map(o => o.value)).toEqual(['1', '3', '7', '14', '30']);
    fireEvent.change(select, { target: { value: '30' } });
    expect(useSettingsStore.getState().deletedRetentionDays).toBe(30);
  });

  it.each([
    ['recover-server', 'deleted.recover', { ids: ['b1'], target: 'server' }],
    ['recover-local', 'deleted.recover', { ids: ['b1'], target: 'local' }],
    ['delete-now', 'deleted.discard', { ids: ['b1'] }],
  ])('%s asks the daemon and drops the row', async (action, method, params) => {
    render(<DeletedEmailsSettings />);
    fireEvent.click((await row()).querySelector(`[data-action="${action}"]`));
    await waitFor(() => expect(daemonCall).toHaveBeenCalledWith(method, params));
    expect(await screen.findByTestId('deleted-empty')).toBeTruthy();
  });

  it('says so when a recover fails, in catalog copy', async () => {
    daemonCall.mockImplementationOnce(async () => listed)
      .mockImplementationOnce(async () => ({ recovered: [], failed: [{ id: 'b1', error: 'IMAP APPEND refused' }] }));
    render(<DeletedEmailsSettings />);
    fireEvent.click((await row()).querySelector('[data-action="recover-server"]'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('IMAP');
    expect(alert.textContent).toBe('Could not recover this email.');
  });
});
