// @vitest-environment jsdom
// The account editor's sending setup over a fake engine: a password account's password and
// servers (`mobile.accounts.update`, tested by the engine before it stores them), its aliases and
// default From (`aliases`, `sendAs`), and the folder its Sent copy goes to (`sentFolder`).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], settings: null, update: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.accountSettings.get':
        return { ...engine.settings };
      case 'mobile.accountSettings.set':
        engine.settings = { ...engine.settings, ...params.values };
        return { ...engine.settings };
      case 'mobile.accounts.update':
        return typeof engine.update === 'function' ? engine.update(params) : { ok: true, account: {} };
      case 'mobile.accounts.list':
        return { accounts: [] };
      case 'mobile.folders.list':
        return {
          folders: [
            { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', depth: 0, noselect: false },
            { path: 'Sent', name: 'Sent', specialUse: '\\Sent', depth: 0, noselect: false },
            { path: 'Archive/Sent 2025', name: 'Sent 2025', specialUse: null, depth: 1, noselect: false },
          ],
        };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: AccountEditor } = await import('../AccountEditor.jsx');

const PASSWORD_ACCOUNT = {
  id: 'a1', email: 'ada@example.test', displayName: 'Ada', kind: 'imap', oauth: false,
  imapHost: 'imap.example.test', imapPort: 993, security: 'ssl', smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl',
};
const OAUTH_ACCOUNT = { ...PASSWORD_ACCOUNT, id: 'g1', email: 'g@gmail.com', provider: 'google', oauth: true };
const GRAPH_ACCOUNT = { ...PASSWORD_ACCOUNT, id: 'm1', email: 'm@outlook.com', kind: 'graph', oauth: true };

const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

async function open(account = PASSWORD_ACCOUNT) {
  const onDone = vi.fn();
  render(<AccountEditor account={account} onDone={onDone} />);
  await flush();
  return { onDone };
}

const save = () => act(async () => { fireEvent.click(document.querySelector('[data-mv-acct-save]')); });

beforeEach(() => {
  engine.calls = [];
  engine.update = null;
  engine.settings = { accountId: 'a1', displayName: 'Ada', hidden: false, signature: null, sendAs: '', aliases: [], sentFolder: null };
});
afterEach(cleanup);

describe('password and mail server', () => {
  it('tests and saves a new password and servers for a password account', async () => {
    await open();
    fireEvent.click(document.querySelector('[data-mv-acct-server]'));
    const password = screen.getByLabelText(t('settings.accounts.password'));
    expect(password.type).toBe('password');
    expect(screen.getByLabelText(t('mobile.add.host')).value).toBe('imap.example.test');
    fireEvent.change(password, { target: { value: 'n3w-secret' } });
    fireEvent.change(screen.getByLabelText(t('mobile.add.smtpPort')), { target: { value: '587' } });
    fireEvent.change(screen.getByLabelText(t('mobile.add.smtpSecurity')), { target: { value: 'starttls' } });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-server-save]')); });
    await flush();
    expect(callsOf('mobile.accounts.update')).toEqual([{
      accountId: 'a1', password: 'n3w-secret', imapHost: 'imap.example.test', imapPort: 993, security: 'ssl',
      smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls',
    }]);
    expect(screen.getByRole('status').textContent).toBe(t('mobile.accounts.server.saved'));
    // The password does not stay on screen.
    expect(password.value).toBe('');
  });

  it('shows the refusal and keeps what was typed', async () => {
    engine.update = () => ({ ok: false, code: 'AUTH_FAILED', message: 'no' });
    await open();
    fireEvent.click(document.querySelector('[data-mv-acct-server]'));
    fireEvent.change(screen.getByLabelText(t('settings.accounts.password')), { target: { value: 'wrong' } });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-server-save]')); });
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.AUTH_FAILED'));
    expect(screen.getByLabelText(t('settings.accounts.password')).value).toBe('wrong');
  });

  it('is not offered for an account that signs in with its provider', async () => {
    await open(OAUTH_ACCOUNT);
    expect(document.querySelector('[data-mv-acct-server]')).toBeNull();
  });
});

describe('aliases and the default From', () => {
  it('adds an alias with its name and picks it as the default', async () => {
    await open();
    fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.addAddress')), { target: { value: 'hi@example.test' } });
    fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.addName')), { target: { value: 'Ada Hi' } });
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.aliases.add') }));
    fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.defaultAddress')), { target: { value: 'hi@example.test' } });
    await save();
    await flush();
    expect(callsOf('mobile.accountSettings.set').at(-1).values).toMatchObject({
      aliases: [{ address: 'hi@example.test', name: 'Ada Hi' }],
      sendAs: 'hi@example.test',
    });
  });

  it('refuses an address that does not read, the login and a duplicate', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: '' }];
    await open();
    const add = (v) => {
      fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.addAddress')), { target: { value: v } });
      fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.aliases.add') }));
    };
    add('nope');
    expect(screen.getByText(t('settings.accounts.aliases.error.invalid'))).toBeTruthy();
    add('ADA@example.test');
    expect(screen.getByText(t('settings.accounts.aliases.error.login'))).toBeTruthy();
    add('Hi@Example.test');
    expect(screen.getByText(t('settings.accounts.aliases.error.duplicate'))).toBeTruthy();
  });

  it('removes an alias, and a default that was it goes back to the login', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: 'Hi' }];
    engine.settings.sendAs = 'hi@example.test';
    await open();
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.aliases.removeFor', { address: 'hi@example.test' }) }));
    await save();
    await flush();
    expect(callsOf('mobile.accountSettings.set').at(-1).values).toMatchObject({ aliases: [], sendAs: '' });
  });

  it('edits an alias name in place', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: 'Hi' }];
    await open();
    fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.nameLabel') + ': hi@example.test'), { target: { value: 'Hello' } });
    await save();
    await flush();
    expect(callsOf('mobile.accountSettings.set').at(-1).values.aliases).toEqual([{ address: 'hi@example.test', name: 'Hello' }]);
  });
});

describe('sent folder', () => {
  it('lists the account folders and saves the one picked', async () => {
    await open();
    await waitFor(() => expect(callsOf('mobile.folders.list')).toEqual([{ accountId: 'a1' }]));
    const pick = screen.getByLabelText(t('settings.accounts.sentFolder2'));
    expect([...pick.options].map((o) => o.value)).toEqual(['', 'INBOX', 'Sent', 'Archive/Sent 2025']);
    expect(pick.value).toBe('');
    fireEvent.change(pick, { target: { value: 'Archive/Sent 2025' } });
    await save();
    await flush();
    expect(callsOf('mobile.accountSettings.set').at(-1).values.sentFolder).toBe('Archive/Sent 2025');
  });

  it('clears the choice back to automatic', async () => {
    engine.settings.sentFolder = 'Sent';
    await open();
    await flush();
    const pick = screen.getByLabelText(t('settings.accounts.sentFolder2'));
    expect(pick.value).toBe('Sent');
    fireEvent.change(pick, { target: { value: '' } });
    await save();
    await flush();
    expect(callsOf('mobile.accountSettings.set').at(-1).values.sentFolder).toBeNull();
  });

  it('is not offered where the server files the Sent copy itself', async () => {
    await open(GRAPH_ACCOUNT);
    expect(screen.queryByLabelText(t('settings.accounts.sentFolder2'))).toBeNull();
  });
});
