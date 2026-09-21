// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('../../stores/fieldStore', () => ({
  useFieldStore: Object.assign(selector => useFieldStoreMock(selector), { getState: () => useFieldStoreMock.getState() }),
  requestRowValues: (...args) => requestRowValues(...args),
  fieldRowKey: (a, m, u) => `${a}|${m}|${u}`,
}));

const { FieldStrip } = await import('../FieldStrip');

const PRIORITY = {
  id: 'f1', scope: 'acct-1', name: 'Priority', kind: 'select', position: 1,
  options: [{ id: 'hi', label: 'High' }, { id: 'lo', label: 'Low' }],
};
const DONE = { id: 'f2', scope: 'acct-1', name: 'Done', kind: 'checkbox', position: 2, options: [] };
const OWNER = { id: 'g1', scope: '*', name: 'Owner', kind: 'text', position: 0, options: [] };

const email = { uid: 7, messageId: '<abc@x>', _mailbox: 'INBOX' };

beforeEach(() => {
  requestRowValues.mockReset();
  useMailStoreMock = create(() => ({ activeAccountId: 'acct-1' }));
  useFieldStoreMock = create(() => ({
    fields: { 'acct-1': [OWNER, PRIORITY, DONE] },
    byRow: { 'acct-1|INBOX|7': { f1: 'hi' } },
    fieldsFor(accountId) { return this.fields[accountId] || []; },
    valuesFor() { return this.byRow['acct-1|INBOX|7'] || {}; },
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
});
