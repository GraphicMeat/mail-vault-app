// @vitest-environment jsdom
// Settings > Move to another computer (desktop's Export view): the chosen accounts sealed into a `.mvtransfer` file
// (`mobile.transfer.export`), handed to the share sheet, then deleted (`mobile.transfer.discard`).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], shared: [], shareFails: false, reply: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.transfer.export':
        return engine.reply;
      case 'mobile.transfer.discard':
        return { ok: true };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  shareFile: vi.fn(async (file) => {
    engine.shared.push(file);
    if (engine.shareFails) throw Object.assign(new Error('busy'), { code: 'BUSY' });
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: TransferSettings } = await import('../settings/Transfer.jsx');
const { useMobileStore } = await import('../store.js');

const PATH = `/cache/att/${'a'.repeat(64)}`;
beforeEach(() => {
  engine.calls = [];
  engine.shared = [];
  engine.shareFails = false;
  engine.reply = { ok: true, path: PATH, name: 'MailVault-transfer-2026-11-15.mvtransfer', count: 2, skipped: [] };
  useMobileStore.setState({
    accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada' }, { id: 'a2', email: 'grace@example.test', displayName: '' }],
  });
});
afterEach(cleanup);

const fill = (pw, confirm = pw) => {
  fireEvent.change(screen.getByLabelText(t('settings.transfer.password')), { target: { value: pw } });
  fireEvent.change(screen.getByLabelText(t('settings.transfer.confirmPassword')), { target: { value: confirm } });
};
const exportButton = () => screen.getByRole('button', { name: t('settings.transfer.exportTitle') });
const discards = () => engine.calls.filter(([m]) => m === 'mobile.transfer.discard').map(([, p]) => p);

describe('Settings > Move to another computer', () => {
  it('exports only with a long enough, confirmed password', () => {
    render(<TransferSettings />);
    expect(exportButton().disabled).toBe(true);
    fill('short');
    expect(exportButton().disabled).toBe(true);
    fill('twelve-chars-or-more', 'something-else-here');
    expect(screen.getByText(t('settings.transfer.passwordMismatch'))).toBeTruthy();
    expect(exportButton().disabled).toBe(true);
    fill('twelve-chars-or-more');
    expect(exportButton().disabled).toBe(false);
  });

  it('seals the chosen accounts, shares the file and deletes it after', async () => {
    render(<TransferSettings />);
    fireEvent.click(screen.getByRole('checkbox', { name: /grace@example.test/ }));
    fill('twelve-chars-or-more');
    fireEvent.click(exportButton());
    await waitFor(() => expect(discards()).toEqual([{ path: PATH }]));
    const [, params] = engine.calls.find(([m]) => m === 'mobile.transfer.export');
    expect(params).toEqual({ password: 'twelve-chars-or-more', accountIds: ['a1'] });
    expect(engine.shared).toEqual([{ path: PATH, name: 'MailVault-transfer-2026-11-15.mvtransfer', mime: 'application/octet-stream' }]);
    expect(screen.getByText(t('settings.transfer.exported', { count: 2 }))).toBeTruthy();
    // The password does not stay on screen.
    expect(screen.getByLabelText(t('settings.transfer.password')).value).toBe('');
  });

  it('still deletes the file when the share sheet fails, and says so', async () => {
    engine.shareFails = true;
    render(<TransferSettings />);
    fill('twelve-chars-or-more');
    fireEvent.click(exportButton());
    await waitFor(() => expect(discards()).toEqual([{ path: PATH }]));
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('names the accounts left out for want of a saved password', async () => {
    engine.reply = { ...engine.reply, count: 1, skipped: [{ email: 'grace@example.test', reason: 'no-secret' }] };
    render(<TransferSettings />);
    fill('twelve-chars-or-more');
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByText(t('settings.transfer.errors.incomplete', { emails: 'grace@example.test' }))).toBeTruthy());
  });
});
