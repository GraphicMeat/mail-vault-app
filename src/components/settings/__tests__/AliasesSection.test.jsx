// @vitest-environment jsdom
// Settings > Accounts > Aliases: the addresses one account sends from. The
// settings store is real; the daemon lookup (services/aliasDiscovery) and the
// Verify dialog's real send are the boundaries.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { refreshAliases } = vi.hoisted(() => ({ refreshAliases: vi.fn() }));
vi.mock('../../../services/aliasDiscovery', () => ({ refreshAliases }));
vi.mock('../SendAsVerifyModal', () => ({
  SendAsVerifyModal: ({ sendAsAddress, displayName, onClose }) => (
    <div data-testid="send-as-verify-modal" data-address={sendAsAddress} data-name={displayName}>
      <button type="button" onClick={onClose}>close</button>
    </div>
  ),
}));

import { AliasesSection, _resetAliasesSection } from '../AliasesSection';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';

const ACCOUNT = { id: 'studio', name: 'Studio', email: 'studio@example.test', imapHost: 'imap.example.test' };
const GMAIL = { id: 'g', name: 'G', email: 'me@gmail.test', authType: 'oauth2', oauth2Provider: 'google' };
const NOTHING = { added: [], suggestions: [], providerStatus: 'unsupported' };

const rows = () => screen.getAllByTestId('alias-row');
const row = address => rows().find(r => r.getAttribute('data-address') === address);
const store = () => useSettingsStore.getState();
const seed = aliases => useSettingsStore.setState({ aliases: { studio: aliases } });
const settle = () => act(async () => {});

beforeEach(() => {
  _resetAliasesSection();
  refreshAliases.mockReset();
  refreshAliases.mockResolvedValue(NOTHING);
  useSettingsStore.setState({ aliases: {}, dismissedAliases: {}, sendAsAddresses: {}, displayNames: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the address list', () => {
  it('lists the login first, marked Login and not removable, then each alias with its source', async () => {
    seed([
      { address: 'desk@example.test', name: 'Front Desk', source: 'provider' },
      { address: 'shop@example.test', name: '', source: 'detected' },
      { address: 'me@example.test', name: '', source: 'manual' },
    ]);
    render(<AliasesSection account={ACCOUNT} displayName="Studio Team" />);
    await settle();

    expect(rows().map(r => r.getAttribute('data-address')))
      .toEqual(['studio@example.test', 'desk@example.test', 'shop@example.test', 'me@example.test']);
    const login = row('studio@example.test');
    expect(login.getAttribute('data-login')).toBe('true');
    expect(within(login).getByText(t('settings.accounts.aliases.badgeLogin'))).toBeTruthy();
    expect(within(login).queryByTestId('alias-remove-btn')).toBeNull();
    expect(within(login).queryByTestId('alias-name-input')).toBeNull();

    const badge = address => within(row(address)).getByTestId('alias-source-badge').textContent;
    expect(badge('desk@example.test')).toBe(t('settings.accounts.aliases.source.provider'));
    expect(badge('shop@example.test')).toBe(t('settings.accounts.aliases.source.detected'));
    expect(badge('me@example.test')).toBe(t('settings.accounts.aliases.source.manual'));

    const name = within(row('desk@example.test')).getByTestId('alias-name-input');
    expect(name.value).toBe('Front Desk');
    // The placeholder is the name the account itself sends under.
    expect(within(row('shop@example.test')).getByTestId('alias-name-input').placeholder).toBe('Studio Team');
    // Every name field is labelled.
    expect(screen.getAllByLabelText(t('settings.accounts.aliases.nameLabel'))).toHaveLength(3);
  });

  it('never lists the login twice, even when an old default From put it among the aliases', async () => {
    seed([{ address: 'Studio@Example.test', name: '', source: 'manual' }]);
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(rows()).toHaveLength(1);
  });

  it('explains aliases when there are none, and keeps the add row', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(screen.getByTestId('aliases-empty').textContent).toBe(t('settings.accounts.aliases.empty'));
    expect(screen.getByTestId('alias-add-input')).toBeTruthy();
    expect(screen.queryByTestId('aliases-suggestions')).toBeNull();
  });

  it('drops the empty state once an alias exists', async () => {
    seed([{ address: 'desk@example.test', name: '', source: 'manual' }]);
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(screen.queryByTestId('aliases-empty')).toBeNull();
  });

  it('says how aliases are found: automatically for Google, from your mail for the rest', async () => {
    const { unmount } = render(<AliasesSection account={GMAIL} />);
    await settle();
    expect(screen.getByTestId('aliases-provider-hint').textContent).toBe(t('settings.accounts.aliases.hintGmail'));
    unmount();
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(screen.getByTestId('aliases-provider-hint').textContent).toBe(t('settings.accounts.aliases.hintOther'));
  });
});

describe('adding an alias', () => {
  const type = (testid, value) => fireEvent.change(screen.getByTestId(testid), { target: { value } });
  const submit = () => fireEvent.submit(screen.getByTestId('alias-add-form'));

  it.each([
    ['not-an-address', 'invalid'],
    ['STUDIO@example.test', 'login'],
    ['desk@example.test', 'duplicate'],
  ])('refuses %s and says why (%s)', async (address, reason) => {
    seed([{ address: 'desk@example.test', name: '', source: 'manual' }]);
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    type('alias-add-input', address);
    submit();
    const error = screen.getByTestId('alias-add-error');
    expect(error.textContent).toBe(t(`settings.accounts.aliases.error.${reason}`));
    const input = screen.getByTestId('alias-add-input');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(store().aliases.studio).toHaveLength(1);
    // Typing again clears the complaint.
    type('alias-add-input', 'x');
    expect(screen.queryByTestId('alias-add-error')).toBeNull();
  });

  it('adds a typed alias with its name, by Enter or the Add button, and clears the row', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    type('alias-add-input', ' desk@example.test ');
    type('alias-add-name-input', 'Front Desk');
    submit();
    expect(store().aliases.studio).toEqual([{ address: 'desk@example.test', name: 'Front Desk', source: 'manual' }]);
    expect(screen.getByTestId('alias-add-input').value).toBe('');
    expect(screen.getByTestId('alias-add-name-input').value).toBe('');
    expect(row('desk@example.test')).toBeTruthy();

    type('alias-add-input', 'shop@example.test');
    fireEvent.click(screen.getByTestId('alias-add-btn'));
    expect(store().aliases.studio.map(a => a.address)).toEqual(['desk@example.test', 'shop@example.test']);
  });

  it('keeps Add disabled until something is typed', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(screen.getByTestId('alias-add-btn').disabled).toBe(true);
    type('alias-add-input', 'a');
    expect(screen.getByTestId('alias-add-btn').disabled).toBe(false);
  });
});

