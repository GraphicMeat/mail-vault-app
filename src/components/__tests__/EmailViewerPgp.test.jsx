// @vitest-environment jsdom

// OpenPGP in the reader: the daemon marks a message `pgp: 'decrypted'` when
// its body came from decryption, and `pgp: 'locked'` when it is encrypted
// and no imported key opens it. Locked mail shows a notice in place of the
// ciphertext. Same real-store render as EmailViewerRetrySpanning.test.jsx.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { EmailViewer } from '../EmailViewer';

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map(emails.map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});

const base = {
  uid: 41, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Sealed',
  from: { name: 'Ann', address: 'ann@example.test' }, to: [{ address: 'me@example.test' }],
  html: '', attachments: [], flags: ['\\Seen'], date: '2026-09-07',
};

function renderViewer(email) {
  useThemeStore.setState({ palette: 'graphite', theme: 'dark' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'local',
    emails: [email], sortedEmails: [email], savedEmailIds: new Set(), archivedEmailIds: new Set(),
    selectEmail: vi.fn(),
  });
  return render(<EmailViewer />);
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmailViewer and OpenPGP', () => {
  it('marks a decrypted message and renders its body', () => {
    renderViewer({ ...base, pgp: 'decrypted', text: 'The launch code is 4242.' });
    expect(screen.getByTestId('pgp-decrypted')).toBeTruthy();
    expect(screen.getByText(/launch code is 4242/)).toBeTruthy();
    expect(screen.queryByTestId('pgp-locked')).toBe(null);
  });

  it('shows the missing-key notice instead of the ciphertext', () => {
    renderViewer({ ...base, pgp: 'locked', text: '-----BEGIN PGP MESSAGE-----\nhQEMA\n-----END PGP MESSAGE-----' });
    expect(screen.getByTestId('pgp-locked').textContent).toContain('Settings > Privacy & security > Encryption');
    expect(screen.queryByText(/BEGIN PGP MESSAGE/)).toBe(null);
    expect(screen.queryByTestId('pgp-decrypted')).toBe(null);
  });

  it('adds nothing to a plain message', () => {
    renderViewer({ ...base, text: 'hello there' });
    expect(screen.queryByTestId('pgp-decrypted')).toBe(null);
    expect(screen.queryByTestId('pgp-locked')).toBe(null);
  });
});
