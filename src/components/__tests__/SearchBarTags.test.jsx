// @vitest-environment jsdom
//
// The search box holds its query as tags: typed words, operators and recent
// searches each become one, a tag can be removed or edited in place, `/`
// lists the operators, and the index suggests senders and words under the
// recent searches. The store still gets one string.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SEARCH_OPERATORS } from '../../utils/searchQuery';

const harness = vi.hoisted(() => ({
  mailState: null,
  settingsState: null,
  runs: [],
  startMailSearch: vi.fn(),
  suggest: vi.fn(),
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
vi.mock('../../services/searchSuggestions.js', () => ({
  fetchSearchSuggestions: (...args) => harness.suggest(...args),
}));

const { SearchBar } = await import('../SearchBar.jsx');
const { useSearchStore } = await import('../../stores/searchStore.js');

const input = () => screen.getByTestId('mail-search-input');
const tagTexts = () => screen.queryAllByTestId('search-tag-text').map(node => node.textContent);
const type = (text, target = input()) => fireEvent.change(target, { target: { value: text } });
const press = (key, target = input()) => fireEvent.keyDown(target, { key });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const commit = (...words) => { for (const word of words) { type(word); press('Enter'); } };

beforeEach(() => {
  useSearchStore.getState().clearSearch();
  harness.mailState = {
    activeAccountId: 'a', activeMailbox: 'INBOX', unifiedInbox: false, unifiedFolder: 'INBOX',
    accounts: [{ id: 'a', password: 'secret' }, { id: 'b', password: 'secret' }], mailboxes: [],
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
  harness.suggest.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  useSearchStore.getState().clearSearch();
});

describe('committing tags', () => {
  it('turns typed text into a tag on Enter, and searches again on Enter in an empty box', async () => {
    render(<SearchBar />);
    commit('invoice', 'from:ann');
    expect(tagTexts()).toEqual(['invoice', 'from:ann']);
    expect(input().value).toBe('');

    press('Enter');
    await flush();
    await flush();
    expect(useSearchStore.getState().searchQuery).toBe('invoice from:ann');
    expect(harness.runs.at(-1).request).toMatchObject({ query: 'invoice', sender: 'ann' });
    expect(harness.settingsState.addSearchToHistory).toHaveBeenCalledWith('invoice from:ann');
  });

  it('keeps one tag for the same term typed twice', () => {
    render(<SearchBar />);
    commit('Invoice', 'invoice');
    expect(tagTexts()).toEqual(['Invoice']);
  });

  it('folds text not yet committed into the search the button runs', async () => {
    render(<SearchBar />);
    commit('invoice');
    type('q3');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await flush();
    expect(useSearchStore.getState().searchQuery).toBe('invoice q3');
    expect(tagTexts()).toEqual(['invoice', 'q3']);
  });

  it('clears every tag and the search with the clear button', async () => {
    render(<SearchBar />);
    commit('invoice');
    press('Enter');
    await flush();
    fireEvent.click(screen.getByTestId('search-clear'));
    expect(tagTexts()).toEqual([]);
    expect(useSearchStore.getState().searchQuery).toBe('');
    expect(useSearchStore.getState().searchActive).toBe(false);
  });
});

describe('searching as the tags change', () => {
  const lastRun = () => harness.runs.at(-1)?.request;

  it('runs the search as soon as a tag is committed, without a second Enter', async () => {
    render(<SearchBar />);
    commit('invoice');
    await flush();
    await flush();
    expect(useSearchStore.getState().searchQuery).toBe('invoice');
    expect(lastRun()).toMatchObject({ query: 'invoice' });

    commit('from:ann');
    await flush();
    await flush();
    expect(lastRun()).toMatchObject({ query: 'invoice', sender: 'ann' });
  });

  it('runs again when a tag is removed or edited, leaving the text being typed out of it', async () => {
    render(<SearchBar />);
    commit('a', 'b');
    await flush();
    await flush();
    type('half');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
    await flush();
    await flush();
    expect(useSearchStore.getState().searchQuery).toBe('b');
    expect(lastRun()).toMatchObject({ query: 'b' });
    expect(input().value).toBe('half');

    fireEvent.click(screen.getByRole('button', { name: 'Edit b' }));
    type('c', screen.getByTestId('search-tag-edit'));
    press('Enter', screen.getByTestId('search-tag-edit'));
    await flush();
    await flush();
    expect(lastRun()).toMatchObject({ query: 'c' });
  });

  it('ends the search when the last tag goes, keeping the filters', async () => {
    render(<SearchBar />);
    useSearchStore.getState().setSearchFilters({ hasAttachments: true });
    commit('a');
    await flush();
    await flush();
    const runs = harness.runs.length;
    fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
    await flush();
    await flush();
    expect(useSearchStore.getState().searchQuery).toBe('');
    expect(useSearchStore.getState().searchFilters.hasAttachments).toBe(true);
    expect(harness.runs.length).toBe(runs + 1);
    expect(lastRun()).toMatchObject({ query: '' });
  });

  it('does not run for a change that leaves the tags as they were', async () => {
    render(<SearchBar />);
    commit('a');
    await flush();
    await flush();
    const runs = harness.runs.length;
    commit('A');
    fireEvent.click(screen.getByRole('button', { name: 'Edit a' }));
    press('Escape', screen.getByTestId('search-tag-edit'));
    await flush();
    await flush();
    expect(harness.runs.length).toBe(runs);
  });
});

describe('typing through an input method', () => {
  // Japanese, Korean and Chinese input confirm a candidate with Enter while
  // composing; that Enter picks the word, it must not commit a tag or search.
  it('ignores Enter and Backspace while a word is still being composed', () => {
    render(<SearchBar />);
    commit('a');
    type('にほん');
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    expect(tagTexts()).toEqual(['a']);
    expect(input().value).toBe('にほん');

    type('');
    fireEvent.keyDown(input(), { key: 'Backspace', isComposing: true });
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Edit a' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit a' }));
    const edit = screen.getByTestId('search-tag-edit');
    type('にほん', edit);
    fireEvent.keyDown(edit, { key: 'Enter', isComposing: true });
    expect(screen.getByTestId('search-tag-edit')).toBe(edit);
  });
});

describe('removing and editing a tag', () => {
  it('removes a tag at once with its x', () => {
    render(<SearchBar />);
    commit('a', 'b');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
    expect(tagTexts()).toEqual(['b']);
  });

  it('edits a tag in place: Enter commits, Escape cancels, blur commits, empty removes', () => {
    render(<SearchBar />);
    commit('a', 'b');

    fireEvent.click(screen.getByRole('button', { name: 'Edit b' }));
    const edit = screen.getByTestId('search-tag-edit');
    expect(edit.value).toBe('b');
    expect(document.activeElement).toBe(edit);
    type('c', edit);
    press('Enter', edit);
    expect(tagTexts()).toEqual(['a', 'c']);
    expect(document.activeElement).toBe(input());

    fireEvent.click(screen.getByRole('button', { name: 'Edit c' }));
    type('zzz', screen.getByTestId('search-tag-edit'));
    press('Escape', screen.getByTestId('search-tag-edit'));
    expect(tagTexts()).toEqual(['a', 'c']);

    fireEvent.click(screen.getByRole('button', { name: 'Edit a' }));
    type('first', screen.getByTestId('search-tag-edit'));
    fireEvent.blur(screen.getByTestId('search-tag-edit'));
    expect(tagTexts()).toEqual(['first', 'c']);

    fireEvent.click(screen.getByRole('button', { name: 'Edit c' }));
    type('  ', screen.getByTestId('search-tag-edit'));
    press('Enter', screen.getByTestId('search-tag-edit'));
    expect(tagTexts()).toEqual(['first']);
  });

  it('edits an operator tag by its value and quotes a value with spaces', async () => {
    render(<SearchBar />);
    commit('from:ann');
    fireEvent.click(screen.getByRole('button', { name: 'Edit from:ann' }));
    const edit = screen.getByTestId('search-tag-edit');
    expect(edit.value).toBe('ann');
    type('Ann Lee', edit);
    press('Enter', edit);
    expect(tagTexts()).toEqual(['from:Ann Lee']);

    press('Enter');
    await flush();
    expect(useSearchStore.getState().searchQuery).toBe('from:"Ann Lee"');
  });
});

describe('the keyboard', () => {
  it('Backspace in an empty box selects the last tag first, and a second Backspace removes it', () => {
    render(<SearchBar />);
    commit('a', 'b');
    press('Backspace');
    expect(tagTexts()).toEqual(['a', 'b']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit b' }));

    press('Backspace', document.activeElement);
    expect(tagTexts()).toEqual(['a']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit a' }));
  });

  it('arrows move between the tags and back to the box', () => {
    render(<SearchBar />);
    commit('a', 'b');
    press('ArrowLeft');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit b' }));
    press('ArrowLeft', document.activeElement);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit a' }));
    press('ArrowRight', document.activeElement);
    press('ArrowRight', document.activeElement);
    expect(document.activeElement).toBe(input());
  });
});

describe('the / operator list', () => {
  const menu = () => screen.queryByRole('listbox', { name: 'Search operators' });

  it('lists every operator on /, narrowed by what follows', () => {
    render(<SearchBar />);
    fireEvent.focus(input());
    type('/');
    expect(within(menu()).getAllByRole('option').map(option => option.dataset.operator))
      .toEqual(SEARCH_OPERATORS.map(op => op.id));
    type('/fr');
    expect(within(menu()).getAllByRole('option').map(option => option.dataset.operator)).toEqual(['from']);
  });

  it('inserts an operator that waits for its value, then commits it on Enter', () => {
    render(<SearchBar />);
    fireEvent.focus(input());
    type('/fr');
    press('Enter');
    expect(menu()).toBeNull();
    const edit = screen.getByTestId('search-tag-edit');
    expect(document.activeElement).toBe(edit);
    type('alice', edit);
    press('Enter', edit);
    expect(tagTexts()).toEqual(['from:alice']);
    expect(input().value).toBe('');
  });

  it('inserts a whole operator at once, keeping the words typed before the slash', () => {
    render(<SearchBar />);
    fireEvent.focus(input());
    type('invoice /');
    const hasIndex = SEARCH_OPERATORS.findIndex(op => op.id === 'hasAttachment');
    for (let i = 0; i < hasIndex; i += 1) press('ArrowDown');
    press('Enter');
    expect(tagTexts()).toEqual(['invoice', 'has:attachment']);
    expect(screen.queryByTestId('search-tag-edit')).toBeNull();
  });

  it('an operator waiting for a value that is left empty adds nothing', () => {
    render(<SearchBar />);
    fireEvent.focus(input());
    type('/to');
    press('Enter');
    press('Escape', screen.getByTestId('search-tag-edit'));
    expect(tagTexts()).toEqual([]);
  });

  it('Escape closes the list and leaves the text', () => {
    render(<SearchBar />);
    fireEvent.focus(input());
    type('/');
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(input().value).toBe('/');
  });
});

describe('recent searches', () => {
  const recents = () => screen.queryAllByTestId('search-recent').map(node => node.textContent);

  it('lists every recent search while nothing is typed', () => {
    harness.settingsState.searchHistory = ['invoice march', 'from:ann'];
    render(<SearchBar />);
    fireEvent.focus(input());
    expect(recents()).toEqual(['invoice march', 'from:ann']);
  });

  it('keeps only the recent searches that hold the typed text, ignoring case', () => {
    harness.settingsState.searchHistory = ['Invoice march', 'from:ann', 'old invoices'];
    render(<SearchBar />);
    fireEvent.focus(input());
    type('INV');
    expect(recents()).toEqual(['Invoice march', 'old invoices']);
  });

  it('shows only the suggestions when no recent search matches', async () => {
    harness.settingsState.searchHistory = ['old query'];
    harness.suggest.mockResolvedValue([{ key: 'term:invoice', kind: 'term', tags: ['invoice'], label: 'invoice', detail: '', count: 5 }]);
    render(<SearchBar />);
    fireEvent.focus(input());
    type('inv');
    await screen.findByText('invoice');
    expect(recents()).toEqual([]);
    expect(screen.queryByRole('group', { name: 'Recent searches' })).toBeNull();
    press('ArrowDown');
    press('Enter');
    expect(tagTexts()).toEqual(['invoice']);
  });

  it('folds from its heading, and a folded list hides its searches from the keys too', async () => {
    harness.settingsState.searchHistory = ['invoices 2025'];
    harness.settingsState.recentSearchesCollapsed = true;
    harness.settingsState.toggleRecentSearches = vi.fn();
    harness.suggest.mockResolvedValue([{ key: 'term:invoice', kind: 'term', tags: ['invoice'], label: 'invoice', detail: '', count: 5 }]);
    render(<SearchBar />);
    fireEvent.focus(input());
    type('inv');
    await screen.findByText('invoice');
    expect(recents()).toEqual([]);
    const fold = screen.getByTestId('search-recent-fold');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    expect(harness.settingsState.toggleRecentSearches).toHaveBeenCalled();
    press('ArrowDown');
    press('Enter');
    expect(tagTexts()).toEqual(['invoice']);
  });

  it('keeps a folded heading in reach with nothing else to list', () => {
    harness.settingsState.searchHistory = ['invoices 2025'];
    harness.settingsState.recentSearchesCollapsed = true;
    render(<SearchBar />);
    fireEvent.focus(input());
    expect(screen.getByTestId('search-recent-fold')).not.toBeNull();
    expect(recents()).toEqual([]);
  });

  it('shows an unfolded list expanded', () => {
    harness.settingsState.searchHistory = ['invoices 2025'];
    render(<SearchBar />);
    fireEvent.focus(input());
    expect(screen.getByTestId('search-recent-fold').getAttribute('aria-expanded')).toBe('true');
    expect(recents()).toEqual(['invoices 2025']);
  });
});

describe('suggestions from the index', () => {
  const ann = { key: 'sender:ann@x.test', kind: 'sender', tags: ['from:ann@x.test'], label: 'Ann', detail: 'ann@x.test', count: 2 };
  const invoice = { key: 'term:invoice', kind: 'term', tags: ['invoice'], label: 'invoice', detail: '', count: 5 };

  it('lists them under the recent searches and commits a picked one as a tag', async () => {
    harness.settingsState.searchHistory = ['plan with ann'];
    harness.suggest.mockResolvedValue([ann, invoice]);
    render(<SearchBar />);
    fireEvent.focus(input());
    type('an');
    const option = await screen.findByText('Ann');
    expect(harness.suggest).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'an', accounts: ['a'] }));
    const recent = screen.getByText('plan with ann');
    expect(recent.compareDocumentPosition(option) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(option);
    expect(tagTexts()).toEqual(['from:ann@x.test']);
    expect(input().value).toBe('');
  });

  it('reaches a suggestion with the arrow keys, past the recent searches', async () => {
    harness.settingsState.searchHistory = ['invoices 2025'];
    harness.suggest.mockResolvedValue([invoice]);
    render(<SearchBar />);
    fireEvent.focus(input());
    type('inv');
    await screen.findByText('invoice');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(tagTexts()).toEqual(['invoice']);
    expect(harness.runs).toHaveLength(0);
  });

  it('asks every account in the unified view', async () => {
    harness.mailState.unifiedInbox = true;
    render(<SearchBar />);
    fireEvent.focus(input());
    type('an');
    await waitFor(() => expect(harness.suggest).toHaveBeenCalled());
    expect(harness.suggest.mock.calls.at(-1)[0].accounts).toEqual(['a', 'b']);
  });
});
