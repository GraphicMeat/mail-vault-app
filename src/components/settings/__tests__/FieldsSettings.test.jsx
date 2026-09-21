// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../../i18n/index.js', () => ({ t: key => key, useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }));

let useMailStoreMock;
let useFieldStoreMock;
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: Object.assign(selector => useMailStoreMock(selector), { getState: () => useMailStoreMock.getState() }),
}));
vi.mock('../../../stores/fieldStore', () => ({
  useFieldStore: Object.assign(selector => useFieldStoreMock(selector), { getState: () => useFieldStoreMock.getState() }),
}));

const { FieldsSettings } = await import('../FieldsSettings');

const PRIORITY = {
  id: 'f1', scope: 'acct-1', name: 'Priority', kind: 'select', position: 0,
  options: [{ id: 'hi', label: 'High' }],
};
const OWNER = { id: 'g1', scope: '*', name: 'Owner', kind: 'text', position: 0, options: [] };

beforeEach(() => {
  useMailStoreMock = create(() => ({
    activeAccountId: 'acct-1',
    accounts: [{ id: 'acct-1', email: 'me@x.test' }, { id: 'acct-2', email: 'other@x.test' }],
  }));
  useFieldStoreMock = create(() => ({
    fields: { 'acct-1': [OWNER, PRIORITY] },
    fieldsFor(accountId) { return this.fields[accountId] || []; },
    loadFields: vi.fn(async () => []),
    saveField: vi.fn(async () => ({})),
    deleteField: vi.fn(async () => {}),
    copyFields: vi.fn(async () => []),
  }));
});
afterEach(cleanup);

describe('the custom field editor', () => {
  it('lists the fields this account can use and says which are shared', () => {
    render(<FieldsSettings />);
    expect(screen.getByTestId('field-row-f1').textContent).toContain('Priority');
    expect(screen.getByTestId('field-row-g1').textContent).toContain('fields.scope.global');
  });

  it('adds a field of the chosen kind to this account', () => {
    render(<FieldsSettings />);
    fireEvent.change(screen.getByTestId('new-field-name'), { target: { value: 'Needs invoice' } });
    fireEvent.change(screen.getByTestId('new-field-kind'), { target: { value: 'checkbox' } });
    fireEvent.submit(screen.getByTestId('new-field-form'));
    const [accountId, field] = useFieldStoreMock.getState().saveField.mock.calls[0];
    expect(accountId).toBe('acct-1');
    expect(field.name).toBe('Needs invoice');
    expect(field.kind).toBe('checkbox');
    expect(field.scope).toBe('acct-1');
    expect(field.id).toBeTruthy();
  });

  it('will not add a field with no name', () => {
    render(<FieldsSettings />);
    fireEvent.submit(screen.getByTestId('new-field-form'));
    expect(useFieldStoreMock.getState().saveField).not.toHaveBeenCalled();
  });

  it('shares a field with every account, and takes it back', () => {
    render(<FieldsSettings />);
    fireEvent.click(screen.getByTestId('field-scope-f1'));
    expect(useFieldStoreMock.getState().saveField.mock.calls[0][1].scope).toBe('*');
    fireEvent.click(screen.getByTestId('field-scope-g1'));
    expect(useFieldStoreMock.getState().saveField.mock.calls[1][1].scope).toBe('acct-1');
  });

  it('deletes a field only after the count of values is confirmed', () => {
    render(<FieldsSettings />);
    fireEvent.click(screen.getByTestId('field-delete-f1'));
    expect(useFieldStoreMock.getState().deleteField).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('field-delete-confirm-f1'));
    expect(useFieldStoreMock.getState().deleteField).toHaveBeenCalledWith('acct-1', 'f1');
  });

  it('copies another account’s fields into this one', () => {
    useFieldStoreMock.setState({ fields: { 'acct-1': [PRIORITY], 'acct-2': [{ ...PRIORITY, id: 'x1', name: 'Client', scope: 'acct-2' }] } });
    render(<FieldsSettings />);
    fireEvent.change(screen.getByTestId('copy-from-account'), { target: { value: 'acct-2' } });
    fireEvent.click(screen.getByTestId('copy-field-x1'));
    fireEvent.click(screen.getByTestId('copy-fields-run'));
    expect(useFieldStoreMock.getState().copyFields).toHaveBeenCalledWith(['x1'], 'acct-1');
  });
});
