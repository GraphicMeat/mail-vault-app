// @vitest-environment jsdom

// Task 11: JMAP accounts in the add-account modal. The Fastmail preset signs
// in over JMAP with an API token unless the user picks IMAP; "Other" offers
// JMAP when autodetect found a session (preselected unless only SRV found
// it), or for a session URL typed by hand. A session host off the address's
// domain needs a tick before the first request carries the secret.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector) => selector({ localeEpoch: 0 }),
}));

const mockAddAccount = vi.fn();
vi.mock('../../stores/accountStore', () => ({
  useAccountStore: () => ({ addAccount: (...a) => mockAddAccount(...a) }),
}));

const mockResolveEmailSettings = vi.fn();
const mockTestConnection = vi.fn();
vi.mock('../../services/api', () => ({
  getOAuth2AuthUrl: vi.fn(),
  getGoogleClients: vi.fn(async () => ({ mailvault: false, default: 'thunderbird' })),
  exchangeOAuth2Code: vi.fn(),
  testConnection: (...a) => mockTestConnection(...a),
  resolveEmailSettings: (...a) => mockResolveEmailSettings(...a),
}));

vi.mock('../../services/graphConfig', () => ({
  isPersonalMicrosoftEmail: vi.fn().mockReturnValue(false),
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
}));

const { AccountModal } = await import('../AccountModal');
const { t } = await import('../../i18n/index.js');

const FASTMAIL_SESSION = 'https://api.fastmail.com/jmap/session';
const addButton = () => screen.getByRole('button', { name: t('settings.accounts.addAccount') });
const radio = (label) => screen.getByRole('radio', { name: label });
const submitted = () => mockAddAccount.mock.calls[0][0];

