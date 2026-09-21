// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../i18n/index.js', () => ({ t: key => key, useT: () => key => key }));

let useViewStoreMock;
let useTagStoreMock;
function useViewStore(selector) { return useViewStoreMock(selector); }
useViewStore.getState = () => useViewStoreMock.getState();
function useTagStore(selector) { return useTagStoreMock(selector); }
useTagStore.getState = () => useTagStoreMock.getState();
vi.mock('../../stores/viewStore', () => ({ useViewStore, viewLabel: v => v.name }));
vi.mock('../../stores/tagStore', () => ({ useTagStore }));

const { SaveSearchAsView } = await import('../SaveSearchAsView');

beforeEach(() => {
  useViewStoreMock = create(() => ({
    saveView: vi.fn(async view => view),
    openView: vi.fn(async () => true),
    defFromSearch: vi.fn(() => ({ query: 'invoice', tags: ['t1'] })),
  }));
  useTagStoreMock = create(() => ({ tags: [{ id: 't1', name: 'Receipts' }] }));
});
afterEach(cleanup);

describe('saving the search on screen as a view', () => {
  it('saves the definition the search describes, under the name typed', async () => {
    render(<SaveSearchAsView />);
    fireEvent.click(screen.getByTestId('save-search-as-view'));
    fireEvent.change(screen.getByTestId('save-view-name'), { target: { value: 'Unpaid' } });
    fireEvent.submit(screen.getByTestId('save-view-form'));
    await Promise.resolve();
    const saved = useViewStoreMock.getState().saveView.mock.calls[0][0];
    expect(saved.name).toBe('Unpaid');
    expect(saved.def).toEqual({ query: 'invoice', tags: ['t1'] });
    expect(saved.builtin).toBeNull();
    expect(saved.id).toBeTruthy();
  });

  it('will not save a view with no name', () => {
    render(<SaveSearchAsView />);
    fireEvent.click(screen.getByTestId('save-search-as-view'));
    fireEvent.submit(screen.getByTestId('save-view-form'));
    expect(useViewStoreMock.getState().saveView).not.toHaveBeenCalled();
  });

  it('resolves the tag names in the query through the tag list', () => {
    render(<SaveSearchAsView />);
    fireEvent.click(screen.getByTestId('save-search-as-view'));
    fireEvent.change(screen.getByTestId('save-view-name'), { target: { value: 'Unpaid' } });
    fireEvent.submit(screen.getByTestId('save-view-form'));
    expect(useViewStoreMock.getState().defFromSearch).toHaveBeenCalledWith([{ id: 't1', name: 'Receipts' }]);
  });
});