describe('an alias row', () => {
  beforeEach(() => seed([
    { address: 'desk@example.test', name: 'Desk', source: 'manual' },
    { address: 'shop@example.test', name: '', source: 'detected' },
  ]));

  it('saves a name when the field loses focus', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const name = within(row('desk@example.test')).getByTestId('alias-name-input');
    fireEvent.change(name, { target: { value: 'Front Desk ' } });
    fireEvent.blur(name);
    expect(store().aliases.studio[0].name).toBe('Front Desk');
    // The trailing space the user is still typing stays in the field.
    expect(name.value).toBe('Front Desk ');
  });

  it('saves a name on its own a moment after typing stops', async () => {
    vi.useFakeTimers();
    render(<AliasesSection account={ACCOUNT} />);
    await act(async () => {});
    const name = within(row('shop@example.test')).getByTestId('alias-name-input');
    fireEvent.change(name, { target: { value: 'The Shop' } });
    expect(store().aliases.studio[1].name).toBe('');
    act(() => { vi.advanceTimersByTime(400); });
    expect(store().aliases.studio[1].name).toBe('The Shop');
  });

  it('saves a pending name when the section closes', async () => {
    const { unmount } = render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.change(within(row('shop@example.test')).getByTestId('alias-name-input'), { target: { value: 'Shop' } });
    unmount();
    expect(store().aliases.studio[1].name).toBe('Shop');
  });

  it('makes an alias the default From, and the login row takes it back', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const radio = address => within(row(address)).getByTestId('alias-default-radio');
    expect(radio('studio@example.test').checked).toBe(true);
    fireEvent.click(radio('desk@example.test'));
    expect(store().sendAsAddresses.studio).toBe('desk@example.test');
    expect(radio('desk@example.test').checked).toBe(true);
    expect(radio('studio@example.test').checked).toBe(false);
    fireEvent.click(radio('studio@example.test'));
    expect(store().sendAsAddresses.studio).toBe('');
    expect(radio('studio@example.test').checked).toBe(true);
  });

  it('names each default choice by its address for assistive tech', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(screen.getByRole('radio', { name: t('settings.accounts.aliases.useByDefaultFor', { address: 'desk@example.test' }) })).toBeTruthy();
    expect(screen.getByRole('group', { name: t('settings.accounts.aliases.defaultAddress') })).toBeTruthy();
  });

  it('removes an alias for good, and a default that pointed at it falls back to the login', async () => {
    useSettingsStore.setState({ sendAsAddresses: { studio: 'desk@example.test' } });
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.click(within(row('desk@example.test')).getByTestId('alias-remove-btn'));
    expect(store().aliases.studio.map(a => a.address)).toEqual(['shop@example.test']);
    expect(store().dismissedAliases.studio).toEqual(['desk@example.test']);
    expect(store().sendAsAddresses.studio).toBe('');
    expect(row('desk@example.test')).toBeUndefined();
  });

  it('verifies an alias by sending under its own name, else the account name', async () => {
    render(<AliasesSection account={ACCOUNT} displayName="Studio Team" />);
    await settle();
    fireEvent.click(within(row('desk@example.test')).getByTestId('alias-verify-btn'));
    let modal = screen.getByTestId('send-as-verify-modal');
    expect(modal.getAttribute('data-address')).toBe('desk@example.test');
    expect(modal.getAttribute('data-name')).toBe('Desk');
    fireEvent.click(within(modal).getByRole('button'));
    expect(screen.queryByTestId('send-as-verify-modal')).toBeNull();
    fireEvent.click(within(row('shop@example.test')).getByTestId('alias-verify-btn'));
    modal = screen.getByTestId('send-as-verify-modal');
    expect(modal.getAttribute('data-name')).toBe('Studio Team');
  });
});