function openProvider(name) {
  render(<AccountModal onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.click(screen.getByText(name));
}

function type(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function addOther({ email = 'me@example.com', password = 'secret' } = {}) {
  openProvider(t('account.otherCustom'));
  type(`${t('account.emailAddress')}*`, email);
  type(t('account.passwordRequired'), password);
}

async function autodetect(result) {
  mockResolveEmailSettings.mockResolvedValue(result);
  fireEvent.click(screen.getByRole('button', { name: t('account.autoDetectServerSettings') }));
  await waitFor(() => expect(mockResolveEmailSettings).toHaveBeenCalled());
  await act(async () => {});
}

beforeEach(() => {
  mockAddAccount.mockReset().mockResolvedValue({ id: 'acct-new', connectionCheck: null });
  mockResolveEmailSettings.mockReset();
  mockTestConnection.mockReset().mockResolvedValue({ success: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AccountModal: JMAP accounts', () => {
  it('fastmail preset defaults to JMAP with token field', async () => {
    openProvider('Fastmail');

    expect(radio(t('account.protocolJmap')).checked).toBe(true);
    expect(screen.getByTestId('jmap-token-note').textContent).toContain(t('account.jmapFastmailToken'));
    // A token-only preset: no Basic/Bearer switch to get wrong.
    expect(screen.queryByRole('checkbox', { name: t('account.jmapUseToken') })).toBeNull();

    type(t('account.loginAddress'), 'me@fastmail.com');
    type(t('account.jmapApiToken'), 'fmu1-token');
    fireEvent.click(addButton());

    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(submitted()).toEqual({
      name: '',
      email: 'me@fastmail.com',
      password: 'fmu1-token',
      authType: 'password',
      jmapSessionUrl: FASTMAIL_SESSION,
      jmapAuth: 'bearer',
      imapHost: 'api.fastmail.com',
    });
  });

  it('toggle back to IMAP keeps the old fastmail path', async () => {
    openProvider('Fastmail');
    fireEvent.click(screen.getByRole('button', { name: t('account.jmapUseImapInstead') }));

    expect(radio(t('account.protocolImap')).checked).toBe(true);
    expect(screen.queryByTestId('jmap-fields')).toBeNull();
    type(t('account.loginAddress'), 'me@fastmail.com');
    type(t('account.passwordRequired'), 'app-password');
    fireEvent.click(addButton());

    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(submitted()).not.toHaveProperty('jmapSessionUrl');
    expect(submitted()).toMatchObject({
      email: 'me@fastmail.com', password: 'app-password', authType: 'password',
      imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com',
    });
  });

  it('discovered JMAP preselects JMAP with password', async () => {
    await addOther();
    await autodetect({ jmapSessionUrl: 'https://jmap.example.com/.well-known/jmap', jmapNeedsHostConfirmation: false, source: 'jmap' });

    expect(radio(t('account.protocolJmap')).checked).toBe(true);
    expect(screen.getByLabelText(t('account.passwordRequired'))).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: t('account.jmapUseToken') }).checked).toBe(false);
    // JMAP alone answered: the password is never tried on guessed IMAP hosts.
    expect(mockTestConnection).not.toHaveBeenCalled();

    fireEvent.click(addButton());
    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(submitted()).toMatchObject({
      email: 'me@example.com', password: 'secret',
      jmapSessionUrl: 'https://jmap.example.com/.well-known/jmap', jmapAuth: 'basic', imapHost: 'jmap.example.com',
    });
    expect(submitted()).not.toHaveProperty('jmapUsername');
  });

  it('the token switch signs in with Bearer', async () => {
    await addOther({ password: 'tok-123' });
    await autodetect({ jmapSessionUrl: 'https://jmap.example.com/jmap/session', jmapNeedsHostConfirmation: false, jmapSource: 'well-known', source: 'jmap' });

    fireEvent.click(screen.getByRole('checkbox', { name: t('account.jmapUseToken') }));
    expect(screen.getByLabelText(t('account.jmapApiToken'))).toBeTruthy();
    fireEvent.click(addButton());

    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(submitted()).toMatchObject({ jmapAuth: 'bearer', password: 'tok-123' });
  });

  it('foreign host blocks connect until confirmed', async () => {
    await addOther();
    await autodetect({
      jmapSessionUrl: 'https://mail.other.net:8443/jmap/session', jmapHost: 'mail.other.net:8443',
      jmapNeedsHostConfirmation: true, jmapSource: 'well-known', source: 'jmap',
    });

    // The port is part of where the secret would go, so it is named.
    const confirm = screen.getByRole('checkbox', { name: /Sign in at mail\.other\.net:8443\?/ });
    expect(addButton().disabled).toBe(true);

    fireEvent.click(confirm);
    expect(addButton().disabled).toBe(false);
    fireEvent.click(addButton());
    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(submitted()).toMatchObject({ jmapSessionUrl: 'https://mail.other.net:8443/jmap/session', imapHost: 'mail.other.net' });
  });

  it('the handler itself refuses an unconfirmed foreign host, not only the disabled button', async () => {
    await addOther();
    await autodetect({
      jmapSessionUrl: 'https://mail.other.net:8443/jmap/session', jmapHost: 'mail.other.net:8443',
      jmapNeedsHostConfirmation: true, jmapSource: 'well-known', source: 'jmap',
    });
    expect(addButton().disabled).toBe(true);

    // A programmatic submit (Enter in a field, a stray event) skips the button.
    await act(async () => { fireEvent.submit(addButton().closest('form')); });
    expect(mockAddAccount).not.toHaveBeenCalled();
    expect(mockTestConnection).not.toHaveBeenCalled();
  });

  it('an SRV-only hit is offered with IMAP still preselected', async () => {
    await addOther();
    await autodetect({
      imapHost: 'imap.example.com', imapPort: 993, smtpHost: 'smtp.example.com', smtpPort: 587, source: 'srv',
      jmapSessionUrl: 'https://mx.hoster.net/.well-known/jmap', jmapHost: 'mx.hoster.net',
      jmapNeedsHostConfirmation: true, jmapSource: 'srv',
    });

    expect(radio(t('account.protocolImap')).checked).toBe(true);
    expect(radio(t('account.protocolJmap')).checked).toBe(false);
    expect(screen.getByLabelText(t('account.imapHostRequired')).value).toBe('imap.example.com');

    fireEvent.click(radio(t('account.protocolJmap')));
    expect(screen.getByRole('checkbox', { name: /Sign in at mx\.hoster\.net\?/ })).toBeTruthy();
    expect(addButton().disabled).toBe(true);
  });

  it('a username override reaches addAccount as jmapUsername', async () => {
    await addOther({ email: 'me@example.org', password: 'pw' });
    fireEvent.click(screen.getByRole('button', { name: t('account.enterManualSettings') }));
    fireEvent.click(radio(t('account.protocolJmap')));

    // Nothing discovered: Advanced is open, with the session URL to type.
    type(t('account.jmapSessionUrl'), 'https://mail.example.org/jmap/session');
    type(t('account.jmapUsername'), 'alice');
    fireEvent.click(addButton());

    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(submitted()).toMatchObject({
      email: 'me@example.org', password: 'pw', jmapAuth: 'basic', jmapUsername: 'alice',
      jmapSessionUrl: 'https://mail.example.org/jmap/session', imapHost: 'mail.example.org',
    });
  });

  it('refuses a session URL that is not https before anything is sent', async () => {
    await addOther();
    fireEvent.click(screen.getByRole('button', { name: t('account.enterManualSettings') }));
    fireEvent.click(radio(t('account.protocolJmap')));
    type(t('account.jmapSessionUrl'), 'http://mail.example.com/jmap/session');
    fireEvent.click(addButton());

    expect(await screen.findByText(t('account.jmapSessionUrlInvalid'))).toBeTruthy();
    expect(mockAddAccount).not.toHaveBeenCalled();
  });
});
