// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../i18n/index.js', () => ({ t: key => key, useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }));

let daemonCall;
vi.mock('../../services/daemonClient', () => ({ daemonCall: (...args) => daemonCall(...args) }));

let useViewStoreMock;
let useTagStoreMock;
let useFieldStoreMock;
let useMailStoreMock;
vi.mock('../../stores/viewStore', () => ({
  useViewStore: Object.assign(selector => useViewStoreMock(selector), { getState: () => useViewStoreMock.getState() }),
  viewLabel: (view, translate) => view.name || translate(`views.builtin.${view.builtin}`),
}));
vi.mock('../../stores/tagStore', () => ({
  useTagStore: Object.assign(selector => useTagStoreMock(selector), { getState: () => useTagStoreMock.getState() }),
}));
vi.mock('../../stores/fieldStore', () => ({
  useFieldStore: Object.assign(selector => useFieldStoreMock(selector), { getState: () => useFieldStoreMock.getState() }),
}));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign(selector => useMailStoreMock(selector), { getState: () => useMailStoreMock.getState() }),
}));

const { ViewEditor } = await import('../ViewEditor');
const { useUnsavedStore } = await import('../../stores/unsavedStore');

const SUGGESTIONS = [
  { address: 'ann@acme.test', name: 'Ann Lee', count: 12 },
  { address: '@acme.test', name: '', count: 40 },
];

const VIEW = {
  id: 'v1', name: 'Receipts', icon: 'tag', position: 1, builtin: null,
  def: { query: '', sender: 'billing', tags: ['t1'], fields: [] },
};

const saved = () => useViewStoreMock.getState().saveView.mock.calls[0][0];
const submit = () => fireEvent.submit(screen.getByTestId('view-editor-form'));
// The editor's native selects hold role=option too: only the typeahead's list counts.
const suggestions = async () => within(await screen.findByRole('listbox')).getAllByRole('option');
const listed = () => within(screen.getByRole('listbox')).getAllByRole('option');

beforeEach(() => {
  daemonCall = vi.fn(async method => (method === 'views.suggest_senders' ? SUGGESTIONS : null));
  useViewStoreMock = create(() => ({
    views: [VIEW],
    saveView: vi.fn(async view => view),
    deleteView: vi.fn(async () => {}),
    previewDef: vi.fn(async () => ({ available: true, reason: null, rows: [], total: 0 })),
  }));
  useTagStoreMock = create(() => ({ tags: [
    { id: 't1', name: 'Receipts', color: '#f00' },
    { id: 't2', name: 'Clients' },
    { id: 't3', name: 'Client archive' },
  ] }));
  useFieldStoreMock = create(() => ({ fieldsFor: () => [] }));
  useMailStoreMock = create(() => ({
    activeAccountId: 'acct-1',
    accounts: [{ id: 'acct-1', email: 'one@example.test' }, { id: 'acct-2', email: 'two@example.test' }],
  }));
});
afterEach(cleanup);

beforeEach(() => useUnsavedStore.setState({ guard: null, pending: null, busy: false }));

describe('unsaved changes', () => {
  const guard = () => useUnsavedStore.getState().guard;

  it('holds no guard while nothing is changed', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    expect(guard()).toBeNull();
  });

  it('lists each changed part once, a typed-but-unadded word included', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Bills' } });
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'invoice' } });
    fireEvent.click(screen.getByTestId('view-starred-yes'));
    expect(guard().changes).toEqual(['views.name', 'views.filter.query', 'views.filter.starred']);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Receipts' } });
    expect(guard().changes).toEqual(['views.filter.query', 'views.filter.starred']);
  });

  it('the prompt saves what the form says, then tells the host', async () => {
    const onSaved = vi.fn();
    render(<ViewEditor view={VIEW} onClose={() => {}} onSaved={onSaved} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Bills' } });
    await expect(guard().save()).resolves.toBe(true);
    expect(saved().name).toBe('Bills');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('a save that cannot happen (no name) keeps the editor', async () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: '' } });
    await expect(guard().save()).resolves.toBe(false);
    expect(useViewStoreMock.getState().saveView).not.toHaveBeenCalled();
  });

  it('discard is the host\'s, and closing the editor drops the guard', async () => {
    const onDiscard = vi.fn();
    const { unmount } = render(<ViewEditor view={VIEW} onClose={() => {}} onDiscard={onDiscard} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Bills' } });
    await guard().discard();
    expect(onDiscard).toHaveBeenCalledOnce();
    unmount();
    expect(guard()).toBeNull();
  });
});
