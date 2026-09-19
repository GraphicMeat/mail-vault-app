// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const harness = vi.hoisted(() => ({
  mailState: null,
  settingsState: null,
  cachedMailboxes: {},
  runs: [],
  startMailSearch: vi.fn(),
  cancelMailSearch: vi.fn(),
  ensureFreshToken: vi.fn(async account => account),
  hasValidCredentials: vi.fn(account => !!(account?.password || account?.oauth2AccessToken)),
  getAccountCacheMailboxes: vi.fn(accountId => harness.cachedMailboxes[accountId] || null),
}));

vi.mock('lucide-react', () => {
  const icon = name => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_target, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))), has: () => true });
});
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) => React.createElement('div', { ...props, ref }, children)),
  }),
}));
vi.mock('../../stores/mailStore', () => {
  const useMailStore = selector => selector(harness.mailState);
  useMailStore.getState = () => harness.mailState;
  return { useMailStore };
});
vi.mock('../../stores/accountStore', () => ({ useAccountStore: selector => selector(harness.mailState) }));
vi.mock('../../stores/settingsStore', () => {
  const hasPremiumAccess = profile => !!(profile?.hasSubscription && profile.premiumAccess);
  const useSettingsStore = selector => (selector ? selector(harness.settingsState) : harness.settingsState);
  useSettingsStore.getState = () => harness.settingsState;
  return {
    useSettingsStore,
    hasPremiumAccess,
    effectiveSearchMailboxConcurrency: state => (hasPremiumAccess(state?.billingProfile)
      ? Math.max(1, Math.min(5, Number(state.searchMailboxConcurrency) || 3))
      : 1),
  };
});
vi.mock('../../services/mailSearch.js', () => ({
  startMailSearch: (...args) => harness.startMailSearch(...args),
  cancelMailSearch: (...args) => harness.cancelMailSearch(...args),
}));
vi.mock('../../services/authUtils.js', () => ({
  ensureFreshToken: (...args) => harness.ensureFreshToken(...args),
  hasValidCredentials: (...args) => harness.hasValidCredentials(...args),
}));
vi.mock('../../services/cacheManager.js', () => ({
  getAccountCacheMailboxes: (...args) => harness.getAccountCacheMailboxes(...args),
}));

const { SearchBar } = await import('../SearchBar.jsx');
const { useSearchStore } = await import('../../stores/searchStore.js');

const box = path => ({ path, name: path, delimiter: '.', children: [] });
const premium = () => ({ hasSubscription: true, premiumAccess: true });
const row = (uid, subject, accountId, mailbox) => ({
  uid, subject, _accountId: accountId, _mailbox: mailbox, source: 'server-search',
  from: { address: 'sender@example.test' }, date: '2026-09-19T12:00:00Z',
});
const emit = (run, sequence, rows = []) => run.onProgress({
  searchId: run.request.searchId, sequence, lane: 'local', rows, completed: 0, total: 1,
  localMode: null, fallbackReason: null, coverage: null, failures: [], terminal: null, errorKey: null,
});
const startCurrent = async () => {
  useSearchStore.setState({
    searchQuery: 'invoice',
    searchFilters: { location: 'all', folder: 'current', sender: '', dateFrom: null, dateTo: null, hasAttachments: false },
  });
  await useSearchStore.getState().performSearch();
};

beforeEach(() => {
  useSearchStore.getState().clearSearch();
  harness.mailState = {
    activeAccountId: 'a', activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'INBOX',
    accounts: [
      { id: 'a', password: 'secret' },
      { id: 'b', password: 'secret' },
    ],
    mailboxes: [box('INBOX')],
    savedEmailIds: new Set(), backedUpKeys: new Set(), backedUpScopes: new Set(), backupConfigured: false,
    requestSettingsTab: vi.fn(),
  };
  harness.cachedMailboxes = { b: [box('INBOX'), box('Archive')] };
  harness.getAccountCacheMailboxes.mockImplementation(accountId => harness.cachedMailboxes[accountId] || null);
  harness.settingsState = {
    billingProfile: premium(), searchMailboxConcurrency: 3, searchHistory: [], filterHistoryPeriodDays: 30,
    removeSearchFromHistory: vi.fn(), clearSearchHistory: vi.fn(), addFilterUsage: vi.fn(),
    getPopularFilters: () => [], addSearchToHistory: vi.fn(),
  };
  harness.runs = [];
  harness.startMailSearch.mockReset().mockImplementation(async (request, onProgress) => {
    const run = { request, onProgress, unlisten: vi.fn() };
    harness.runs.push(run);
    return { unlisten: run.unlisten };
  });
  harness.cancelMailSearch.mockReset().mockResolvedValue(undefined);
  harness.ensureFreshToken.mockReset().mockImplementation(async account => account);
  harness.hasValidCredentials.mockReset().mockImplementation(account => !!(account?.password || account?.oauth2AccessToken));
  useSearchStore.setState({
    searchQuery: '', searchFilters: { location: 'all', folder: 'current', sender: '', dateFrom: null, dateTo: null, hasAttachments: false },
    searchActive: false, searchResults: [], isSearching: false, searchProgress: null, searchIndexCoverage: null,
    searchFallback: null, searchError: null, activeSearchId: null, searchGeneration: 0, lastSequence: 0, searchSnapshot: null,
  });
});
afterEach(() => {
  cleanup();
  useSearchStore.getState().clearSearch();
});

