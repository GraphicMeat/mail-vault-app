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

describe('sender typeahead', () => {
  it('suggests indexed senders for what is typed, from every account when none is chosen', async () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-sender'), { target: { value: 'ac' } });
    const options = await suggestions();
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('Ann Lee');
    expect(options[0].textContent).toContain('ann@acme.test');
    expect(options[0].textContent).toContain('12');
    expect(options[1].textContent).toContain('@acme.test');
    expect(daemonCall).toHaveBeenCalledWith('views.suggest_senders', { prefix: 'ac', accounts: ['acct-1', 'acct-2'], limit: 8 });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('asks only the accounts the view is narrowed to', async () => {
    render(<ViewEditor view={{ ...VIEW, def: { ...VIEW.def, accounts: ['acct-2'] } }} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-sender'), { target: { value: 'ac' } });
    await suggestions();
    expect(daemonCall).toHaveBeenCalledWith('views.suggest_senders', { prefix: 'ac', accounts: ['acct-2'], limit: 8 });
  });

  it('ArrowDown then Enter adds the highlighted address as a word, saved in the same notation', async () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-sender');
    fireEvent.change(input, { target: { value: 'ac' } });
    await suggestions();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(listed()[0].id);
    // The field sits inside the editor's form: an Enter that picks must not
    // also submit it.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(useViewStoreMock.getState().saveView).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByTestId('view-sender-group-0').textContent).toContain('ann@acme.test');
    submit();
    expect(saved().def.sender).toBe('billing && ann@acme.test');
  });

  it('a click on a suggestion adds it too, a domain as well as an address', async () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-sender'), { target: { value: '@ac' } });
    const options = await suggestions();
    fireEvent.mouseDown(options[1]);
    fireEvent.click(options[1]);
    submit();
    expect(saved().def.sender).toBe('billing && @acme.test');
  });

  it('Enter with nothing highlighted keeps what was typed, as before', async () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-sender');
    fireEvent.change(input, { target: { value: 'ac' } });
    await suggestions();
    fireEvent.keyDown(input, { key: 'Enter' });
    submit();
    expect(saved().def.sender).toBe('billing && ac');
  });

  it('free text still adds with Enter when the index has nothing to suggest', async () => {
    daemonCall = vi.fn(async () => []);
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-sender');
    fireEvent.change(input, { target: { value: 'stripe' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    submit();
    expect(saved().def.sender).toBe('billing && stripe');
  });

  it('a failed lookup is no suggestions, not an error', async () => {
    daemonCall = vi.fn(async () => { throw new Error('daemon down'); });
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-sender');
    fireEvent.change(input, { target: { value: 'ac' } });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(daemonCall).toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    submit();
    expect(saved().def.sender).toBe('billing && ac');
  });

  it('Escape closes the suggestions and leaves the typed text', async () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-sender');
    fireEvent.change(input, { target: { value: 'ac' } });
    await suggestions();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('ac');
  });

  it('Backspace on an empty input removes the last word of the last group', () => {
    render(<ViewEditor view={{ ...VIEW, def: { ...VIEW.def, sender: 'acme || billing && stripe' } }} onClose={() => {}} showPreview={false} />);
    fireEvent.keyDown(screen.getByTestId('view-sender'), { key: 'Backspace' });
    submit();
    expect(saved().def.sender).toBe('acme || billing');
  });

  it('the query field does not ask for senders', async () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'ac' } });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(daemonCall).not.toHaveBeenCalledWith('views.suggest_senders', expect.anything());
  });
});

