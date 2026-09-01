// @vitest-environment jsdom
//
// "It's especially important in the archive – the structure tells us exactly
// where something was filed, which lets us narrow down search much more
// effectively." — bson73, discussion #1.
//
// One folder is too narrow to find a filed message; all 59 is too wide to read.
// The scope the hierarchy exists to give you is the branch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => children,
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
}));

const box = (path) => ({ path, name: path.split('.').pop(), delimiter: '.', noselect: false, children: [] });
const MAILBOXES = [box('INBOX'), box('Kunden'), box('Kunden.Company XY'), box('Kunden-Alt')];

let searchState;
let setFilters;
vi.mock('../../stores/searchStore', () => ({
  useSearchStore: (selector) => selector(searchState),
}));
vi.mock('../../stores/accountStore', () => ({
  useAccountStore: (selector) => selector({ mailboxes: MAILBOXES, activeMailbox: 'INBOX' }),
}));

import { SearchBar } from '../SearchBar';

const scopeSelect = () => document.querySelector('[data-testid="search-folder-scope"]');
const subBox = () => document.querySelector('[data-testid="search-include-subfolders"]');

const open = () => {
  const view = render(<SearchBar />);
  const filterBtn = document.querySelector('[data-testid="search-filters-toggle"]');
  if (filterBtn) fireEvent.click(filterBtn);
  return view;
};

beforeEach(() => {
  setFilters = vi.fn();
  searchState = {
    searchQuery: 'Rechnung', searchActive: true, isSearching: false, searchProgress: null,
    searchResults: [],
    searchFilters: { location: 'all', folder: 'Kunden', sender: '', dateFrom: null, dateTo: null, hasAttachments: false },
    setSearchQuery: vi.fn(), setSearchFilters: setFilters,
    performSearch: vi.fn(), clearSearch: vi.fn(),
  };
});
afterEach(cleanup);

describe('searching a folder and everything under it', () => {
  it('scopes the search to the branch when the box is ticked', () => {
    open();
    fireEvent.click(subBox());
    expect(setFilters).toHaveBeenCalledWith({ folder: 'sub:Kunden' });
  });

  it('keeps showing the folder you picked while the branch is included', () => {
    searchState.searchFilters = { ...searchState.searchFilters, folder: 'sub:Kunden' };
    open();
    expect(scopeSelect().value).toBe('Kunden');
    expect(subBox().checked).toBe(true);
  });

  it('goes back to the folder alone when the box is cleared', () => {
    searchState.searchFilters = { ...searchState.searchFilters, folder: 'sub:Kunden' };
    open();
    fireEvent.click(subBox());
    expect(setFilters).toHaveBeenCalledWith({ folder: 'Kunden' });
  });

  it('carries the branch across a change of folder', () => {
    searchState.searchFilters = { ...searchState.searchFilters, folder: 'sub:Kunden' };
    open();
    fireEvent.change(scopeSelect(), { target: { value: 'Kunden.Company XY' } });
    expect(setFilters).toHaveBeenCalledWith({ folder: 'sub:Kunden.Company XY' });
  });

  it('offers nothing to include when the search is already every folder', () => {
    searchState.searchFilters = { ...searchState.searchFilters, folder: 'all' };
    open();
    expect(subBox().disabled).toBe(true);
    expect(subBox().checked).toBe(false);
  });

  it('says the branch was searched, so the count is not read as one folder', () => {
    searchState.searchFilters = { ...searchState.searchFilters, folder: 'sub:Kunden' };
    searchState.searchResults = [{ uid: 1, source: 'local' }];
    open();
    const summary = document.body.textContent;
    expect(summary).toContain('Kunden');
    expect(summary.toLowerCase()).toContain('subfolder');
  });
});
