// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';

vi.mock('../../services/daemonClient', () => ({ daemonCall: vi.fn() }));

const { daemonCall } = await import('../../services/daemonClient');
const { ContactsPickerButton, ContactsAutocomplete } = await import('../ContactsPicker');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useMailStore } = await import('../../stores/mailStore');
const { usePrivacyStore } = await import('../../stores/privacyStore');

const ANNA = { address: 'anna@x.io', name: 'Anna Smith', count: 3, lastSeen: 3, accountIds: ['a1'] };
const LEE = { address: 'ann.lee@y.io', name: 'Doe, Lee', count: 7, lastSeen: 2, accountIds: ['a1', 'a2'] };

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(daemonCall).mockReset();
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false });
  useSettingsStore.setState({ sendAsAddresses: {}, aliases: { a1: [{ address: 'desk@h.io' }] } });
  useMailStore.setState({ activeAccountId: 'a1', accounts: [{ id: 'a1', email: 'me@h.io' }, { id: 'a2', email: 'me@work.io' }] });
});

describe('ContactsPickerButton', () => {
  it('lists the daemon\'s contacts for the From account and appends the one picked', async () => {
    vi.mocked(daemonCall).mockResolvedValue({ latest: [ANNA, LEE], popular: [LEE, ANNA] });
    const onChange = vi.fn();
    render(<ContactsPickerButton value="" onChange={onChange} fieldName="To:" boostAccountId="a2" />);
    expect(daemonCall).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(daemonCall).toHaveBeenCalledWith('people.contacts.top', {
      accountIds: ['a1', 'a2'], ownAddresses: ['me@h.io', 'desk@h.io', 'me@work.io'], accountId: 'a2', limit: 50,
    });
    fireEvent.click(screen.getByText('Doe, Lee'));
    expect(onChange).toHaveBeenCalledWith('"Doe, Lee" <ann.lee@y.io>, ');
  });

  it('shows the empty state when the daemon fails', async () => {
    vi.mocked(daemonCall).mockRejectedValue(new Error('offline'));
    render(<ContactsPickerButton value="" onChange={vi.fn()} fieldName="To:" />);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.queryByText('Anna Smith')).toBeNull();
    expect(document.querySelectorAll('button').length).toBeGreaterThan(1);
  });
});

function Field({ value, onChange }) {
  const ref = useRef(null);
  return (
    <div>
      <input ref={ref} data-testid="to" value={value} onChange={() => {}} />
      <ContactsAutocomplete value={value} onChange={onChange} inputRef={ref} />
    </div>
  );
}

describe('ContactsAutocomplete', () => {
  it('asks the daemon for the trailing token, boosted to the active account', async () => {
    vi.mocked(daemonCall).mockResolvedValue([ANNA]);
    const onChange = vi.fn();
    render(<Field value="bob@b.io, an" onChange={onChange} />);
    await act(async () => { screen.getByTestId('to').focus(); });
    expect(daemonCall).toHaveBeenLastCalledWith('people.contacts.search', {
      accountIds: ['a1', 'a2'], ownAddresses: ['me@h.io', 'desk@h.io', 'me@work.io'], query: 'an', boostAccountId: 'a1', limit: 6,
    });
    fireEvent.mouseDown(screen.getByText('Anna Smith'));
    expect(onChange).toHaveBeenCalledWith('bob@b.io, Anna Smith <anna@x.io>, ');
  });

  it('a late answer to an older query never replaces the newer one', async () => {
    const pending = [];
    vi.mocked(daemonCall).mockImplementation((method, params) => new Promise(resolve => pending.push({ params, resolve })));
    const { rerender } = render(<Field value="a" onChange={vi.fn()} />);
    await act(async () => { screen.getByTestId('to').focus(); });
    rerender(<Field value="an" onChange={vi.fn()} />);
    await act(async () => {});
    expect(pending.map(p => p.params.query)).toEqual(['a', 'an']);
    await act(async () => { pending[1].resolve([LEE]); });
    await act(async () => { pending[0].resolve([ANNA]); });
    expect(screen.getByText('Doe, Lee')).toBeTruthy();
    expect(screen.queryByText('Anna Smith')).toBeNull();
  });

  it('asks nothing while the field is not focused or empty', async () => {
    render(<Field value="an" onChange={vi.fn()} />);
    await act(async () => {});
    expect(daemonCall).not.toHaveBeenCalled();
  });
});
