// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../i18n/index.js', () => ({ t: key => key, useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }));

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

const MINE = {
  id: 'v1', name: 'Receipts', icon: 'tag', position: 1, builtin: null,
  def: { query: 'invoice', tags: ['t1'], fields: [], starred: null, unread: null, answered: null, hasAttachments: true },
};
const STARRED = { id: 'builtin-starred', name: '', icon: 'star', position: 0, builtin: 'starred', def: { starred: true } };

beforeEach(() => {
  useViewStoreMock = create(() => ({
    views: [STARRED, MINE],
    saveView: vi.fn(async view => view),
    deleteView: vi.fn(async () => {}),
    previewDef: vi.fn(async () => ({ available: true, reason: null, rows: [], total: 0 })),
  }));
  useTagStoreMock = create(() => ({ tags: [{ id: 't1', name: 'Receipts' }, { id: 't2', name: 'Clients' }] }));
  useFieldStoreMock = create(() => ({
    fields: { 'acct-1': [{ id: 'f1', name: 'Priority', kind: 'select', options: [{ id: 'hi', label: 'High' }] }] },
    fieldsFor(accountId) { return this.fields[accountId] || []; },
  }));
  useMailStoreMock = create(() => ({ activeAccountId: 'acct-1' }));
});
afterEach(cleanup);

describe('editing a saved view', () => {
  it('opens on what the view already says', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    expect(screen.getByTestId('view-name').value).toBe('Receipts');
    expect(screen.getByText('invoice')).toBeTruthy();
    expect(screen.getByTestId('view-attachments').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('view-tag-t1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('view-tag-t2').getAttribute('aria-pressed')).toBe('false');
  });

  it('saves the name, the text and the filters together', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Unpaid' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.remove invoice' }));
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'overdue' } });
    fireEvent.click(screen.getByTestId('view-tag-t2'));
    fireEvent.click(screen.getByTestId('view-starred-yes'));
    fireEvent.submit(screen.getByTestId('view-editor-form'));

    const [saved] = useViewStoreMock.getState().saveView.mock.calls[0];
    expect(saved.id).toBe('v1');
    expect(saved.name).toBe('Unpaid');
    expect(saved.def.query).toBe('overdue');
    expect(saved.def.tags.sort()).toEqual(['t1', 't2']);
    expect(saved.def.starred).toBe(true);
    expect(saved.def.hasAttachments).toBe(true);
  });

  it('adds separate AND search keys, displays them as removable chips, and saves them', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    const input = screen.getByTestId('view-query');
    fireEvent.change(input, { target: { value: 'service && jasinskio' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'common.remove service' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'common.remove jasinskio' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.remove invoice' }));
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].def.query).toBe('service jasinskio');
  });

  it('a tri-state filter can go back to not caring', () => {
    render(<ViewEditor view={{ ...MINE, def: { ...MINE.def, unread: true } }} onClose={() => {}} />);
    expect(screen.getByTestId('view-unread-yes').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('view-unread-any'));
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].def.unread).toBe(null);
  });

  it('narrows on a custom field value', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('view-field-f1'), { target: { value: 'hi' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].def.fields)
      .toEqual([{ fieldId: 'f1', op: 'is', value: 'hi' }]);
  });

  it('chooses the icon and account filters with buttons', () => {
    useMailStoreMock.setState({ accounts: [
      { id: 'acct-1', email: 'one@example.test' },
      { id: 'acct-2', email: 'two@example.test' },
    ] });
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('view-icon-paperclip'));
    fireEvent.click(screen.getByTestId('view-account-acct-2'));
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    const [saved] = useViewStoreMock.getState().saveView.mock.calls[0];
    expect(saved.icon).toBe('paperclip');
    expect(saved.def.accounts).toEqual(['acct-2']);
  });

  it('saves an arbitrary emoji and reopens with it selected', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    expect(screen.getAllByTestId(/^view-icon-(reply|inbox|paperclip|tag|star)$/).slice(0, 3)
      .map(button => button.dataset.testid)).toEqual(['view-icon-reply', 'view-icon-inbox', 'view-icon-paperclip']);
    fireEvent.change(screen.getByTestId('view-emoji'), { target: { value: '🧑🏽‍💻' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    const [saved] = useViewStoreMock.getState().saveView.mock.calls[0];
    expect(saved.icon).toBe('emoji:🧑🏽‍💻');
    cleanup();
    render(<ViewEditor view={saved} onClose={() => {}} />);
    expect(screen.getByTestId('view-emoji').value).toBe('🧑🏽‍💻');
  });

  it('offers emojis to pick while the emoji field is focused', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    expect(screen.queryByTestId('view-emoji-picker')).toBeNull();
    fireEvent.focus(screen.getByTestId('view-emoji'));
    fireEvent.click(screen.getByTestId('view-emoji-picker').querySelector('button'));
    expect(screen.queryByTestId('view-emoji-picker')).toBeNull();
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].icon).toBe('emoji:📥');
  });

  /// Read back as a bare value, a saved `isNot` reopened as `is` — the editor
  /// then saved the opposite of what the view said.
  it('reopens a saved condition on the operator it was saved with', () => {
    const view = { ...MINE, def: { ...MINE.def, fields: [{ fieldId: 'f1', op: 'isNot', value: 'hi' }] } };
    render(<ViewEditor view={view} onClose={() => {}} />);
    expect(screen.getByTestId('view-field-op-f1').value).toBe('isNot');
    expect(screen.getByTestId('view-field-f1').value).toBe('hi');
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].def.fields)
      .toEqual([{ fieldId: 'f1', op: 'isNot', value: 'hi' }]);
  });

  it('keeps a condition that needs no value at all', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('view-field-op-f1'), { target: { value: 'isEmpty' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].def.fields)
      .toEqual([{ fieldId: 'f1', op: 'isEmpty' }]);
  });

  it('a field nobody touched narrows nothing', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].def.fields).toEqual([]);
  });

  it('groups the view by a field, and reopens on it', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    expect(screen.getByTestId('view-group').value).toBe('');
    fireEvent.change(screen.getByTestId('view-group'), { target: { value: 'field:f1' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    const [saved] = useViewStoreMock.getState().saveView.mock.calls[0];
    expect(saved.def.group).toBe('field:f1');

    cleanup();
    render(<ViewEditor view={saved} onClose={() => {}} />);
    expect(screen.getByTestId('view-group').value).toBe('field:f1');
  });

  it('a starter keeps its own name when none is typed', () => {
    render(<ViewEditor view={STARRED} onClose={() => {}} />);
    expect(screen.getByTestId('view-name').value).toBe('');
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].name).toBe('');
  });

  it('will not leave a view the user made with no name at all', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));
    expect(useViewStoreMock.getState().saveView).not.toHaveBeenCalled();
  });

  it('deletes only after modal confirmation', async () => {
    const onClose = vi.fn();
    render(<ViewEditor view={MINE} onClose={onClose} />);
    expect(screen.getByTestId('view-delete').className).toContain('text-mail-danger');
    fireEvent.click(screen.getByTestId('view-delete'));
    expect(useViewStoreMock.getState().deleteView).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'views.deleteConfirm' }).className).toContain('bg-mail-danger-fill');
    fireEvent.click(screen.getAllByRole('button', { name: 'common.cancel' }).at(-1));
    expect(useViewStoreMock.getState().deleteView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('view-delete'));
    fireEvent.click(screen.getByRole('button', { name: 'views.deleteConfirm' }));
    expect(useViewStoreMock.getState().deleteView).toHaveBeenCalledWith('v1');
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

});
