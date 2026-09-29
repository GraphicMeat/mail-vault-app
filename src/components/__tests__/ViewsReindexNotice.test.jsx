// @vitest-environment jsdom
//
// A saved view is a query against the search index, so while the index is
// rebuilt a view finds nothing. The owner asked for a modal that says so the
// first time a view comes back "building", and for the list to say it too
// instead of sitting empty.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../i18n/index.js', () => ({
  t: key => key,
  useT: () => key => key,
}));

let progress = null;
vi.mock('../../services/searchIndex', () => ({
  onProgress: async (cb) => { progress = cb; return () => { progress = null; }; },
}));

let useViewStoreMock;
function useViewStore(selector) { return useViewStoreMock(selector); }
useViewStore.getState = () => useViewStoreMock.getState();
useViewStore.setState = (...args) => useViewStoreMock.setState(...args);
vi.mock('../../stores/viewStore', () => ({ useViewStore }));

const { ViewsReindexNotice } = await import('../ViewsReindexNotice');
const { ViewUnavailableState } = await import('../ViewUnavailableState');

const notice = () => screen.queryByTestId('views-reindex-notice');
const openAs = (activeViewId, unavailableReason) => act(() => { useViewStoreMock.setState({ activeViewId, unavailableReason }); });

async function mount() {
  render(<ViewsReindexNotice />);
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  useViewStoreMock = create(() => ({
    activeViewId: null,
    unavailableReason: null,
    openView: vi.fn(async () => true),
  }));
});
afterEach(() => { cleanup(); progress = null; });

describe('the views notice while the index is rebuilt', () => {
  it('stays shut while every view can answer', async () => {
    await mount();
    openAs('v1', null);
    expect(notice()).toBeNull();
  });

  it('explains a view that came back while the index is rebuilding, and closes on OK', async () => {
    await mount();
    openAs('v1', 'building');
    expect(notice()).not.toBeNull();
    expect(notice().textContent).toContain('views.reindexNotice.title');
    expect(notice().textContent).toContain('views.reindexNotice.body');
    fireEvent.click(screen.getByTestId('views-reindex-notice-ok'));
    expect(notice()).toBeNull();
  });

  it('closes on Escape', async () => {
    await mount();
    openAs('v1', 'building');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(notice()).toBeNull();
  });

  it('says it once per rebuild, not on every view opened during it', async () => {
    await mount();
    openAs('v1', 'building');
    fireEvent.click(screen.getByTestId('views-reindex-notice-ok'));
    openAs('v2', null);
    openAs('v2', 'building');
    expect(notice()).toBeNull();
  });

  it('says it again on the next rebuild', async () => {
    await mount();
    openAs('v1', 'building');
    fireEvent.click(screen.getByTestId('views-reindex-notice-ok'));
    act(() => progress({ state: 'idle', firstPassDone: true }));
    openAs(null, null);
    openAs('v1', 'building');
    expect(notice()).not.toBeNull();
  });

  it('only speaks for a rebuild, not an index that is off or closed', async () => {
    await mount();
    openAs('v1', 'off');
    expect(notice()).toBeNull();
    openAs('v1', 'unavailable');
    expect(notice()).toBeNull();
  });

  it('runs the waiting view again once the rebuild has its first pass', async () => {
    await mount();
    openAs('v1', 'building');
    const { openView } = useViewStoreMock.getState();
    act(() => progress({ state: 'indexing', firstPassDone: false }));
    expect(openView).not.toHaveBeenCalled();
    act(() => progress({ state: 'idle', firstPassDone: true }));
    expect(openView).toHaveBeenCalledWith('v1');
  });

  it('leaves a view that already answered alone when a pass ends', async () => {
    await mount();
    openAs('v1', null);
    act(() => progress({ state: 'idle', firstPassDone: true }));
    expect(useViewStoreMock.getState().openView).not.toHaveBeenCalled();
  });
});

describe('the list while a view cannot answer', () => {
  it('says the index is rebuilding rather than showing an empty list', () => {
    render(<ViewUnavailableState reason="building" />);
    const state = screen.getByTestId('view-unavailable-state');
    expect(state.textContent).toContain('views.unavailableState.buildingTitle');
    expect(state.textContent).toContain('views.unavailableState.buildingBody');
  });

  it('gives any other reason in its own words', () => {
    render(<ViewUnavailableState reason="off" />);
    const state = screen.getByTestId('view-unavailable-state');
    expect(state.textContent).toContain('views.unavailableState.title');
    expect(state.textContent).toContain('views.unavailable.off');
  });
});
