// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import AddAccount from '../AddAccount.jsx';
import { ReauthBanner } from '../AccountSwitcher.jsx';
import AccountSwitcher from '../AccountSwitcher.jsx';
import { oauthSignIn, oauthReauth } from '../oauth.js';
import { daemonCall, openAuthSheet, closeAuthSheet } from '../transport.js';
import { ERROR_KEYS, errorKey } from '../errors.js';
import { t } from '../i18n.js';
import en from '../../i18n/locales/en.json';

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(),
  openAuthSheet: vi.fn(),
  closeAuthSheet: vi.fn(async () => {}),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const field = (key) => screen.getByLabelText(t(key));

function fillFirstStep(email = 'ada@example.test', password = 'secret-pw') {
  // The provider picker comes first; the IMAP form is "Other (IMAP)".
  const other = screen.queryByRole('button', { name: t('mobile.add.imap') });
  if (other) fireEvent.click(other);
  fireEvent.change(field('mobile.add.email'), { target: { value: email } });
  fireEvent.change(field('mobile.add.password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: t('common.next') }));
}

describe('AddAccount', () => {
  it('asks for email and password first, then prefills the server from the domain', () => {
    render(<AddAccount onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.add.imap') }));
    expect(screen.getByRole('button', { name: t('common.next') }).disabled).toBe(true);
    fillFirstStep('ada@mail.example.test');
    expect(field('mobile.add.host').value).toBe('imap.mail.example.test');
    expect(field('mobile.add.port').value).toBe('993');
    expect(field('account.security').value).toBe('ssl');
    // Editable: a typed host is kept, and STARTTLS moves the default port.
    fireEvent.change(field('mobile.add.host'), { target: { value: 'mx.example.test' } });
    fireEvent.change(field('account.security'), { target: { value: 'starttls' } });
    expect(field('mobile.add.host').value).toBe('mx.example.test');
    expect(field('mobile.add.port').value).toBe('143');
  });

  it('prefills smtp from the address domain and shows the smtp fields on the server step', () => {
    render(<AddAccount onSubmit={vi.fn()} />);
    fillFirstStep('ada@mail.example.test');
    expect(field('mobile.add.smtpHost').value).toBe('smtp.mail.example.test');
    expect(field('mobile.add.smtpPort').value).toBe('465');
    expect(field('mobile.add.smtpSecurity').value).toBe('ssl');
    // STARTTLS moves the default SMTP port to 587; a typed host is kept.
    fireEvent.change(field('mobile.add.smtpSecurity'), { target: { value: 'starttls' } });
    expect(field('mobile.add.smtpPort').value).toBe('587');
    fireEvent.change(field('mobile.add.smtpHost'), { target: { value: 'out.example.test' } });
    expect(field('mobile.add.smtpHost').value).toBe('out.example.test');
    // The IMAP host changing does not touch the SMTP one.
    fireEvent.change(field('mobile.add.host'), { target: { value: 'mx.example.test' } });
    expect(field('mobile.add.smtpHost').value).toBe('out.example.test');
  });

  it('shows the translated SMTP_FAILED error and keeps the password', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, code: 'SMTP_FAILED' }));
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
    });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.SMTP_FAILED'));
    expect(t('mobile.error.SMTP_FAILED')).not.toBe('mobile.error.SMTP_FAILED');
    expect(field('mobile.add.password').value).toBe('secret-pw');
  });

  it('submit_disabled_while_testing', async () => {
    const pending = deferred();
    const onSubmit = vi.fn(() => pending.promise);
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    const submit = screen.getByRole('button', { name: t('mobile.add.signIn') });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'ada@example.test', password: 'secret-pw', imapHost: 'imap.example.test', imapPort: 993, security: 'ssl',
      smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl',
    });
    const busy = screen.getByRole('button', { name: t('mobile.add.signingIn') });
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ ok: true }); });
  });

  it('auth_failed_shows_translated_error_and_keeps_form', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, code: 'AUTH_FAILED' }));
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    fireEvent.change(field('mobile.add.port'), { target: { value: '1993' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
    });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.AUTH_FAILED'));
    expect(t('mobile.error.AUTH_FAILED')).not.toBe('mobile.error.AUTH_FAILED');
    // The form stays as typed; only the password is cleared (it never outlives a submit).
    expect(screen.getByText('ada@example.test')).toBeTruthy();
    expect(field('mobile.add.host').value).toBe('imap.example.test');
    expect(field('mobile.add.port').value).toBe('1993');
    expect(field('account.security').value).toBe('ssl');
    expect(field('mobile.add.password').value).toBe('');
    expect(screen.getByRole('button', { name: t('mobile.add.signIn') }).disabled).toBe(true);
    fireEvent.change(field('mobile.add.password'), { target: { value: 'again' } });
    expect(screen.getByRole('button', { name: t('mobile.add.signIn') }).disabled).toBe(false);
    // Back to the first step: the address is still there.
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(field('mobile.add.email').value).toBe('ada@example.test');
  });

  it('a network error keeps the password for the retry', async () => {
    for (const code of ['HOST_UNREACHABLE', 'TLS_FAILED', 'TIMEOUT']) {
      const onSubmit = vi.fn(async () => ({ ok: false, code }));
      render(<AddAccount onSubmit={onSubmit} />);
      fillFirstStep();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
      });
      expect(screen.getByRole('alert').textContent).toBe(t(errorKey(code)));
      expect(field('mobile.add.password').value, code).toBe('secret-pw');
      // Fix the server and try again without retyping.
      fireEvent.change(field('mobile.add.host'), { target: { value: 'mx.example.test' } });
      const retry = screen.getByRole('button', { name: t('mobile.add.signIn') });
      expect(retry.disabled).toBe(false);
      await act(async () => { fireEvent.click(retry); });
      expect(onSubmit).toHaveBeenLastCalledWith({
        email: 'ada@example.test', password: 'secret-pw', imapHost: 'mx.example.test', imapPort: 993, security: 'ssl',
        smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl',
      });
      cleanup();
    }
  });

  it('a thrown submit shows the generic error', async () => {
    const onSubmit = vi.fn(async () => { throw new Error('bridge gone'); });
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
    });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.INTERNAL'));
  });

  it('every engine code has a translated message, and an unknown one falls back', () => {
    for (const code of ['AUTH_FAILED', 'HOST_UNREACHABLE', 'TLS_FAILED', 'TIMEOUT', 'DUPLICATE', 'INVALID', 'SMTP_FAILED', 'INTERNAL', 'NEEDS_AUTH', 'CANCELLED', 'NO_BROWSER']) {
      expect(ERROR_KEYS[code], code).toBeDefined();
      expect(en[ERROR_KEYS[code]], code).toBeTruthy();
    }
    expect(errorKey('SOMETHING_NEW')).toBe(ERROR_KEYS.INTERNAL);
    expect(errorKey(undefined)).toBe(ERROR_KEYS.INTERNAL);
  });

  it('cancel is offered only when there is somewhere to go back to', () => {
    const onCancel = vi.fn();
    render(<AddAccount onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: t('common.cancel') })).toBeNull();
    cleanup();
    render(<AddAccount onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('inputs use the right keyboards and no autofill of the password into anything but a password field', () => {
    render(<AddAccount onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.add.imap') }));
    expect(field('mobile.add.email').getAttribute('type')).toBe('email');
    expect(field('mobile.add.password').getAttribute('type')).toBe('password');
    fillFirstStep();
    expect(field('mobile.add.port').getAttribute('inputmode')).toBe('numeric');
  });
});

