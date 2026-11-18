// @vitest-environment jsdom
// Settings > Accounts on the phone (desktop's account views, settings/Accounts.jsx) over a fake
// engine: a password account's password and servers (`mobile.accounts.update`, tested by the engine
// before it stores them), its aliases and default From (`aliases`, `sendAs`), the folder its Sent
// copy goes to (`sentFolder`), its name and signature, colour, hidden, and Remove. Each choice is
// written as desktop writes it: at once, the name and signature a moment after typing stops.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], settings: null, update: null, accounts: [] }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.accountSettings.get':
        return { ...engine.settings, accountId: params.accountId };
      case 'mobile.accountSettings.set':
        engine.settings = { ...engine.settings, ...params.values };
        return { ...engine.settings, accountId: params.accountId };
      case 'mobile.accounts.update':
        return typeof engine.update === 'function' ? engine.update(params) : { ok: true, account: {} };
      case 'mobile.accounts.list':
        return { accounts: engine.accounts };
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

const { default: Accounts } = await import('../settings/Accounts.jsx');
const { useMobileStore } = await import('../store.js');

const PASSWORD_ACCOUNT = {
  id: 'a1', email: 'ada@example.test', displayName: 'Ada', kind: 'imap', oauth: false,
  imapHost: 'imap.example.test', imapPort: 993, security: 'ssl', smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl',
};
const OAUTH_ACCOUNT = { ...PASSWORD_ACCOUNT, id: 'g1', email: 'g@gmail.com', provider: 'google', oauth: true };
const GRAPH_ACCOUNT = { ...PASSWORD_ACCOUNT, id: 'm1', email: 'm@outlook.com', kind: 'graph', oauth: true };

const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const writes = () => callsOf('mobile.accountSettings.set').map((p) => p.values);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));

function Page({ start }) {
  const [section, setSection] = useState(start);
  return <Accounts section={section} onSectionChange={setSection} />;
}

async function open(account = PASSWORD_ACCOUNT, section = 'profile') {
  engine.accounts = [account];
  useMobileStore.setState({ accounts: [account], reauthState: null, syncState: {} });
  render(<Page start={section} />);
  await flush();
}

beforeEach(() => {
  engine.calls = [];
  engine.update = null;
  engine.settings = { displayName: 'Ada', hidden: false, signature: null, sendAs: '', aliases: [], sentFolder: null, color: null };
});
afterEach(cleanup);

