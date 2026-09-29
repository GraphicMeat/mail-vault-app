// @vitest-environment jsdom

// A logo in the signature goes out with every email, so Settings grades its
// size where it is added, and a logo-only signature must survive being saved.
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

const accounts = [{ id: 'studio', name: 'Studio', email: 'studio@example.test', password: 'saved-password', imapHost: 'imap.example.test' }];
const KB = 1024;
// Base64 that decodes to exactly `n` bytes.
const base64OfBytes = (n) =>
  'A'.repeat(4 * Math.floor(n / 3)) + (n % 3 === 1 ? 'AA==' : n % 3 === 2 ? 'AAA=' : '');
const logo = (bytes) => `<img src="data:image/png;base64,${base64OfBytes(bytes)}" alt="logo.png">`;

const seed = (html, text = '') =>
  useSettingsStore.setState({ signatures: { studio: { html, text, enabled: true } } });

beforeEach(() => {
  useSettingsStore.setState({ signatures: {}, displayNames: {}, sendAsAddresses: {}, accountColors: {}, accountOrder: [], hiddenAccounts: {} });
  useMailStore.setState({ accounts, activeAccountId: 'studio', activeMailbox: 'INBOX', mailboxes: [], connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
});
afterEach(() => cleanup());

const sizeStatus = () => document.querySelector('[data-signature-image-size]');

it.each([
  [99, 'good', 'settings.accounts.signatureImageGood'],
  [100, 'warn', 'settings.accounts.signatureImageWarn'],
  [200, 'warn', 'settings.accounts.signatureImageWarn'],
  [201, 'alert', 'settings.accounts.signatureImageAlert'],
])('grades a %i KB logo as %s, in words and not only in colour', async (kb, tier, key) => {
  seed(`<p>Rokas</p><p>${logo(kb * KB)}</p>`, 'Rokas');
  render(<AccountSettings accounts={accounts} />);
  const status = await vi.waitFor(() => {
    const el = sizeStatus();
    if (!el) throw new Error('no size status yet');
    return el;
  });
  expect(status.getAttribute('role')).toBe('status');
  expect(status.getAttribute('aria-live')).toBe('polite');
  expect(status.getAttribute('data-tier')).toBe(tier);
  expect(status.textContent).toContain(t(key, { size: kb }));
});

it('shows no grade for a signature without an embedded picture, only the advice', () => {
  seed('<p>Best regards</p><p><img src="https://example.com/logo.png"></p>', 'Best regards');
  render(<AccountSettings accounts={accounts} />);
  expect(sizeStatus()).toBeNull();
  expect(screen.getByText(t('settings.accounts.signatureImageHint'))).toBeTruthy();
});

it('keeps a signature that is only a logo when Settings saves it', () => {
  const html = `<p>${logo(3 * KB)}</p>`;
  seed(html);
  const { unmount } = render(<AccountSettings accounts={accounts} />);
  // Leaving Settings flushes the pending edit; the plain-text twin of a logo
  // is empty, and that alone used to save the signature as nothing.
  unmount();
  const saved = useSettingsStore.getState().getSignature('studio');
  expect(saved.html).toContain('<img');
  expect(saved.html).toContain('data:image/png;base64,');
  expect(saved.enabled).toBe(true);
});