// The engine's OAuth flow over a mocked transport: `begin` answers a flow and its URL, the sheet
// and `finish` are each a promise the test settles in the order it wants.
function oauthEngine({ url = 'https://accounts.google.com/o/oauth2/v2/auth?x=1', flowId = 'f1' } = {}) {
  const finish = deferred();
  const sheet = deferred();
  daemonCall.mockImplementation(async (method) => {
    if (method === 'mobile.oauth.begin' || method === 'mobile.oauth.reauth') return { flowId, url };
    if (method === 'mobile.oauth.finish') return finish.promise;
    if (method === 'mobile.oauth.cancel') return { cancelled: true };
    throw new Error(`unexpected ${method}`);
  });
  openAuthSheet.mockImplementation(() => sheet.promise);
  return { finish, sheet, url, flowId };
}

const calls = (method) => daemonCall.mock.calls.filter(([m]) => m === method);

describe('AddAccount provider picker', () => {
  it('offers the four providers first, JMAP disabled until it is wired', () => {
    render(<AddAccount onSubmit={vi.fn()} onOAuth={vi.fn()} />);
    expect(screen.getByRole('button', { name: t('mobile.add.google') }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: t('mobile.add.microsoft') }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: t('mobile.add.jmap') }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: t('mobile.add.imap') }).disabled).toBe(false);
    expect(en['mobile.add.microsoft']).toBe('Microsoft (Outlook, Hotmail, Microsoft 365)');
    expect(en['mobile.add.jmap']).toBe('Fastmail and other JMAP');
    expect(en['mobile.add.imap']).toBe('Other (IMAP)');
    expect(screen.queryByLabelText(t('mobile.add.password'))).toBeNull();
  });

  it('google button runs begin, opens the sheet, finishes and closes it', async () => {
    const engine = oauthEngine();
    const onOAuth = vi.fn((provider) => oauthSignIn(provider));
    render(<AddAccount onSubmit={vi.fn()} onOAuth={onOAuth} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.google') }));
    });
    expect(onOAuth).toHaveBeenCalledWith('google');
    expect(calls('mobile.oauth.begin')).toEqual([['mobile.oauth.begin', { provider: 'google' }]]);
    expect(openAuthSheet).toHaveBeenCalledWith(engine.url);
    // The sheet is not awaited: finish is already waiting for the code.
    expect(calls('mobile.oauth.finish')).toEqual([['mobile.oauth.finish', { flowId: 'f1' }]]);
    expect(closeAuthSheet).not.toHaveBeenCalled();
    expect(screen.getByText(t('mobile.add.waiting'))).toBeTruthy();
    const account = { id: 'a1', email: 'ada@gmail.test', needsAuth: false };
    await act(async () => { engine.finish.resolve({ ok: true, account }); });
    expect(closeAuthSheet).toHaveBeenCalledTimes(1);
    expect(calls('mobile.oauth.cancel')).toEqual([]);
    await expect(onOAuth.mock.results[0].value).resolves.toEqual({ ok: true, account });
    // The sheet's late answer (closed by us) changes nothing.
    await act(async () => { engine.sheet.resolve({ cancelled: false }); });
    expect(calls('mobile.oauth.cancel')).toEqual([]);
  });

  it('a cancelled sheet cancels the flow and returns to the picker', async () => {
    const engine = oauthEngine();
    render(<AddAccount onSubmit={vi.fn()} onOAuth={(p) => oauthSignIn(p)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.microsoft') }));
    });
    expect(calls('mobile.oauth.begin')).toEqual([['mobile.oauth.begin', { provider: 'microsoft' }]]);
    await act(async () => { engine.sheet.resolve({ cancelled: true }); });
    expect(calls('mobile.oauth.cancel')).toEqual([['mobile.oauth.cancel', { flowId: 'f1' }]]);
    // Finish is still the authority: it answers CANCELLED once the engine has given up.
    await act(async () => { engine.finish.resolve({ ok: false, code: 'CANCELLED' }); });
    expect(screen.getByRole('button', { name: t('mobile.add.google') }).disabled).toBe(false);
    expect(screen.queryByText(t('mobile.add.waiting'))).toBeNull();
    // A cancel is the user's own choice: no error.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a sheet cancelled after the code arrived still adds the account', async () => {
    const engine = oauthEngine();
    const pending = oauthSignIn('google');
    await act(async () => {});
    await act(async () => { engine.sheet.resolve({ cancelled: true }); });
    const account = { id: 'a1', email: 'ada@gmail.test' };
    engine.finish.resolve({ ok: true, account });
    await expect(pending).resolves.toEqual({ ok: true, account });
    expect(closeAuthSheet).toHaveBeenCalled();
  });

  it('a sheet that cannot open cancels the flow and says why', async () => {
    const engine = oauthEngine();
    openAuthSheet.mockImplementation(async () => { throw Object.assign(new Error('no browser'), { code: 'NO_APP' }); });
    render(<AddAccount onSubmit={vi.fn()} onOAuth={(p) => oauthSignIn(p)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.google') }));
    });
    expect(calls('mobile.oauth.cancel')).toEqual([['mobile.oauth.cancel', { flowId: 'f1' }]]);
    await act(async () => { engine.finish.resolve({ ok: false, code: 'CANCELLED' }); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.NO_BROWSER'));
  });

  it('a failed sign-in shows the translated error on the picker', async () => {
    const engine = oauthEngine();
    render(<AddAccount onSubmit={vi.fn()} onOAuth={(p) => oauthSignIn(p)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.google') }));
    });
    await act(async () => { engine.finish.resolve({ ok: false, code: 'DUPLICATE' }); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.DUPLICATE'));
    expect(closeAuthSheet).toHaveBeenCalledTimes(1);
  });
});

describe('needs_auth', () => {
  const parked = { id: 'a1', email: 'ada@gmail.test', displayName: 'ada@gmail.test', needsAuth: true, provider: 'google', kind: 'imap' };

  it('needs_auth account shows a Sign in again banner that starts reauth', async () => {
    const engine = oauthEngine();
    const onReauth = vi.fn((id) => oauthReauth(id));
    render(<ReauthBanner account={parked} onReauth={onReauth} />);
    expect(screen.getByRole('status').textContent).toContain('ada@gmail.test');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.reauth.action') }));
    });
    expect(onReauth).toHaveBeenCalledWith('a1');
    expect(calls('mobile.oauth.reauth')).toEqual([['mobile.oauth.reauth', { accountId: 'a1' }]]);
    expect(openAuthSheet).toHaveBeenCalledWith(engine.url);
    expect(screen.getByRole('button', { name: t('mobile.add.signingIn') }).disabled).toBe(true);
    await act(async () => { engine.finish.resolve({ ok: true, account: { ...parked, needsAuth: false } }); });
    expect(closeAuthSheet).toHaveBeenCalledTimes(1);
  });

  it('a failed reauth says why and offers the button again', async () => {
    const engine = oauthEngine();
    render(<ReauthBanner account={parked} onReauth={(id) => oauthReauth(id)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.reauth.action') }));
    });
    await act(async () => { engine.finish.resolve({ ok: false, code: 'AUTH_FAILED' }); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.AUTH_FAILED'));
    expect(screen.getByRole('button', { name: t('mobile.reauth.action') }).disabled).toBe(false);
  });

  it('shows no banner for an account that signs in fine', () => {
    const { container } = render(<ReauthBanner account={{ ...parked, needsAuth: false }} onReauth={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('the switcher offers Sign in again on a needs_auth row', () => {
    const onReauth = vi.fn();
    const ok = { id: 'a2', email: 'bo@example.test', needsAuth: false };
    render(
      <AccountSwitcher accounts={[parked, ok]} activeAccountId="a2" unread={{}} onSelect={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()} onReauth={onReauth} onClose={vi.fn()} />,
    );
    const buttons = screen.getAllByRole('button', { name: t('mobile.reauth.action') });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onReauth).toHaveBeenCalledWith('a1');
  });
});