describe('password and mail server', () => {
  it('tests and saves a new password with the account\'s servers, and the password leaves the screen', async () => {
    await open(PASSWORD_ACCOUNT, 'connection');
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.update') }));
    const password = screen.getByLabelText(t('settings.accounts.newPassword'));
    expect(password.type).toBe('password');
    fireEvent.change(password, { target: { value: 'n3w-secret' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.savePassword') })); });
    await flush();
    expect(callsOf('mobile.accounts.update')).toEqual([{
      accountId: 'a1', password: 'n3w-secret', imapHost: 'imap.example.test', imapPort: 993, security: 'ssl',
      smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl',
    }]);
    expect(screen.queryByLabelText(t('settings.accounts.newPassword'))).toBeNull();
    expect(document.body.innerHTML).not.toContain('n3w-secret');
  });

  it('changes the servers through the engine\'s test, and says so', async () => {
    await open(PASSWORD_ACCOUNT, 'connection');
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.changeServer') }));
    const password = screen.getByLabelText(t('settings.accounts.password'));
    expect(password.type).toBe('password');
    expect(screen.getByLabelText(t('mobile.add.host')).value).toBe('imap.example.test');
    fireEvent.change(password, { target: { value: 'n3w-secret' } });
    fireEvent.change(screen.getByLabelText(t('mobile.add.smtpPort')), { target: { value: '587' } });
    fireEvent.change(screen.getByLabelText(t('mobile.add.smtpSecurity')), { target: { value: 'starttls' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.accounts.server.save') })); });
    await flush();
    expect(callsOf('mobile.accounts.update')).toEqual([{
      accountId: 'a1', password: 'n3w-secret', imapHost: 'imap.example.test', imapPort: 993, security: 'ssl',
      smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls',
    }]);
    expect(screen.getByText(t('mobile.accounts.server.saved'))).toBeTruthy();
    // The form, and the password in it, are gone.
    expect(screen.queryByLabelText(t('settings.accounts.password'))).toBeNull();
  });

  it('shows the refusal and keeps what was typed', async () => {
    engine.update = () => ({ ok: false, code: 'AUTH_FAILED', message: 'no' });
    await open(PASSWORD_ACCOUNT, 'connection');
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.changeServer') }));
    fireEvent.change(screen.getByLabelText(t('settings.accounts.password')), { target: { value: 'wrong' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.accounts.server.save') })); });
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.AUTH_FAILED'));
    expect(screen.getByLabelText(t('settings.accounts.password')).value).toBe('wrong');
  });

  it('is not offered for an account that signs in with its provider, which reconnects instead', async () => {
    const reauth = vi.fn(async () => ({ ok: true }));
    useMobileStore.setState({ reauth });
    await open(OAUTH_ACCOUNT, 'connection');
    expect(screen.queryByRole('button', { name: t('settings.accounts.changeServer') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('settings.accounts.update') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.reconnect') }));
    expect(reauth).toHaveBeenCalledWith('g1');
  });
});

describe('aliases and the default From', () => {
  it('adds an alias with its name, then picks it as the default', async () => {
    await open(PASSWORD_ACCOUNT, 'aliases');
    fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.addAddress')), { target: { value: 'hi@example.test' } });
    fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.addName')), { target: { value: 'Ada Hi' } });
    await act(async () => { fireEvent.click(screen.getByTestId('alias-add-btn')); });
    await flush();
    expect(writes().at(-1)).toEqual({ aliases: [{ address: 'hi@example.test', name: 'Ada Hi' }] });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: t('settings.accounts.aliases.useByDefaultFor', { address: 'hi@example.test' }) }));
    });
    await flush();
    expect(writes().at(-1)).toEqual({ sendAs: 'hi@example.test' });
  });

  it('refuses an address that does not read, the login and a duplicate', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: '' }];
    await open(PASSWORD_ACCOUNT, 'aliases');
    const add = async (v) => {
      fireEvent.change(screen.getByLabelText(t('settings.accounts.aliases.addAddress')), { target: { value: v } });
      await act(async () => { fireEvent.click(screen.getByTestId('alias-add-btn')); });
      await flush();
    };
    await add('nope');
    expect(screen.getByText(t('settings.accounts.aliases.error.invalid'))).toBeTruthy();
    await add('ADA@example.test');
    expect(screen.getByText(t('settings.accounts.aliases.error.login'))).toBeTruthy();
    await add('Hi@Example.test');
    expect(screen.getByText(t('settings.accounts.aliases.error.duplicate'))).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('removes an alias, and a default that was it goes back to the login', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: 'Hi' }];
    engine.settings.sendAs = 'hi@example.test';
    await open(PASSWORD_ACCOUNT, 'aliases');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.aliases.removeFor', { address: 'hi@example.test' }) })); });
    await flush();
    expect(writes().at(-1)).toEqual({ aliases: [], sendAs: '' });
  });

  it('edits an alias name in place, saved when the field is left', async () => {
    engine.settings.aliases = [{ address: 'hi@example.test', name: 'Hi' }];
    await open(PASSWORD_ACCOUNT, 'aliases');
    const name = screen.getByLabelText(t('settings.accounts.aliases.nameLabel'));
    fireEvent.change(name, { target: { value: 'Hello' } });
    await act(async () => { fireEvent.blur(name); });
    await flush();
    expect(writes().at(-1).aliases).toEqual([{ address: 'hi@example.test', name: 'Hello' }]);
  });
});

describe('sent folder', () => {
  it('lists the account folders and saves the one picked', async () => {
    await open(PASSWORD_ACCOUNT, 'connection');
    await waitFor(() => expect(callsOf('mobile.folders.list')).toEqual([{ accountId: 'a1' }]));
    const pick = screen.getByLabelText(t('settings.accounts.sentFolder2'));
    expect([...pick.options].map((o) => o.value)).toEqual(['', 'INBOX', 'Sent', 'Archive/Sent 2025']);
    expect(pick.options[0].textContent).toBe(t('mobile.accounts.sentFolderAuto'));
    expect(pick.value).toBe('');
    fireEvent.change(pick, { target: { value: 'Archive/Sent 2025' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.saveSentFolder') })); });
    await flush();
    expect(writes().at(-1)).toEqual({ sentFolder: 'Archive/Sent 2025' });
  });

  it('clears the choice back to automatic', async () => {
    engine.settings.sentFolder = 'Sent';
    await open(PASSWORD_ACCOUNT, 'connection');
    const pick = screen.getByLabelText(t('settings.accounts.sentFolder2'));
    expect(pick.value).toBe('Sent');
    fireEvent.change(pick, { target: { value: '' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('settings.accounts.saveSentFolder') })); });
    await flush();
    expect(writes().at(-1)).toEqual({ sentFolder: null });
  });

  it('is not offered where the server files the Sent copy itself', async () => {
    await open(GRAPH_ACCOUNT, 'connection');
    expect(screen.queryByLabelText(t('settings.accounts.sentFolder2'))).toBeNull();
  });
});

describe('profile', () => {
  it('writes the name a moment after typing stops, and the signature switch at once', async () => {
    await open(PASSWORD_ACCOUNT, 'profile');
    fireEvent.change(screen.getByLabelText(t('settings.accounts.displayName')), { target: { value: 'Ada L.' } });
    expect(writes()).toEqual([]);
    await wait(450);
    await flush();
    expect(writes()).toEqual([{ displayName: 'Ada L.' }]);
    const group = screen.getByRole('group', { name: t('settings.accounts.enableSignature') });
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: t('views.tristate.no') })); });
    await flush();
    expect(writes().at(-1)).toEqual({ signature: { html: '', text: '', enabled: false } });
  });

  it('a changed signature text is written as text, an unchanged one keeps the imported html', async () => {
    engine.settings.signature = { html: '<p><b>Ada</b></p>', text: 'Ada', enabled: true };
    await open(PASSWORD_ACCOUNT, 'profile');
    const field = screen.getByLabelText(t('settings.accounts.signatureContent'));
    expect(field.value).toBe('Ada');
    fireEvent.change(field, { target: { value: 'Ada' } });
    await wait(450);
    expect(writes()).toEqual([]);
    fireEvent.change(field, { target: { value: 'Ada Lovelace' } });
    await wait(450);
    await flush();
    expect(writes()).toEqual([{ signature: { html: '', text: 'Ada Lovelace', enabled: true } }]);
  });
});

