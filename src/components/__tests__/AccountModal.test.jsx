// @vitest-environment jsdom

// Track B (B2): after a Google sign-in returns, the add used to sit waiting
// for a second click on "Add Account" — exchangeOAuth2Code resolving only
// filled the form, nothing submitted it. These specs drive the real
// handleOAuth2SignIn flow and check the add finishes on its own, and that a
// signed-in address that doesn't match what the user typed is caught before
// anything is saved (Q3: Google's id_token `email` claim vs the typed
// address).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

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

// useT() (AccountModal, and ui/Dialog underneath it) subscribes to this for
// locale-change re-renders — a fixed epoch is all a render test needs.
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector) => selector({ localeEpoch: 0 }),
}));

const mockAddAccount = vi.fn();
vi.mock('../../stores/accountStore', () => ({
  useAccountStore: () => ({ addAccount: (...a) => mockAddAccount(...a) }),
}));

const mockGetOAuth2AuthUrl = vi.fn();
const mockExchangeOAuth2Code = vi.fn();
vi.mock('../../services/api', () => ({
  getOAuth2AuthUrl: (...a) => mockGetOAuth2AuthUrl(...a),
  exchangeOAuth2Code: (...a) => mockExchangeOAuth2Code(...a),
  testConnection: vi.fn(),
  resolveEmailSettings: vi.fn(),
}));

vi.mock('../../services/graphConfig', () => ({
  isPersonalMicrosoftEmail: vi.fn().mockReturnValue(false),
}));

const { AccountModal } = await import('../AccountModal');

const TYPED_EMAIL = 'user@gmail.com';

async function openGmailStep2() {
  render(<AccountModal onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.click(screen.getByText('Gmail'));
  const emailInput = await screen.findByLabelText('Email Address *');
  fireEvent.change(emailInput, { target: { name: 'email', value: TYPED_EMAIL } });
  return emailInput;
}

describe('AccountModal — OAuth callback finishes the add', () => {
  beforeEach(() => {
    mockAddAccount.mockReset();
    mockGetOAuth2AuthUrl.mockReset().mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 'state-1' });
    mockExchangeOAuth2Code.mockReset();
    vi.spyOn(window, 'open').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('adds the account with no extra click once the sign-in resolves, carrying the typed email', async () => {
    mockExchangeOAuth2Code.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      email: TYPED_EMAIL, // Google's id_token claim, matches what was typed
      clientId: 'own.apps.googleusercontent.com', // the OAuth client that issued the tokens
    });
    mockAddAccount.mockResolvedValue({ id: 'acct-1', email: TYPED_EMAIL });

    await openGmailStep2();

    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));

    // Nothing else is clicked from here — addAccount firing, and the
    // "Connected!" success state appearing, is entirely the callback's doing.
    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Connected!')).toBeTruthy();

    const submitted = mockAddAccount.mock.calls[0][0];
    expect(submitted.email).toBe(TYPED_EMAIL);
    expect(submitted.authType).toBe('oauth2');
    expect(submitted.oauth2AccessToken).toBe('access-token');
    // Saved with the refresh token, so a later refresh goes out as this client.
    expect(submitted.oauth2RefreshToken).toBe('refresh-token');
    expect(submitted.oauth2ClientId).toBe('own.apps.googleusercontent.com');
  });

  it('blocks the add when the signed-in account does not match the typed address', async () => {
    mockExchangeOAuth2Code.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      email: 'someone-else@gmail.com',
    });

    await openGmailStep2();

    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));

    await screen.findByText(/You typed user@gmail\.com, but signed in as someone-else@gmail\.com/);
    expect(mockAddAccount).not.toHaveBeenCalled();

    // No tokens were kept under the typed address, so the fallback "Add
    // Account" button must not be usable as-is — oauthConnected never
    // flipped true.
    const submitButton = screen.getByRole('button', { name: /Add Account/i });
    expect(submitButton.disabled).toBe(true);
  });

  // Fix round 1 (task-B2-review.md, Important): Google's id_token claim is
  // always the canonical, dot-free address — a user who typed dots into a
  // real Gmail address must not be told it's the wrong account.
  it('accepts a Gmail sign-in whose claim differs from the typed address only by dots', async () => {
    const dottedTyped = 'us.er@gmail.com';
    mockExchangeOAuth2Code.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      email: 'user@gmail.com', // Google's canonical (dot-free) claim
    });
    mockAddAccount.mockResolvedValue({ id: 'acct-3', email: dottedTyped });

    render(<AccountModal onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByText('Gmail'));
    const emailInput = await screen.findByLabelText('Email Address *');
    fireEvent.change(emailInput, { target: { name: 'email', value: dottedTyped } });

    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));

    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    expect(mockAddAccount.mock.calls[0][0].email).toBe(dottedTyped);
  });

  it('skips the claim check when the provider returns no email claim (Microsoft today)', async () => {
    mockExchangeOAuth2Code.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      // no `email` field at all
    });
    mockAddAccount.mockResolvedValue({ id: 'acct-2', email: TYPED_EMAIL });

    render(<AccountModal onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.click(screen.getByText('Outlook / Microsoft 365'));
    const emailInput = await screen.findByLabelText('Email Address *');
    fireEvent.change(emailInput, { target: { name: 'email', value: TYPED_EMAIL } });

    fireEvent.click(screen.getByRole('button', { name: /Sign in with Microsoft/i }));

    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
  });
});