describe('looking for aliases', () => {
  function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  }

  it('looks once when the section opens, with a spinner and the button disabled', async () => {
    const lookup = deferred();
    refreshAliases.mockReturnValue(lookup.promise);
    render(<AliasesSection account={ACCOUNT} />);
    expect(refreshAliases).toHaveBeenCalledTimes(1);
    expect(refreshAliases).toHaveBeenCalledWith(ACCOUNT);
    const button = screen.getByTestId('aliases-refresh-btn');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('aliases-status').getAttribute('data-status')).toBe('running');
    await act(async () => { lookup.resolve(NOTHING); });
    expect(screen.getByTestId('aliases-refresh-btn').disabled).toBe(false);
    expect(screen.getByTestId('aliases-status').getAttribute('aria-live')).toBe('polite');
  });

  it('does not look again on reopening in the same session, and shows the last answer', async () => {
    refreshAliases.mockResolvedValue({ ...NOTHING, providerStatus: 'denied' });
    const { unmount } = render(<AliasesSection account={GMAIL} />);
    await settle();
    unmount();
    render(<AliasesSection account={GMAIL} />);
    await settle();
    expect(refreshAliases).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('aliases-status').textContent).toBe(t('settings.accounts.aliases.status.denied'));
  });

  it('looks again when asked', async () => {
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    fireEvent.click(screen.getByTestId('aliases-refresh-btn'));
    await settle();
    expect(refreshAliases).toHaveBeenCalledTimes(2);
  });

  it.each(['ok', 'unsupported', 'denied', 'error'])('explains the provider answering %s', async status => {
    refreshAliases.mockResolvedValue({ ...NOTHING, providerStatus: status });
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const line = screen.getByTestId('aliases-status');
    expect(line.getAttribute('data-status')).toBe(status);
    expect(line.textContent).toBe(t(`settings.accounts.aliases.status.${status}`));
  });

  it('offers the addresses mail arrives at, and adds one in a click', async () => {
    refreshAliases.mockResolvedValue({
      ...NOTHING,
      suggestions: [
        { address: 'bookings@example.test', name: 'Bookings', count: 4, source: 'delivered_to' },
        { address: 'info@example.test', name: '', count: 1, source: 'delivered_to' },
      ],
    });
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    const box = screen.getByTestId('aliases-suggestions');
    expect(within(box).getByText(t('settings.accounts.aliases.suggestionsTitle'))).toBeTruthy();
    const chips = within(box).getAllByTestId('alias-suggestion-add');
    expect(chips.map(c => c.getAttribute('data-address'))).toEqual(['bookings@example.test', 'info@example.test']);
    // Nothing is kept until it is added.
    expect(store().aliases.studio).toBeUndefined();
    fireEvent.click(chips[0]);
    expect(store().aliases.studio).toEqual([{ address: 'bookings@example.test', name: 'Bookings', source: 'detected' }]);
    expect(within(screen.getByTestId('aliases-suggestions')).getAllByTestId('alias-suggestion-add')
      .map(c => c.getAttribute('data-address'))).toEqual(['info@example.test']);
    fireEvent.click(screen.getByTestId('alias-suggestion-add'));
    await waitFor(() => expect(screen.queryByTestId('aliases-suggestions')).toBeNull());
  });

  it('shows what a lookup added without asking again', async () => {
    refreshAliases.mockImplementation(async () => {
      store().addAlias('studio', { address: 'found@example.test', source: 'provider' }, ACCOUNT.email);
      return { ...NOTHING, providerStatus: 'ok' };
    });
    render(<AliasesSection account={ACCOUNT} />);
    await settle();
    expect(row('found@example.test')).toBeTruthy();
  });

  it('ignores a late answer for the account the user has left', async () => {
    const lookup = deferred();
    refreshAliases.mockReturnValueOnce(lookup.promise).mockResolvedValue({ ...NOTHING, providerStatus: 'ok' });
    const { rerender } = render(<AliasesSection account={ACCOUNT} />);
    rerender(<AliasesSection account={GMAIL} />);
    await settle();
    expect(screen.getByTestId('aliases-status').getAttribute('data-status')).toBe('ok');
    await act(async () => { lookup.resolve({ ...NOTHING, providerStatus: 'error', suggestions: [{ address: 'x@example.test', name: '', count: 1, source: 'delivered_to' }] }); });
    expect(screen.getByTestId('aliases-status').getAttribute('data-status')).toBe('ok');
    expect(screen.queryByTestId('aliases-suggestions')).toBeNull();
  });
});