describe('SearchBar search lifecycle', () => {
  it('restarts a current search from All Inboxes into the active account mailbox', async () => {
    const view = render(<SearchBar />);
    await act(async () => { await startCurrent(); });
    expect(harness.runs).toHaveLength(1);
    emit(harness.runs[0], 1, [row(1, 'old unified row', 'a', 'INBOX')]);
    expect(useSearchStore.getState().searchResults.map(email => email.subject)).toEqual(['old unified row']);
    const oldId = harness.runs[0].request.searchId;

    harness.mailState = {
      ...harness.mailState,
      activeAccountId: 'b', activeMailbox: 'Archive', unifiedInbox: false,
      mailboxes: [box('Archive')],
    };
    view.rerender(<SearchBar />);

    await waitFor(() => expect(harness.runs).toHaveLength(2));
    expect(harness.cancelMailSearch).toHaveBeenCalledWith(oldId);
    expect(harness.runs[1].request.targets.map(target => [target.accountId, target.localMailboxes, target.serverMailboxes])).toEqual([
      ['b', ['Archive'], ['Archive']],
    ]);
    emit(harness.runs[0], 2, [row(2, 'late unified row', 'a', 'INBOX')]);
    expect(useSearchStore.getState().searchResults).toEqual([]);
  });

  it('restarts with the effective entitlement limit and preserves the saved Premium value', async () => {
    const view = render(<SearchBar />);
    await act(async () => { await startCurrent(); });
    expect(harness.runs[0].request.concurrency).toBe(3);

    harness.settingsState = { ...harness.settingsState, searchMailboxConcurrency: 5 };
    view.rerender(<SearchBar />);
    await waitFor(() => expect(harness.runs).toHaveLength(2));
    expect(harness.runs[1].request.concurrency).toBe(5);

    harness.settingsState = { ...harness.settingsState, billingProfile: null };
    view.rerender(<SearchBar />);
    await waitFor(() => expect(harness.runs).toHaveLength(3));
    expect(harness.runs[2].request.concurrency).toBe(1);
    expect(harness.settingsState.searchMailboxConcurrency).toBe(5);

    harness.settingsState = { ...harness.settingsState, billingProfile: premium() };
    view.rerender(<SearchBar />);
    await waitFor(() => expect(harness.runs).toHaveLength(4));
    expect(harness.runs[3].request.concurrency).toBe(5);
  });

  it('restarts when entitlement changes even if both effective limits are one', async () => {
    harness.settingsState = { ...harness.settingsState, billingProfile: null, searchMailboxConcurrency: 1 };
    const view = render(<SearchBar />);
    await act(async () => { await startCurrent(); });
    expect(harness.runs[0].request.concurrency).toBe(1);

    harness.settingsState = { ...harness.settingsState, billingProfile: premium() };
    view.rerender(<SearchBar />);
    await waitFor(() => expect(harness.runs).toHaveLength(2));
    expect(harness.runs[1].request.concurrency).toBe(1);
    expect(harness.cancelMailSearch).toHaveBeenCalledWith(harness.runs[0].request.searchId);
  });

  it('does not restart an explicit all-folders search for a same-account mailbox switch', async () => {
    harness.mailState = {
      ...harness.mailState,
      unifiedInbox: false, activeMailbox: 'INBOX', mailboxes: [box('INBOX'), box('Archive')],
    };
    const view = render(<SearchBar />);
    useSearchStore.setState({
      searchQuery: 'invoice',
      searchFilters: { location: 'all', folder: 'all', sender: '', dateFrom: null, dateTo: null, hasAttachments: false },
    });
    await act(async () => { await useSearchStore.getState().performSearch(); });
    expect(harness.runs).toHaveLength(1);

    harness.mailState = { ...harness.mailState, activeMailbox: 'Archive' };
    view.rerender(<SearchBar />);
    await act(async () => { await Promise.resolve(); });

    expect(harness.runs).toHaveLength(1);
    expect(harness.cancelMailSearch).not.toHaveBeenCalled();
  });

  it('opens the index settings and offers the Premium speed-up only to free users', () => {
    harness.settingsState = { ...harness.settingsState, billingProfile: null, searchMailboxConcurrency: 5 };
    harness.mailState.requestSettingsTab = vi.fn();
    const view = render(<SearchBar />);
    act(() => useSearchStore.setState({ searchActive: true, searchFallback: 'unavailable' }));

    const openIndex = document.querySelector('[data-testid="search-fallback-index"]');
    const upgrade = document.querySelector('[data-testid="search-fallback-upgrade"]');
    expect(openIndex).not.toBeNull();
    expect(upgrade).not.toBeNull();
    fireEvent.click(openIndex);
    fireEvent.click(upgrade);
    expect(harness.mailState.requestSettingsTab).toHaveBeenNthCalledWith(1, 'storage');
    expect(harness.mailState.requestSettingsTab).toHaveBeenNthCalledWith(2, 'billing');

    harness.settingsState = { ...harness.settingsState, billingProfile: premium() };
    view.rerender(<SearchBar />);
    act(() => useSearchStore.setState({ searchFallback: 'building' }));
    expect(document.querySelector('[data-testid="search-fallback-upgrade"]')).toBeNull();
  });
});
