// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('lucide-react', () => {
  const icon = (name) => props => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name)), has: () => true });
});
vi.mock('../../i18n/index.js', () => ({ t: key => key, useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }));

let useMailStoreMock;
let useFieldStoreMock;
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign(selector => useMailStoreMock(selector), { getState: () => useMailStoreMock.getState() }),
}));
vi.mock('../../stores/slices/unifiedHelpers', () => ({
  resolveEmailLocation: (email) => (email?._mailbox ? { accountId: 'acct-1', mailbox: email._mailbox } : null),
}));
const requestRowValues = vi.fn();
const requestSchema = vi.fn();
vi.mock('../../stores/fieldStore', () => ({
  useFieldStore: Object.assign(selector => useFieldStoreMock(selector), { getState: () => useFieldStoreMock.getState() }),
  requestRowValues: (...args) => requestRowValues(...args),
  requestSchema: (...args) => requestSchema(...args),
  fieldRowKey: (a, m, u) => `${a}|${m}|${u}`,
}));

const { FieldStrip } = await import('../FieldStrip');

const PRIORITY = {
  id: 'f1', scope: 'acct-1', name: 'Priority', kind: 'select', position: 1,
  options: [{ id: 'hi', label: 'High' }, { id: 'lo', label: 'Low' }],
};
const DONE = { id: 'f2', scope: 'acct-1', name: 'Done', kind: 'checkbox', position: 2, options: [] };
const OWNER = { id: 'g1', scope: '*', name: 'Owner', kind: 'text', position: 0, options: [] };
const TAGS = {
  id: 'f3', scope: 'acct-1', name: 'Tags', kind: 'multi_select', position: 3,
  options: [{ id: 'red', label: 'Red', color: '#ff0000' }, { id: 'blue', label: 'Blue', color: '' }],
};

const email = { uid: 7, messageId: '<abc@x>', _mailbox: 'INBOX' };

beforeEach(() => {
  requestRowValues.mockReset();
  requestSchema.mockReset();
  useMailStoreMock = create(() => ({ activeAccountId: 'acct-1' }));
  useFieldStoreMock = create(() => ({
    fields: { 'acct-1': [OWNER, PRIORITY, DONE] },
    byRow: { 'acct-1|INBOX|7': { f1: 'hi' } },
    fieldsFor(accountId) { return this.fields[accountId] || []; },
    loadFields: vi.fn(async () => []),
    setValue: vi.fn(async () => true),
  }));
});
afterEach(cleanup);

describe('the property strip in the reader', () => {
  it('shows every field the account has, global ones first', () => {
    render(<FieldStrip email={email} />);
    const names = screen.getAllByTestId(/^field-name-/).map(node => node.textContent);
    expect(names).toEqual(['Owner', 'Priority', 'Done']);
  });

  it('shows the value this message already holds', () => {
    render(<FieldStrip email={email} />);
    expect(screen.getByTestId('field-input-f1').value).toBe('hi');
  });

  it('stores a value the moment it is chosen', () => {
    render(<FieldStrip email={email} />);
    fireEvent.change(screen.getByTestId('field-input-f1'), { target: { value: 'lo' } });
    expect(useFieldStoreMock.getState().setValue).toHaveBeenCalledWith(
      email, { accountId: 'acct-1', mailbox: 'INBOX' }, 'f1', 'lo',
    );
  });

  it('clears a value when the empty choice is picked', () => {
    render(<FieldStrip email={email} />);
    fireEvent.change(screen.getByTestId('field-input-f1'), { target: { value: '' } });
    expect(useFieldStoreMock.getState().setValue).toHaveBeenCalledWith(
      email, { accountId: 'acct-1', mailbox: 'INBOX' }, 'f1', null,
    );
  });

  it('a checkbox stores true and false, not a missing value', () => {
    render(<FieldStrip email={email} />);
    fireEvent.click(screen.getByTestId('field-input-f2'));
    expect(useFieldStoreMock.getState().setValue).toHaveBeenCalledWith(
      email, { accountId: 'acct-1', mailbox: 'INBOX' }, 'f2', true,
    );
  });

  it('asks for this row’s values once', () => {
    render(<FieldStrip email={email} />);
    expect(requestRowValues).toHaveBeenCalledWith(email, { accountId: 'acct-1', mailbox: 'INBOX' });
  });

  it('renders nothing when the account has no fields', () => {
    useFieldStoreMock.setState({ fields: {} });
    const { container } = render(<FieldStrip email={email} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing for a message whose folder cannot be resolved', () => {
    const { container } = render(<FieldStrip email={{ uid: 7 }} />);
    expect(container.textContent).toBe('');
  });

  it('repaints when the value for the row arrives after it mounted', () => {
    useFieldStoreMock.setState({ byRow: {} });
    render(<FieldStrip email={email} />);
    expect(screen.getByTestId('field-input-f1').value).toBe('');
    act(() => { useFieldStoreMock.setState({ byRow: { 'acct-1|INBOX|7': { f1: 'lo' } } }); });
    expect(screen.getByTestId('field-input-f1').value).toBe('lo');
  });

  /// A colour is the whole point of a choice at a glance: the chip has to
  /// carry it, not just the editor that set it.
  it('a chosen choice of a multi-select renders in its own colour', () => {
    useFieldStoreMock.setState({
      fields: { 'acct-1': [TAGS] },
      byRow: { 'acct-1|INBOX|7': { f3: ['red'] } },
    });
    render(<FieldStrip email={email} />);
    const chosen = screen.getByTestId('field-input-f3').querySelectorAll('label.is-chosen');
    expect(chosen).toHaveLength(1);
    expect(chosen[0].style.getPropertyValue('--tag-color')).toBe('#ff0000');
  });

  it('a select shows a swatch for the choice it is holding', () => {
    const COLOURED = { ...PRIORITY, options: [{ id: 'hi', label: 'High', color: '#0000ff' }] };
    useFieldStoreMock.setState({ fields: { 'acct-1': [COLOURED] }, byRow: { 'acct-1|INBOX|7': { f1: 'hi' } } });
    const { container } = render(<FieldStrip email={email} />);
    expect(container.querySelector('.field-swatch').style.getPropertyValue('--tag-color')).toBe('#0000ff');
  });

  /// A unified list holds messages from accounts whose schema was never asked
  /// for. Rendering nothing for them looks like "this account has no fields".
  it('asks for a schema it has not got', () => {
    useFieldStoreMock.setState({ fields: { 'acct-2': [PRIORITY] } });
    render(<FieldStrip email={email} />);
    expect(requestSchema).toHaveBeenCalledWith('acct-1');
  });
});