// A pass says what it reached, under the form, in the moment before the modal
// closes: the server, how many messages the Inbox holds and the address mail
// will leave as. It never holds the flow up: onSuccess still fires on time.
describe('AccountModal: what the connection test reached', () => {
  const SIGNED_IN = { accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: 1234567890, email: TYPED_EMAIL };

  beforeEach(() => {
    mockAddAccount.mockReset();
    mockGetOAuth2AuthUrl.mockReset().mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 'state-1' });
    mockExchangeOAuth2Code.mockReset().mockResolvedValue(SIGNED_IN);
    vi.spyOn(window, 'open').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function addWith(connectionCheck) {
    mockAddAccount.mockResolvedValue({ id: 'acct-9', email: TYPED_EMAIL, connectionCheck });
    await openGmailStep2();
    fireEvent.click(screen.getByRole('button', { name: /Sign in with Google/i }));
    await waitFor(() => expect(mockAddAccount).toHaveBeenCalledTimes(1));
    await screen.findByText('Connected!');
  }

  it('names the server, the Inbox count (grouped) and the send-as address', async () => {
    await addWith({ host: 'imap.gmail.com', messageCount: 1204, fromAddress: 'alias@example.test' });
    expect(screen.getByText(
      'Connected to imap.gmail.com. 1,204 messages in your Inbox. Mail will be sent as alias@example.test.'
    )).toBeTruthy();
  });

  it('says "message" for one', async () => {
    await addWith({ host: 'imap.gmail.com', messageCount: 1, fromAddress: TYPED_EMAIL });
    expect(screen.getByText(`Connected to imap.gmail.com. 1 message in your Inbox. Mail will be sent as ${TYPED_EMAIL}.`)).toBeTruthy();
  });

  it('leaves the count out when the test could not read it', async () => {
    await addWith({ host: 'imap.gmail.com', messageCount: null, fromAddress: TYPED_EMAIL });
    expect(screen.getByText(`Connected to imap.gmail.com. Mail will be sent as ${TYPED_EMAIL}.`)).toBeTruthy();
    expect(screen.queryByText(/in your Inbox/)).toBeNull();
  });

  it('shows no summary when the test reported none (Outlook through Graph)', async () => {
    await addWith(null);
    expect(screen.queryByText(/Connected to /)).toBeNull();
  });
});

describe('AccountModal — privacy mode', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('hides the paint of the typed address and display name (ruling R14)', async () => {
    const { usePrivacyStore } = await import('../../stores/privacyStore');
    vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
    usePrivacyStore.setState({ enabled: true });
    try {
      const emailInput = await openGmailStep2();
      expect(emailInput.className).toContain('mv-private-input');
      expect(screen.getByLabelText('Display Name (optional)').className).toContain('mv-private-input');
    } finally {
      usePrivacyStore.setState({ enabled: false });
    }
  });
});