describe('query word typeahead', () => {
  /// `total` indexed terms, `word0`..`wordN`, served a page at a time.
  const serveTerms = total => {
    daemonCall = vi.fn(async (method, { offset = 0, limit = 20 } = {}) => (method === 'views.suggest_terms'
      ? Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ term: `word${offset + i}`, count: total - offset - i }))
      : null));
  };
  const termCalls = () => daemonCall.mock.calls.filter(([method]) => method === 'views.suggest_terms');
  /// jsdom lays nothing out: the list is at its end when these say so.
  const scrollToEnd = list => {
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 240 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 360 });
    fireEvent.scroll(list);
  };

  it('asks nothing for one letter, and the top 20 with counts from two', async () => {
    serveTerms(50);
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'w' } });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(termCalls()).toHaveLength(0);
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'wo' } });
    const options = await suggestions();
    expect(options).toHaveLength(20);
    expect(options[0].textContent).toContain('word0');
    expect(options[0].textContent).toContain('50');
    expect(termCalls()[0][1]).toEqual({ prefix: 'wo', accounts: ['acct-1', 'acct-2'], offset: 0, limit: 20 });
  });

  it('scrolling to the end of the list loads the next 20, and stops at a short page', async () => {
    serveTerms(45);
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'wo' } });
    await suggestions();
    scrollToEnd(screen.getByRole('listbox'));
    await vi.waitFor(() => expect(listed()).toHaveLength(40));
    expect(termCalls()[1][1].offset).toBe(20);
    scrollToEnd(screen.getByRole('listbox'));
    await vi.waitFor(() => expect(listed()).toHaveLength(45));
    scrollToEnd(screen.getByRole('listbox'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(termCalls()).toHaveLength(3);
    expect(new Set(listed().map(option => option.querySelector('.typeahead-label').textContent)).size).toBe(45);
  });

  it('ArrowDown past the last option loads more, since a keyboard cannot scroll', async () => {
    serveTerms(30);
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-query');
    fireEvent.change(input, { target: { value: 'wo' } });
    await suggestions();
    for (let i = 0; i < 21; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });
    await vi.waitFor(() => expect(listed()).toHaveLength(30));
  });

  it('a picked term becomes a query word', async () => {
    serveTerms(5);
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'wo' } });
    fireEvent.click((await suggestions())[2]);
    submit();
    await vi.waitFor(() => expect(saved().def.query).toBe('word2'));
  });
});

describe('tag typeahead', () => {
  it('shows the chosen tags as chips and offers only the others', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    expect(screen.getByTestId('view-tag-t1')).toBeTruthy();
    expect(screen.queryByTestId('view-tag-t2')).toBeNull();
    fireEvent.change(screen.getByTestId('view-tags'), { target: { value: 're' } });
    // "Receipts" is already chosen, so nothing else matches.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('typing part of a name and Enter adds that tag', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-tags');
    fireEvent.change(input, { target: { value: 'cli' } });
    expect(listed().map(option => option.textContent)).toEqual(['Clients', 'Client archive']);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(input.value).toBe('');
    submit();
    expect(saved().def.tags).toEqual(['t1', 't2']);
  });

  it('ArrowDown moves through the matches before Enter picks', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    const input = screen.getByTestId('view-tags');
    fireEvent.change(input, { target: { value: 'cli' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    submit();
    expect(saved().def.tags).toEqual(['t1', 't3']);
  });

  it('an option is clickable by its tag test id', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.change(screen.getByTestId('view-tags'), { target: { value: 'arch' } });
    fireEvent.click(screen.getByTestId('view-tag-t3'));
    submit();
    expect(saved().def.tags).toEqual(['t1', 't3']);
  });

  it('the x on a chip removes the tag', () => {
    render(<ViewEditor view={VIEW} onClose={() => {}} showPreview={false} />);
    fireEvent.click(screen.getByTestId('view-tag-t1'));
    expect(screen.queryByText('Receipts')).toBeNull();
    submit();
    expect(saved().def.tags).toEqual([]);
  });

  it('Backspace on an empty input removes the last tag', () => {
    render(<ViewEditor view={{ ...VIEW, def: { ...VIEW.def, tags: ['t1', 't2'] } }} onClose={() => {}} showPreview={false} />);
    fireEvent.keyDown(screen.getByTestId('view-tags'), { key: 'Backspace' });
    submit();
    expect(saved().def.tags).toEqual(['t1']);
  });
});
