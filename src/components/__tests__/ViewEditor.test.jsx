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
    moveView: vi.fn(async () => true),
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
    expect(screen.getByTestId('view-query').value).toBe('invoice');
    expect(screen.getByTestId('view-attachments').checked).toBe(true);
    expect(screen.getByTestId('view-tag-t1').checked).toBe(true);
    expect(screen.getByTestId('view-tag-t2').checked).toBe(false);
  });

  it('saves the name, the text and the filters together', () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Unpaid' } });
    fireEvent.change(screen.getByTestId('view-query'), { target: { value: 'overdue' } });
    fireEvent.click(screen.getByTestId('view-tag-t2'));
    fireEvent.change(screen.getByTestId('view-starred'), { target: { value: 'yes' } });
    fireEvent.submit(screen.getByTestId('view-editor-form'));

    const [saved] = useViewStoreMock.getState().saveView.mock.calls[0];
    expect(saved.id).toBe('v1');
    expect(saved.name).toBe('Unpaid');
    expect(saved.def.query).toBe('overdue');
    expect(saved.def.tags.sort()).toEqual(['t1', 't2']);
    expect(saved.def.starred).toBe(true);
    expect(saved.def.hasAttachments).toBe(true);
  });

  it('a tri-state filter can go back to not caring', () => {
    render(<ViewEditor view={{ ...MINE, def: { ...MINE.def, unread: true } }} onClose={() => {}} />);
    expect(screen.getByTestId('view-unread').value).toBe('yes');
    fireEvent.change(screen.getByTestId('view-unread'), { target: { value: 'any' } });
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

  it('moves the view in the sidebar', async () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('view-move-up'));
    await waitFor(() => expect(useViewStoreMock.getState().moveView).toHaveBeenCalledWith('v1', -1));
  });

  it('deletes only after the second press', async () => {
    const onClose = vi.fn();
    render(<ViewEditor view={MINE} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('view-delete'));
    expect(useViewStoreMock.getState().deleteView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('view-delete-confirm'));
    expect(useViewStoreMock.getState().deleteView).toHaveBeenCalledWith('v1');
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  /// Moving re-reads the stored view, so an unsaved name would be thrown away
  /// the moment the list reloads.
  it('saves what is typed before it moves the view', async () => {
    render(<ViewEditor view={MINE} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('view-name'), { target: { value: 'Unpaid' } });
    fireEvent.click(screen.getByTestId('view-move-up'));
    expect(useViewStoreMock.getState().saveView.mock.calls[0][0].name).toBe('Unpaid');
    await waitFor(() => expect(useViewStoreMock.getState().moveView).toHaveBeenCalledWith('v1', -1));
  });
});
