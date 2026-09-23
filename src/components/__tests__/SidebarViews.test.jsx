// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../i18n/index.js', () => ({
  t: key => key,
  useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

let useViewStoreMock;
function useViewStore(selector) { return useViewStoreMock(selector); }
useViewStore.getState = () => useViewStoreMock.getState();
useViewStore.setState = (...args) => useViewStoreMock.setState(...args);
vi.mock('../../stores/viewStore', async () => {
  const actual = await vi.importActual('../../stores/viewStore');
  return { useViewStore, viewLabel: actual.viewLabel };
});
let useSettingsStoreMock;
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(selector => useSettingsStoreMock(selector), {
    getState: () => useSettingsStoreMock.getState(),
    setState: (...args) => useSettingsStoreMock.setState(...args),
  }),
}));

const { SidebarViews } = await import('../SidebarViews');

const STARRED = { id: 'builtin-starred', name: '', icon: 'star', position: 0, builtin: 'starred', def: {} };
const MINE = { id: 'v1', name: 'Receipts', icon: 'tag', position: 1, builtin: null, def: {} };

beforeEach(() => {
  useViewStoreMock = create(() => ({
    views: [STARRED, MINE],
    counts: { 'builtin-starred': 4 },
    activeViewId: null,
    unavailableReason: null,
    pendingNew: false,
    openView: vi.fn(async () => true),
    closeView: vi.fn(),
  }));
  useSettingsStoreMock = create(set => ({
    viewsSectionCollapsed: false,
    toggleViewsSection: () => set(state => ({ viewsSectionCollapsed: !state.viewsSectionCollapsed })),
  }));
});
afterEach(cleanup);

describe('the Views section', () => {
  it('names a starter by its builtin id and a saved view by its name', () => {
    render(<SidebarViews />);
    expect(screen.getByText('views.builtin.starred')).toBeTruthy();
    expect(screen.getByText('Receipts')).toBeTruthy();
  });

  it('renders a saved emoji icon in the sidebar', () => {
    useViewStoreMock.setState({ views: [{ ...MINE, icon: 'emoji:🧑🏽‍💻' }] });
    render(<SidebarViews />);
    expect(screen.getByTestId('view-row-v1').textContent).toContain('🧑🏽‍💻');
  });

  it('shows the count the daemon gave, and nothing where there is none', () => {
    render(<SidebarViews />);
    expect(screen.getByTestId('view-count-builtin-starred').textContent).toBe('4');
    expect(screen.queryByTestId('view-count-v1')).toBeNull();
  });

  it('opens the view that was clicked', () => {
    render(<SidebarViews />);
    fireEvent.click(screen.getByTestId('view-row-v1'));
    expect(useViewStoreMock.getState().openView).toHaveBeenCalledWith(MINE);
  });

  it('marks the open view', () => {
    useViewStoreMock.setState({ activeViewId: 'v1' });
    render(<SidebarViews />);
    expect(screen.getByTestId('view-row-v1').getAttribute('aria-current')).toBe('true');
  });

  it('says when the index could not answer instead of showing an empty view', () => {
    useViewStoreMock.setState({ activeViewId: 'v1', unavailableReason: 'building' });
    render(<SidebarViews />);
    expect(screen.getByTestId('views-unavailable').textContent).toContain('views.unavailable.building');
  });

  /// The collapsed rail is its own render: a section that only exists in the
  /// wide sidebar silently vanishes when someone narrows it.
  it('still shows every view when the sidebar is collapsed', () => {
    render(<SidebarViews collapsed />);
    expect(screen.getByTestId('view-row-builtin-starred')).toBeTruthy();
    expect(screen.getByTestId('view-row-v1')).toBeTruthy();
    expect(screen.queryByText('Receipts')).toBeNull();
  });

  /// A view is edited on the Views page in Settings, never from its row: a
  /// pencil at the end of every row was one more target in a list that is only
  /// for opening things, so the row is the only control each view gets.
  it('gives a row no edit control, wide or collapsed', () => {
    const { unmount } = render(<SidebarViews onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId('view-edit-v1')).toBeNull();
    // Rows have no edit action; the shared Edit button sits beside +.
    expect(screen.getAllByRole('button').map(b => b.dataset.testid).sort())
      .toEqual(['view-edit', 'view-new', 'view-row-builtin-starred', 'view-row-v1', 'views-fold']);
    unmount();
    render(<SidebarViews collapsed onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId('view-edit-v1')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  /// The + is the accounts + : it makes one, rather than only showing the
  /// place where one could be made.
  it('asks the Views page for a new view', () => {
    const onOpenSettings = vi.fn();
    render(<SidebarViews onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId('view-new'));
    expect(useViewStoreMock.getState().pendingNew).toBe(true);
    expect(onOpenSettings).toHaveBeenCalledWith('views');
  });

  it('opens Views settings from Edit without starting a new view', () => {
    const onOpenSettings = vi.fn();
    render(<SidebarViews onOpenSettings={onOpenSettings} />);
    const controls = screen.getAllByRole('button').map(button => button.dataset.testid);
    expect(controls.indexOf('view-edit')).toBeLessThan(controls.indexOf('view-new'));
    fireEvent.click(screen.getByTestId('view-edit'));
    expect(onOpenSettings).toHaveBeenCalledWith('views');
    expect(useViewStoreMock.getState().pendingNew).toBe(false);
  });

  it('folds the list away and keeps the heading', () => {
    render(<SidebarViews />);
    fireEvent.click(screen.getByTestId('views-fold'));
    expect(useSettingsStoreMock.getState().viewsSectionCollapsed).toBe(true);
  });

  it('shows no rows while folded', () => {
    useSettingsStoreMock.setState({ viewsSectionCollapsed: true });
    render(<SidebarViews />);
    expect(screen.queryByTestId('view-row-v1')).toBeNull();
    expect(screen.getByTestId('views-fold').getAttribute('aria-expanded')).toBe('false');
  });
});
