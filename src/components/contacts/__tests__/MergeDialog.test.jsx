// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('../../ui/Dialog', async () => {
  const React = await import('react');
  return {
    Dialog: ({ open, title, children, footer }) => (open
      ? React.createElement('div', { role: 'dialog' }, React.createElement('h3', null, title), children, footer)
      : null),
  };
});
const h = vi.hoisted(() => ({ s: null, fresh: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.fresh = () => ({
    previewMerge: vi.fn(async (ids, keepId) => ({
      id: keepId,
      displayName: keepId === 'a' ? 'Amy' : 'Bob',
      emails: [{ address: 'amy@x.io' }, { address: 'bob@x.io' }],
      phones: [{ number: '+100' }],
    })),
    merge: vi.fn(async () => ({ id: 'a' })),
    searchPeople: vi.fn(async () => [
      { id: 'a', displayName: 'Amy', primaryEmail: 'amy@x.io' },
      { id: 'b', displayName: 'Bob', primaryEmail: 'bob@x.io' },
    ]),
    fetchCard: vi.fn(async (id) => ({ id, displayName: id === 'a' ? 'Amy' : 'Bob', emails: [] })),
  });
  h.s = create(() => h.fresh());
  return { usePeopleStore: h.s };
});
import { MergeDialog } from '../MergeDialog';

beforeEach(() => h.s.setState(h.fresh(), true));
afterEach(cleanup);

describe('MergeDialog', () => {
  it('previews the merge on open and shows the resulting name and every email', async () => {
    render(<MergeDialog ids={['a', 'b']} onClose={() => {}} />);
    expect(await screen.findByTestId('merge-preview-name')).toBeTruthy();
    expect(h.s.getState().previewMerge).toHaveBeenCalledWith(['a', 'b'], 'a');
    expect(screen.getByTestId('merge-preview-name').textContent).toBe('Amy');
    expect(screen.getAllByTestId('merge-preview-email').map((n) => n.textContent)).toEqual(['amy@x.io', 'bob@x.io']);
    expect(screen.getByTestId('merge-preview-phone').textContent).toBe('+100');
    expect(screen.queryByTestId('merge-search')).toBeNull();
  });

  it('shows the note that nothing changes outside MailVault', () => {
    render(<MergeDialog ids={['a', 'b']} onClose={() => {}} />);
    expect(screen.getByText('contacts.merge.note')).toBeTruthy();
  });

  it('labels the radios with the contact names and previews again when the keep choice changes', async () => {
    render(<MergeDialog ids={['a', 'b']} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Bob')).toBeTruthy());
    expect(screen.getByTestId('merge-keep-a').checked).toBe(true);
    fireEvent.click(screen.getByTestId('merge-keep-b'));
    await waitFor(() => expect(h.s.getState().previewMerge).toHaveBeenLastCalledWith(['a', 'b'], 'b'));
    await waitFor(() => expect(screen.getByTestId('merge-preview-name').textContent).toBe('Bob'));
  });

  it('Confirm merges with the chosen keeper, then closes', async () => {
    const onClose = vi.fn();
    render(<MergeDialog ids={['a', 'b']} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('merge-keep-b'));
    fireEvent.click(screen.getByTestId('merge-confirm'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.s.getState().merge).toHaveBeenCalledWith(['a', 'b'], 'b');
  });

  it('Cancel closes without ever merging', async () => {
    const onClose = vi.fn();
    render(<MergeDialog ids={['a', 'b']} onClose={onClose} />);
    await screen.findByTestId('merge-preview-name');
    fireEvent.click(screen.getByTestId('merge-cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(h.s.getState().merge).not.toHaveBeenCalled();
  });

  it('opened with one contact it offers a search for the second, without the contact itself', async () => {
    render(<MergeDialog ids={['a']} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bob' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Amy' })).toBeNull();
    expect(h.s.getState().previewMerge).not.toHaveBeenCalled();
    expect(screen.getByTestId('merge-confirm').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('merge-search'), { target: { value: 'bo' } });
    await waitFor(() => expect(h.s.getState().searchPeople).toHaveBeenLastCalledWith('bo'));
  });

  it('picking the second contact previews the pair and enables Confirm', async () => {
    render(<MergeDialog ids={['a']} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Bob' })).toBeTruthy());
    fireEvent.change(screen.getByTestId('merge-other'), { target: { value: 'b' } });
    await waitFor(() => expect(h.s.getState().previewMerge).toHaveBeenCalledWith(['a', 'b'], 'a'));
    expect(screen.getByTestId('merge-confirm').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('merge-confirm'));
    await waitFor(() => expect(h.s.getState().merge).toHaveBeenCalledWith(['a', 'b'], 'a'));
  });
});
