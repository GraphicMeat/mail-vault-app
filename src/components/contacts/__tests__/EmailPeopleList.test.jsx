// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
const h = vi.hoisted(() => ({ people: null, view: null, freshPeople: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.freshPeople = () => ({
    selectedId: null, sender: null, items: [], select: vi.fn(), selectSender: vi.fn(),
    owners: vi.fn(async () => ({ 'amy@x.io': { personId: 'p1', favorite: true } })),
  });
  h.people = create(() => h.freshPeople());
  return { usePeopleStore: h.people };
});
vi.mock('../../../stores/contactsViewStore', async () => {
  const { create } = await import('zustand');
  h.view = create(() => ({
    participants: [
      { address: 'amy@x.io', name: 'Amy', role: 'from' },
      { address: 'bo@x.io', name: 'Bo', role: 'to' },
      { address: 'cy@x.io', name: '', role: 'cc' },
    ],
  }));
  return { useContactsViewStore: h.view };
});
import { EmailPeopleList } from '../EmailPeopleList';

beforeEach(() => h.people.setState(h.freshPeople(), true));
afterEach(cleanup);

describe('EmailPeopleList', () => {
  it('groups participants under From, To and Cc', async () => {
    render(<EmailPeopleList />);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((e) => e.textContent);
    expect(headings).toEqual(['common.from', 'common.to', 'contacts.role.cc']);
    await waitFor(() => expect(h.people.getState().owners).toHaveBeenCalled());
    expect(screen.getByTestId('email-person-cy@x.io').textContent).toContain('cy@x.io');
  });

  it('resolves owners once and selects a saved participant by id', async () => {
    render(<EmailPeopleList />);
    await waitFor(() => expect(screen.getByTestId('email-person-amy@x.io').querySelector('[data-testid="row-favorite"]')).toBeTruthy());
    expect(h.people.getState().owners).toHaveBeenCalledTimes(1);
    expect(h.people.getState().owners).toHaveBeenCalledWith(['amy@x.io', 'bo@x.io', 'cy@x.io']);
    h.people.getState().select.mockClear();
    fireEvent.click(screen.getByTestId('email-person-amy@x.io'));
    expect(h.people.getState().select).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByTestId('email-person-bo@x.io'));
    expect(h.people.getState().selectSender).toHaveBeenCalledWith(expect.objectContaining({ address: 'bo@x.io' }));
  });

  it('selects the first participant on mount', async () => {
    render(<EmailPeopleList />);
    await waitFor(() => expect(h.people.getState().select).toHaveBeenCalledWith('p1'));
  });

  it('keeps an existing selection', async () => {
    h.people.setState({ selectedId: 'p5' });
    render(<EmailPeopleList />);
    await waitFor(() => expect(h.people.getState().owners).toHaveBeenCalled());
    await Promise.resolve();
    expect(h.people.getState().select).not.toHaveBeenCalled();
    expect(h.people.getState().selectSender).not.toHaveBeenCalled();
  });
});
