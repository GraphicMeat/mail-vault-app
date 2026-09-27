// @vitest-environment jsdom
//
// The search box understands Gmail-style operators; nothing in the app said
// so. The help lists exactly what the parser takes, an example goes into the
// box, a one-time tip points at the help, and a recent search comes back with
// its operators.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SEARCH_OPERATORS } from '../../utils/searchQuery';

const harness = vi.hoisted(() => ({
  mailState: null,
  settingsState: null,
  runs: [],
  startMailSearch: vi.fn(),
}));

vi.mock('lucide-react', () => {
  const icon = name => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_target, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))), has: () => true });
});
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) => React.createElement('div', { ...props, ref }, children)),
  }),
}));
vi.mock('../../stores/mailStore', () => {
  const useMailStore = selector => selector(harness.mailState);
  useMailStore.getState = () => harness.mailState;
  return { useMailStore };
});
vi.mock('../../stores/accountStore', () => ({ useAccountStore: selector => selector(harness.mailState) }));
vi.mock('../../stores/settingsStore', () => {
  const useSettingsStore = selector => (selector ? selector(harness.settingsState) : harness.settingsState);
  useSettingsStore.getState = () => harness.settingsState;
  return {
    useSettingsStore,
    hasPremiumAccess: () => false,
    effectiveSearchMailboxConcurrency: () => 1,
  };
});
vi.mock('../../services/mailSearch.js', () => ({
  startMailSearch: (...args) => harness.startMailSearch(...args),
  cancelMailSearch: vi.fn(async () => {}),
}));
vi.mock('../../services/searchTargets.js', () => ({
  buildSearchTargets: async () => [{ accountId: 'a', localMailboxes: null, serverMailboxes: ['INBOX'] }],
}));

const { SearchBar } = await import('../SearchBar.jsx');
const { useSearchStore } = await import('../../stores/searchStore.js');

const input = () => screen.getByTestId('mail-search-input');
const helpButton = () => screen.getByRole('button', { name: 'Search operators' });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

beforeEach(() => {
  useSearchStore.getState().clearSearch();
  harness.mailState = {
    activeAccountId: 'a', activeMailbox: 'INBOX', unifiedInbox: false, unifiedFolder: 'INBOX',
    accounts: [{ id: 'a', password: 'secret' }], mailboxes: [],
    savedEmailIds: new Set(), backedUpKeys: new Set(), backedUpScopes: new Set(), backupConfigured: false,
  };
  harness.settingsState = {
    billingProfile: null, searchMailboxConcurrency: 1, searchHistory: [], filterHistoryPeriodDays: 30,
    removeSearchFromHistory: vi.fn(), clearSearchHistory: vi.fn(), addFilterUsage: vi.fn(),
    getPopularFilters: () => [], addSearchToHistory: vi.fn(),
    searchOperatorsHintSeen: true, markSearchOperatorsHintSeen: vi.fn(),
  };
  harness.runs = [];
  harness.startMailSearch.mockReset().mockImplementation(async (request, onProgress) => {
    harness.runs.push({ request, onProgress });
    return { unlisten: vi.fn() };
  });
});
afterEach(() => {
  cleanup();
  useSearchStore.getState().clearSearch();
});

describe('search operator help', () => {
  it('lists every operator the parser supports, with its example', () => {
    render(<SearchBar />);
    fireEvent.click(helpButton());

    const panel = screen.getByRole('dialog', { name: 'Search operators' });
    for (const { syntax, example } of SEARCH_OPERATORS) {
      expect(within(panel).getByText(syntax)).toBeTruthy();
      expect(within(panel).getByRole('button', { name: example })).toBeTruthy();
    }
  });

  it('adds a clicked example to the query and focuses the box', () => {
    render(<SearchBar />);
    fireEvent.change(input(), { target: { value: 'invoice' } });
    fireEvent.click(helpButton());
    fireEvent.click(screen.getByRole('button', { name: 'has:attachment' }));

    expect(input().value).toBe('invoice has:attachment');
    expect(document.activeElement).toBe(input());
    expect(screen.queryByRole('dialog', { name: 'Search operators' })).toBeNull();

    fireEvent.click(helpButton());
    fireEvent.click(screen.getByRole('button', { name: 'is:unread' }));
    expect(input().value).toBe('invoice has:attachment is:unread');
  });

  it('closes on Escape and gives focus back to the help button', () => {
    render(<SearchBar />);
    fireEvent.click(helpButton());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Search operators' })).toBeNull();
    expect(document.activeElement).toBe(helpButton());
  });
});

describe('search operator tip', () => {
  it('shows on focus until dismissed, and the dismissal persists', () => {
    harness.settingsState.searchOperatorsHintSeen = false;
    const view = render(<SearchBar />);
    fireEvent.focus(input());
    const hint = screen.getByTestId('search-operators-hint');
    expect(hint.textContent).toContain('from:');

    fireEvent.click(within(hint).getByRole('button', { name: 'Dismiss tip' }));
    expect(harness.settingsState.markSearchOperatorsHintSeen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('search-operators-hint')).toBeNull();

    harness.settingsState.searchOperatorsHintSeen = true;
    view.unmount();
    render(<SearchBar />);
    fireEvent.focus(input());
    expect(screen.queryByTestId('search-operators-hint')).toBeNull();
  });

  it('is never shown once the help was opened', () => {
    harness.settingsState.searchOperatorsHintSeen = false;
    render(<SearchBar />);
    fireEvent.focus(input());
    expect(screen.getByTestId('search-operators-hint')).toBeTruthy();

    fireEvent.click(helpButton());
    expect(harness.settingsState.markSearchOperatorsHintSeen).toHaveBeenCalled();
    expect(screen.queryByTestId('search-operators-hint')).toBeNull();
  });

  it('does not show when already seen', () => {
    render(<SearchBar />);
    fireEvent.focus(input());
    expect(screen.queryByTestId('search-operators-hint')).toBeNull();
  });
});

describe('recent searches with operators', () => {
  it('saves the raw query when the search is submitted', async () => {
    render(<SearchBar />);
    fireEvent.change(input(), { target: { value: '  from:x has:attachment ' } });
    fireEvent.submit(input().closest('form'));
    await flush();

    expect(harness.settingsState.addSearchToHistory).toHaveBeenCalledWith('from:x has:attachment');
  });

  it('re-runs a recent search with its operators intact', async () => {
    harness.settingsState.searchHistory = ['from:x has:attachment'];
    render(<SearchBar />);
    fireEvent.focus(input());
    fireEvent.click(screen.getByText('from:x has:attachment'));
    await flush();
    await flush();

    expect(input().value).toBe('from:x has:attachment');
    expect(harness.runs.at(-1).request).toMatchObject({ query: '', sender: 'x', hasAttachments: true });
  });
});
