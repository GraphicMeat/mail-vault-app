// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const harness = vi.hoisted(() => ({
  openInsightsMessage: vi.fn(),
  cancelInsightsSelection: vi.fn(),
  openLink: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../../../services/workflows/openInsightsMessage', () => ({
  openInsightsMessage: (...args) => harness.openInsightsMessage(...args),
}));
// Partial: the stores this board loads for real import other names from these.
vi.mock('../../../services/workflows/selectEmail', async importOriginal => ({
  ...await importOriginal(),
  cancelInsightsSelection: (...args) => harness.cancelInsightsSelection(...args),
}));
vi.mock('../../../utils/editorLinks', async importOriginal => ({
  ...await importOriginal(),
  openLink: (...args) => harness.openLink(...args),
}));
vi.mock('../../../services/transport', async importOriginal => ({
  ...await importOriginal(),
  send: (...args) => harness.send(...args),
}));
vi.mock('../../EmailViewer', () => ({ EmailViewer: () => React.createElement('div', { 'data-testid': 'email-viewer' }) }));
// The real confirm is its own component with its own tests; here it only has
// to prove a delete waits for it.
vi.mock('../../DeleteConfirmModal', () => ({
  DeleteConfirmModal: ({ pending, onClose }) => (pending ? React.createElement('button', {
    'data-testid': 'confirm-delete',
    onClick: () => { onClose(); pending.executor(); },
  }, pending.copy.title) : null),
}));

const { default: NotesBoard } = await import('../NotesBoard');
const { useNotesStore } = await import('../../../stores/notesStore');
const { useMailStore } = await import('../../../stores/mailStore');
const { t } = await import('../../../i18n');

const ACCOUNTS_PAYLOAD = [
  { accountId: 'a', address: 'me@x.test', knownMailboxes: ['INBOX', 'Sent'] },
  { accountId: 'b', address: 'work@y.test', knownMailboxes: ['INBOX'] },
];

const card = (key, extra = {}) => ({
  key,
  copies: [
    { accountId: 'a', mailbox: 'INBOX', uid: 11, messageId: `<${key}@x.test>` },
    { accountId: 'a', mailbox: 'Sent', uid: 21, messageId: `<${key}@x.test>` },
  ],
  subject: `Subject ${key}`,
  snippet: `Snippet ${key}`,
  date: 1_790_000_000,
  accountId: 'a',
  column: 'Notes',
  links: [],
  attachments: [],
  starred: false,
  done: false,
  ...extra,
});

const actions = {
  load: vi.fn(),
  toggleStar: vi.fn(async () => {}),
  markDone: vi.fn(async () => {}),
  deleteCard: vi.fn(async () => {}),
};

function show(cards, extra = {}) {
  useNotesStore.setState({ isOpen: true, status: 'ready', cards, filter: '', detailOpen: false, busy: {}, accounts: ACCOUNTS_PAYLOAD, ...actions, ...extra });
  const onClose = vi.fn();
  render(<NotesBoard onClose={onClose} />);
  return { onClose };
}

const columnNames = () => screen.getAllByTestId('notes-column').map(column => column.getAttribute('aria-label'));
const cardKeys = column => within(column).getAllByTestId('note-card').map(el => el.dataset.key);

beforeEach(() => {
  Object.values(harness).forEach(fn => fn.mockReset());
  Object.values(actions).forEach(fn => fn.mockClear());
  harness.openInsightsMessage.mockResolvedValue(true);
  harness.openLink.mockResolvedValue(true);
  harness.send.mockResolvedValue('aGVsbG8=');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
  useMailStore.setState({ accounts: [{ id: 'a', email: 'me@x.test' }, { id: 'b', email: 'work@y.test' }] });
});
afterEach(cleanup);

