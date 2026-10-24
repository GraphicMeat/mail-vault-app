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

const VIEW = {
  id: 'v1', name: 'Utilities', icon: 'tag', position: 1, builtin: null,
  def: { query: 'saskaita', senders: ['servico.lt', 'bills@argus.lt'], excludeSenders: ['spam@servico.lt'], excludeMessages: ['a@x.test', 'b@x.test'] },
};

const saved = () => useViewStoreMock.getState().saveView.mock.calls[0][0];
const submit = () => fireEvent.submit(screen.getByTestId('view-editor-form'));

beforeEach(() => {
  daemonCall = vi.fn(async () => null);
  useViewStoreMock = create(() => ({
    views: [VIEW],
    saveView: vi.fn(async view => view),
    deleteView: vi.fn(async () => {}),
    previewDef: vi.fn(async () => ({ available: true, reason: null, rows: [], total: 0 })),
  }));
  useTagStoreMock = create(() => ({ tags: [] }));
  useFieldStoreMock = create(() => ({ fieldsFor: () => [] }));
  useMailStoreMock = create(() => ({ activeAccountId: 'acct-1', accounts: [{ id: 'acct-1', email: 'one@example.test' }] }));
});
afterEach(cleanup);
beforeEach(() => useUnsavedStore.setState({ guard: null, pending: null, busy: false }));

describe('the sender rules a view carries', () => {
  it('shows the allowed senders, the blocked ones and how many messages are kept out', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const rules = screen.getByTestId('view-sender-rules');
    expect(rules.textContent).toContain('servico.lt');
    expect(rules.textContent).toContain('bills@argus.lt');
    expect(rules.textContent).toContain('spam@servico.lt');
    expect(screen.getByTestId('view-kept-out').textContent).toContain('"count":2');
  });

  it('shows nothing for a view with no such rules', () => {
    render(<ViewEditor view={{ ...VIEW, def: { query: 'x' } }} onClose={() => {}} showPreview={false} />);
    expect(screen.queryByTestId('view-sender-rules')).toBeNull();
  });

  it('saves a rule removed, and leaves the others alone', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.click(screen.getByTestId('view-allowed-sender-0-remove'));
    fireEvent.click(screen.getByTestId('view-blocked-sender-0-remove'));
    submit();
    expect(saved().def).toMatchObject({ senders: ['bills@argus.lt'], excludeSenders: [], excludeMessages: ['a@x.test', 'b@x.test'] });
  });

  it('forgets the messages kept out', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.click(screen.getByTestId('view-kept-out-clear'));
    submit();
    expect(saved().def).toMatchObject({ excludeMessages: [], senders: ['servico.lt', 'bills@argus.lt'] });
    expect(screen.queryByTestId('view-kept-out')).toBeNull();
  });

  it('writes no rule keys into a view that never had any', () => {
    render(<ViewEditor view={{ ...VIEW, def: { query: 'x' } }} onClose={() => {}} showPreview={false} />);
    submit();
    for (const key of ['senders', 'excludeSenders', 'excludeMessages']) expect(saved().def).not.toHaveProperty(key);
  });
});