describe('profile, typing then switching', () => {
  it('a signature typed just before the switch is turned off is written with the switch off', async () => {
    engine.settings.signature = { html: '', text: 'Ada', enabled: true };
    await open(PASSWORD_ACCOUNT, 'profile');
    fireEvent.change(screen.getByLabelText(t('settings.accounts.signatureContent')), { target: { value: 'Ada L.' } });
    const group = screen.getByRole('group', { name: t('settings.accounts.enableSignature') });
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: t('views.tristate.no') })); });
    await flush();
    await wait(450);
    await flush();
    expect(writes().at(-1)).toEqual({ signature: { html: '', text: 'Ada L.', enabled: false } });
    expect(engine.settings.signature).toEqual({ html: '', text: 'Ada L.', enabled: false });
  });
});

describe('advanced', () => {
  it('picks a colour from desktop\'s palette, then back to automatic', async () => {
    await open(PASSWORD_ACCOUNT, 'advanced');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${t('settings.accounts.avatarColor')}: #14b8a6` })); });
    await flush();
    expect(writes().at(-1)).toEqual({ color: '#14b8a6' });
    expect(screen.getByRole('button', { name: `${t('settings.accounts.avatarColor')}: #14b8a6` }).getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.reset') })); });
    await flush();
    expect(writes().at(-1)).toEqual({ color: null });
  });

  it('hides the account and re-reads the accounts', async () => {
    await open(PASSWORD_ACCOUNT, 'advanced');
    const group = screen.getByRole('group', { name: t('settings.accounts.accountVisible') });
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: t('settings.accounts.accountHidden') })); });
    await flush();
    expect(writes().at(-1)).toEqual({ hidden: true });
    expect(callsOf('mobile.accounts.list').length).toBeGreaterThan(0);
  });
});