describe('Notes to Self board', () => {
  it('draws tag columns A to Z, then Links, Files, Photos, Notes, and no empty column', () => {
    show([
      card('n', { column: 'Notes' }),
      card('p', { column: 'Photos' }),
      card('r', { column: 'Recipes' }),
      card('l', { column: 'Links' }),
      card('b', { column: 'Books' }),
    ]);
    expect(columnNames()).toEqual(['Books', 'Recipes', t('notes.column.links'), t('notes.column.photos'), t('notes.column.notes')]);
    expect(columnNames()).not.toContain(t('notes.column.files'));
  });

  it('shows a card with its subject, a clamped snippet, link domains, attachments, a photo, the date and its account', async () => {
    show([card('c', {
      subject: 'Pasta',
      snippet: 'line one\nline two\nline three\nline four',
      column: 'Recipes',
      links: ['https://www.example.com/a', 'https://example.com/b', 'http://docs.test/x'],
      attachments: [{ name: 'plan.pdf', mime: 'application/pdf', partIndex: 0 }, { name: 'dish.png', mime: 'image/png', partIndex: 1 }],
    })]);
    const el = screen.getByTestId('note-card');
    expect(within(el).getByTestId('note-subject').textContent).toBe('Pasta');
    expect(within(el).getByTestId('note-snippet').className).toContain('line-clamp-3');
    expect(within(el).getAllByTestId('note-domain').map(chip => chip.textContent)).toEqual(['example.com', 'docs.test']);
    expect(within(el).getAllByTestId('note-attachment').map(item => item.textContent)).toEqual(['plan.pdf', 'dish.png']);
    const thumb = await within(el).findByTestId('note-thumb');
    expect(thumb.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    // Local only: a preview never downloads a message from the server.
    expect(harness.send).toHaveBeenCalledWith('maildir_read_attachment', { accountId: 'a', mailbox: 'INBOX', uid: 11, attachmentIndex: 1, localOnly: true });
    expect(el.querySelector('time').getAttribute('datetime')).toBe(new Date(1_790_000_000 * 1000).toISOString());
    expect(within(el).getByTestId('note-account-dot').getAttribute('aria-label')).toBe('me@x.test');
  });

  it('puts starred cards first in their column', () => {
    show([
      card('new', { date: 300 }),
      card('starred', { date: 100, starred: true }),
      card('mid', { date: 200 }),
    ]);
    expect(cardKeys(screen.getByTestId('notes-column'))).toEqual(['starred', 'new', 'mid']);
  });

  it('opens the first copy of a card in the reader beside the board', async () => {
    show([card('o')]);
    await act(async () => { fireEvent.click(screen.getByTestId('note-card')); });
    expect(harness.openInsightsMessage).toHaveBeenCalledTimes(1);
    const [match] = harness.openInsightsMessage.mock.calls[0];
    expect(match.copies[0]).toMatchObject({ accountId: 'a', mailbox: 'INBOX', uid: 11, source: 'vault' });
    expect(match.copies.every(copy => copy.uid === 11)).toBe(true);
    expect(useNotesStore.getState().detailOpen).toBe(true);
    expect(screen.getByTestId('email-viewer')).toBeTruthy();
  });

  it('copies and opens the first link without opening the card', async () => {
    show([card('k', { column: 'Links', links: ['https://one.test/a', 'https://two.test/b'] })]);
    await act(async () => { fireEvent.click(screen.getByTestId('note-copy-link')); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://one.test/a');
    await act(async () => { fireEvent.click(screen.getByTestId('note-open-link')); });
    expect(harness.openLink).toHaveBeenCalledWith('https://one.test/a');
    expect(harness.openInsightsMessage).not.toHaveBeenCalled();
  });

  it('stars, finishes and deletes a card through the store, delete only after its confirm', async () => {
    const note = card('act');
    show([note]);
    await act(async () => { fireEvent.click(screen.getByTestId('note-star')); });
    expect(actions.toggleStar).toHaveBeenCalledWith(note);
    await act(async () => { fireEvent.click(screen.getByTestId('note-done')); });
    expect(actions.markDone).toHaveBeenCalledWith(note);
    fireEvent.click(screen.getByTestId('note-delete'));
    expect(actions.deleteCard).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-delete')); });
    expect(actions.deleteCard).toHaveBeenCalledWith(note);
    expect(harness.openInsightsMessage).not.toHaveBeenCalled();
  });

  it('shows no preview when this computer holds no copy, only the file name', async () => {
    harness.send.mockRejectedValue(new Error('Email UID 11 not found'));
    show([card('p', { column: 'Photos', attachments: [{ name: 'dish.png', mime: 'image/png', partIndex: 0 }] })]);
    await waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('note-thumb')).toBeNull();
    expect(screen.getByTestId('note-attachment').textContent).toBe('dish.png');
  });

  it('holds a card\'s buttons while one of its actions runs', () => {
    show([card('busy')], { busy: { busy: true } });
    expect(screen.getByTestId('note-star').disabled).toBe(true);
    expect(screen.getByTestId('note-done').disabled).toBe(true);
    expect(screen.getByTestId('note-delete').disabled).toBe(true);
  });

  it('says a copy was kept when a delete could not reach every copy', async () => {
    actions.deleteCard.mockResolvedValueOnce({ deleted: 1, kept: 1 });
    show([card('part')]);
    fireEvent.click(screen.getByTestId('note-delete'));
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-delete')); });
    expect(screen.getByRole('alert').textContent).toBe(t('notes.deletePartial'));
  });

  it('cannot unstar a starred note while one of its copies is out of reach', () => {
    show([card('half', { starred: true, copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 11 },
      { accountId: 'a', mailbox: 'vault-only', uid: 12 },
    ] })]);
    expect(screen.getByTestId('note-star').disabled).toBe(true);
    expect(screen.getByTestId('note-delete').disabled).toBe(false);
  });

  it('offers no star or delete for a note whose folders the server does not have', () => {
    show([card('local', { copies: [{ accountId: 'a', mailbox: 'vault-only', uid: 5 }] })]);
    expect(screen.getByTestId('note-star').disabled).toBe(true);
    expect(screen.getByTestId('note-delete').disabled).toBe(true);
    expect(screen.getByTestId('note-done').disabled).toBe(false);
  });

  it('narrows the board as the filter is typed', () => {
    show([
      card('a', { subject: 'Pasta recipe', column: 'Recipes' }),
      card('b', { subject: 'Flight', snippet: 'gate B12', column: 'Links' }),
    ]);
    fireEvent.change(screen.getByTestId('notes-filter'), { target: { value: 'gate' } });
    expect(screen.getAllByTestId('note-card').map(el => el.dataset.key)).toEqual(['b']);
    fireEvent.change(screen.getByTestId('notes-filter'), { target: { value: 'nothing at all' } });
    expect(screen.queryAllByTestId('note-card')).toEqual([]);
    expect(screen.getByTestId('notes-no-matches')).toBeTruthy();
  });

  it('focuses the filter on / and moves between cards with the arrow keys', () => {
    show([
      card('r1', { column: 'Recipes', date: 300 }),
      card('r2', { column: 'Recipes', date: 200 }),
      card('n1', { column: 'Notes', date: 100 }),
    ]);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByTestId('notes-filter'));

    const [r1, r2, n1] = ['r1', 'r2', 'n1'].map(key => screen.getAllByTestId('note-card').find(el => el.dataset.key === key));
    act(() => r1.focus());
    fireEvent.keyDown(r1, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(r2);
    fireEvent.keyDown(r2, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(n1);
    fireEvent.keyDown(n1, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(r1);
  });

  it('explains itself and names the addresses to write to when there are no notes', () => {
    show([]);
    expect(screen.getByTestId('notes-empty').textContent).toContain(t('notes.empty'));
    expect(within(screen.getByTestId('notes-addresses')).getAllByRole('listitem').map(li => li.textContent))
      .toEqual(['me@x.test', 'work@y.test']);
  });

  it('returns to the mail view from the back button and from Escape', () => {
    const { onClose } = show([card('x')]);
    fireEvent.click(screen.getByTestId('notes-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId('notes-board'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes the reader before the board on Escape', async () => {
    const { onClose } = show([card('x')]);
    await act(async () => { fireEvent.click(screen.getByTestId('note-card')); });
    fireEvent.keyDown(screen.getByTestId('notes-board'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('email-viewer')).toBeNull());
    expect(harness.cancelInsightsSelection).toHaveBeenCalled();
  });
});
