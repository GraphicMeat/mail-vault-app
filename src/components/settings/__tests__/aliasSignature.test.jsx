// @vitest-environment jsdom
// Settings > Accounts > Aliases: each alias signs with the account's signature
// or with one of its own. The settings store is real; the rich text editor is a
// textarea that reports HTML the way the real one does, and the daemon lookup is
// the boundary.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const { refreshAliases } = vi.hoisted(() => ({ refreshAliases: vi.fn() }));
vi.mock('../../../services/aliasDiscovery', () => ({ refreshAliases }));
vi.mock('../SendAsVerifyModal', () => ({ SendAsVerifyModal: () => null }));
vi.mock('../../RichTextEditor', async (importOriginal) => ({
  ...(await importOriginal()),
  RichTextEditor: ({ content, onUpdate }) => (
    <textarea data-testid="fake-editor" value={content} onChange={e => onUpdate(e.target.value)} />
  ),
}));

import { AliasesSection, _resetAliasesSection } from '../AliasesSection';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

const ACCOUNT = { id: 'studio', name: 'Studio', email: 'studio@example.test', imapHost: 'imap.example.test' };
const store = () => useSettingsStore.getState();
const row = address => screen.getAllByTestId('alias-row').find(r => r.getAttribute('data-address') === address);
const settle = () => act(async () => {});
const stored = address => store().getAliases('studio').find(a => a.address === address);

beforeEach(() => {
  _resetAliasesSection();
  refreshAliases.mockReset();
  refreshAliases.mockResolvedValue({ added: [], suggestions: [], providerStatus: 'unsupported' });
  useSettingsStore.setState({
    aliases: { studio: [
      { address: 'desk@example.test', name: 'Desk', source: 'manual' },
      { address: 'shop@example.test', name: '', source: 'manual', signature: { html: '<p>Shop</p>', text: 'Shop' } },
    ] },
    dismissedAliases: {},
    sendAsAddresses: {},
    displayNames: {},
    signatures: { studio: { html: '<p>Best, Studio</p>', text: 'Best, Studio', enabled: true } },
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('an alias signature choice', () => {
  it('is on every alias row and never on the login row', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(within(row('desk@example.test')).getByTestId('alias-signature')).toBeTruthy();
    expect(within(row('shop@example.test')).getByTestId('alias-signature')).toBeTruthy();
    expect(within(row('studio@example.test')).queryByTestId('alias-signature')).toBeNull();
  });

  it("marks the account's signature for an alias with none of its own, and mounts no editor for it", async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const desk = row('desk@example.test');
    expect(within(desk).getByTestId('alias-signature-account').getAttribute('aria-pressed')).toBe('true');
    expect(within(desk).getByTestId('alias-signature-own').getAttribute('aria-pressed')).toBe('false');
    expect(within(desk).queryByTestId('fake-editor')).toBeNull();
  });

  it('shows the own signature in an editor, for the alias that has one only', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const shop = row('shop@example.test');
    expect(within(shop).getByTestId('alias-signature-own').getAttribute('aria-pressed')).toBe('true');
    expect(within(shop).getByTestId('fake-editor').value).toBe('<p>Shop</p>');
    expect(screen.getAllByTestId('fake-editor')).toHaveLength(1);
  });

  it('is named by its address for assistive tech', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(screen.getByRole('group', { name: t('settings.accounts.aliases.signatureFor', { address: 'desk@example.test' }) })).toBeTruthy();
  });

  it("starts an own signature as a copy of the account's", async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.click(within(row('desk@example.test')).getByTestId('alias-signature-own'));
    expect(stored('desk@example.test').signature).toEqual({ html: '<p>Best, Studio</p>', text: 'Best, Studio' });
    expect(within(row('desk@example.test')).getByTestId('fake-editor').value).toBe('<p>Best, Studio</p>');
    // The account's own signature is untouched.
    expect(store().signatures.studio.html).toBe('<p>Best, Studio</p>');
  });

  it('saves what is typed a moment after typing stops', async () => {
    vi.useFakeTimers();
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.change(within(row('shop@example.test')).getByTestId('fake-editor'), { target: { value: '<p>Shop team</p>' } });
    expect(stored('shop@example.test').signature.html).toBe('<p>Shop</p>');
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(stored('shop@example.test').signature).toEqual({ html: '<p>Shop team</p>', text: 'Shop team' });
  });

  it('saves a pending edit when the section closes', async () => {
    const { unmount } = render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.change(within(row('shop@example.test')).getByTestId('fake-editor'), { target: { value: '<p>Late</p>' } });
    unmount();
    expect(stored('shop@example.test').signature.html).toBe('<p>Late</p>');
  });

  it('keeps a logo-only signature: no words, but a picture', async () => {
    vi.useFakeTimers();
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const logo = '<p><img src="data:image/png;base64,AAAA"></p>';
    fireEvent.change(within(row('shop@example.test')).getByTestId('fake-editor'), { target: { value: logo } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(stored('shop@example.test').signature.html).toBe(logo);
  });

  it('turns an emptied editor into an empty own signature, not the account signature', async () => {
    vi.useFakeTimers();
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.change(within(row('shop@example.test')).getByTestId('fake-editor'), { target: { value: '<p></p>' } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(stored('shop@example.test').signature).toEqual({ html: '', text: '' });
    expect(within(row('shop@example.test')).getByTestId('alias-signature-own').getAttribute('aria-pressed')).toBe('true');
  });

  it("hands the alias back to the account, and a pending edit does not bring the own signature back", async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const shop = row('shop@example.test');
    fireEvent.change(within(shop).getByTestId('fake-editor'), { target: { value: '<p>Unsaved</p>' } });
    fireEvent.click(within(shop).getByTestId('alias-signature-account'));
    await settle();
    expect('signature' in stored('shop@example.test')).toBe(false);
    expect(within(row('shop@example.test')).queryByTestId('fake-editor')).toBeNull();
    expect(within(row('shop@example.test')).getByTestId('alias-signature-account').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the size grade of a logo in the own signature', async () => {
    const big = `<p><img src="data:image/png;base64,${'A'.repeat(300 * 1024 * 4 / 3)}"></p>`;
    useSettingsStore.setState({ aliases: { studio: [{ address: 'shop@example.test', name: '', source: 'manual', signature: { html: big, text: '' } }] } });
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(document.querySelector('[data-signature-image-size]').getAttribute('data-tier')).toBe('alert');
  });

  it('drops the signature with the alias', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.click(within(row('shop@example.test')).getByTestId('alias-remove-btn'));
    expect(stored('shop@example.test')).toBeUndefined();
  });
});
