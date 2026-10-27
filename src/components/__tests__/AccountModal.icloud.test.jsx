// @vitest-environment jsdom

// Adding an Apple account asks for an app-specific password, which Apple makes
// on its own site. The password field carries an info button that says where,
// and links to Apple's page and to MailVault's step-by-step guide.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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

vi.mock('../../stores/accountStore', () => ({
  useAccountStore: () => ({ addAccount: vi.fn() }),
}));

vi.mock('../../services/api', () => ({
  getOAuth2AuthUrl: vi.fn(),
  getGoogleClients: vi.fn(async () => ({ mailvault: false, default: 'thunderbird' })),
  exchangeOAuth2Code: vi.fn(),
  testConnection: vi.fn(),
  resolveEmailSettings: vi.fn(),
}));

vi.mock('../../services/graphConfig', () => ({
  isPersonalMicrosoftEmail: vi.fn().mockReturnValue(false),
}));

const mockOpenInBrowser = vi.fn(async () => {});
vi.mock('../../services/billingApi', () => ({
  openInBrowser: (...a) => mockOpenInBrowser(...a),
}));

const { AccountModal } = await import('../AccountModal');

function openStep2(providerName) {
  render(<AccountModal onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.click(screen.getByText(providerName));
}

describe('AccountModal: Apple app-specific password help', () => {
  afterEach(() => {
    cleanup();
    mockOpenInBrowser.mockClear();
  });

  it('puts an info button beside the iCloud password that explains where to create one', () => {
    openStep2('iCloud Mail');
    fireEvent.click(screen.getByRole('button', { name: 'Where do I get an app-specific password?' }));
    const panel = screen.getByRole('dialog', { name: 'Where do I get an app-specific password?' });
    expect(panel.textContent).toContain('account.apple.com');
    expect(panel.textContent).toContain('App-Specific Passwords');
  });

  it('links to Apple\'s instructions and to the MailVault guide, opened outside the app', () => {
    openStep2('iCloud Mail');
    fireEvent.click(screen.getByRole('button', { name: 'Where do I get an app-specific password?' }));

    const apple = screen.getByRole('link', { name: /Apple's instructions/ });
    expect(apple.getAttribute('href')).toBe('https://support.apple.com/en-us/102654');
    const guide = screen.getByRole('link', { name: /Step-by-step guide/ });
    expect(guide.getAttribute('href')).toMatch(
      /^https:\/\/mailvaultapp\.com\/guides\/add-icloud-mail-to-mailvault\.html\?utm_source=app&utm_medium=icloud_app_password$/);

    fireEvent.click(guide);
    expect(mockOpenInBrowser).toHaveBeenCalledWith(guide.getAttribute('href'));
  });

  it('shows no such button for a provider that does not need an app password', () => {
    openStep2('Fastmail');
    expect(screen.queryByRole('button', { name: 'Where do I get an app-specific password?' })).toBeNull();
  });

  it('names the iCloud requirement from the catalog, not a hard-coded string', () => {
    openStep2('iCloud Mail');
    expect(screen.getByText('iCloud requires an App-Specific Password')).toBeTruthy();
  });
});
