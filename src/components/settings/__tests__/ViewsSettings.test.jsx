// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../../i18n/index.js', () => ({
  t: key => key,
  useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

let useViewStoreMock;
let useSettingsStoreMock;
const MAX_FREE_VIEWS = 3;
vi.mock('../../../stores/viewStore', () => ({
  useViewStore: Object.assign(selector => useViewStoreMock(selector), {
    getState: () => useViewStoreMock.getState(),
    setState: (...args) => useViewStoreMock.setState(...args),
  }),
  viewLabel: (view, translate) => view.name || translate(`views.builtin.${view.builtin}`),
  viewLimitReached: (views, premium) => !premium && (views?.length || 0) >= MAX_FREE_VIEWS,
  MAX_FREE_VIEWS,
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(selector => useSettingsStoreMock(selector), {
    getState: () => useSettingsStoreMock.getState(),
  }),
  hasPremiumAccess: profile => !!profile?.premium,
}));
vi.mock('../../ViewEditor', () => ({
  ViewEditor: ({ view }) => React.createElement('div', { 'data-testid': `view-editor-${view.id}` }),
}));

const { ViewsSettings } = await import('../ViewsSettings');

const STARRED = { id: 'builtin-starred', name: '', icon: 'star', position: 0, builtin: 'starred', def: {} };
const MINE = { id: 'v1', name: 'Receipts', icon: 'tag', position: 1, builtin: null, def: {} };
const THIRD = { id: 'v2', name: 'Clients', icon: 'tag', position: 2, builtin: null, def: {} };

const setViews = views => useViewStoreMock.setState({ views });

beforeEach(() => {
  useViewStoreMock = create((set, get) => ({
    views: [STARRED, MINE],
    pendingNew: false,
    loadViews: vi.fn(async () => get().views),
    // The real one refuses at the cap; the component must ask rather than
    // decide for itself.
    createView: vi.fn(async (view, premium) => (!premium && get().views.length >= MAX_FREE_VIEWS
      ? { ok: false, reason: 'limit' }
      : (set({ views: [...get().views, view] }), { ok: true, view }))),
    reorderViews: vi.fn(async ids => set({ views: ids.map(id => get().views.find(view => view.id === id)) })),
  }));
  useSettingsStoreMock = create(() => ({ billingProfile: { premium: false } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the Views settings page', () => {
  it('moves views from a drag handle and saves the new order', async () => {
    setViews([STARRED, MINE, THIRD]);
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      constructor(type, options = {}) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
        this.isPrimary = options.isPrimary ?? true;
      }
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = this.matches('li') ? [...this.parentElement.children].indexOf(this) : 0;
      return { left: 0, right: 260, top: index * 60, bottom: this.matches('li') ? (index + 1) * 60 : 180, width: 260, height: this.matches('li') ? 60 : 180 };
    });
    render(<ViewsSettings />);
    const handle = screen.getByRole('button', { name: 'views.reorder:{"name":"Receipts"}' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 90 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 170 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 170 });
    await waitFor(() => expect(useViewStoreMock.getState().reorderViews).toHaveBeenCalledWith(['builtin-starred', 'v2', 'v1']));
  });
  it('lists every view, starters by their translated name', () => {
    render(<ViewsSettings />);
    expect(screen.getByText('views.builtin.starred')).toBeTruthy();
    expect(screen.getByText('Receipts')).toBeTruthy();
  });

  it('opens the builder for the view that was picked', () => {
    render(<ViewsSettings />);
    fireEvent.click(screen.getByTestId('views-row-v1'));
    expect(screen.getByTestId('view-editor-v1')).toBeTruthy();
  });

  it('makes a view and opens its builder', async () => {
    render(<ViewsSettings />);
    fireEvent.click(screen.getByTestId('views-new'));
    await screen.findByTestId('views-list');
    const made = useViewStoreMock.getState().createView.mock.calls[0][0];
    expect(made.builtin).toBeNull();
    expect(made.id).toBeTruthy();
    expect(await screen.findByTestId(`view-editor-${made.id}`)).toBeTruthy();
  });

  /// The starters count. A free account makes room by deleting one it never
  /// opens, which is why they are ordinary deletable rows.
  it('stops at three views on a free plan and says so', () => {
    setViews([STARRED, MINE, THIRD]);
    render(<ViewsSettings />);
    expect(screen.getByTestId('views-new').disabled).toBe(true);
    expect(screen.getByTestId('views-limit').textContent).toContain('3');
  });

  it('caps nothing on a paid plan', () => {
    setViews([STARRED, MINE, THIRD]);
    useSettingsStoreMock.setState({ billingProfile: { premium: true } });
    render(<ViewsSettings />);
    expect(screen.getByTestId('views-new').disabled).toBe(false);
    expect(screen.queryByTestId('views-limit')).toBeNull();
  });

  it('offers the way to a paid plan rather than a dead end', () => {
    const onUpgrade = vi.fn();
    render(<ViewsSettings onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByTestId('views-upgrade'));
    expect(onUpgrade).toHaveBeenCalled();
  });

  /// Settings is a window of its own, so the sidebar's + leaves its intent in
  /// the store rather than passing a prop that cannot cross.
  it('makes the view the sidebar asked for, once', async () => {
    useViewStoreMock.setState({ pendingNew: true });
    render(<ViewsSettings />);
    await screen.findByTestId('views-list');
    expect(useViewStoreMock.getState().createView).toHaveBeenCalledTimes(1);
    expect(useViewStoreMock.getState().pendingNew).toBe(false);
  });
});
