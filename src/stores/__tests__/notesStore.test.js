import { describe, it, expect, vi, beforeEach } from 'vitest';

const harness = vi.hoisted(() => ({
  daemonCall: vi.fn(),
  applyFlagToTargets: vi.fn(),
  deleteEmailFromServer: vi.fn(),
  setDeleteUndo: vi.fn(),
  vaultApplyFlags: vi.fn(),
  mailState: null,
  cacheMailboxes: {},
  savedMailboxes: {},
}));

vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../mailStore', () => ({ useMailStore: { getState: () => harness.mailState } }));
vi.mock('../../services/cacheManager', () => ({
  getAccountCacheMailboxes: id => harness.cacheMailboxes[id] || [],
}));
// The folder list a past session saved: what the sidebar restores from.
vi.mock('../../services/db', () => ({
  getCachedMailboxes: async id => harness.savedMailboxes[id] ?? null,
}));
vi.mock('../../services/api', () => ({
  vaultApplyFlags: (...args) => harness.vaultApplyFlags(...args),
}));
vi.mock('../../services/workflows/messageMutations', () => ({
  applyFlagToTargets: (...args) => harness.applyFlagToTargets(...args),
  deleteEmailFromServer: (...args) => harness.deleteEmailFromServer(...args),
  setDeleteUndo: (...args) => harness.setDeleteUndo(...args),
}));

const { useNotesStore, boardColumns, serverCopies, canToggleStar, AUTO_COLUMNS } = await import('../notesStore');
const { useTagStore } = await import('../tagStore');
const { useSettingsStore } = await import('../settingsStore');

const card = (key, extra = {}) => ({
  key,
  copies: [{ accountId: 'a', mailbox: 'INBOX', uid: 1, messageId: `<${key}@x.test>` }],
  subject: `subject ${key}`,
  snippet: '',
  date: 1_790_000_000,
  accountId: 'a',
  column: 'Notes',
  links: [],
  attachments: [],
  starred: false,
  done: false,
  ...extra,
});

beforeEach(() => {
  harness.daemonCall.mockReset().mockResolvedValue({ cards: [] });
  harness.applyFlagToTargets.mockReset().mockResolvedValue(undefined);
  harness.deleteEmailFromServer.mockReset().mockResolvedValue(undefined);
  harness.setDeleteUndo.mockReset().mockResolvedValue(undefined);
  harness.vaultApplyFlags.mockReset().mockResolvedValue({ renamed: 1 });
  harness.cacheMailboxes = {
    a: [{ path: 'INBOX', name: 'INBOX' }, { path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' }],
    b: [{ path: 'INBOX', name: 'INBOX' }],
    c: [{ path: 'INBOX', name: 'INBOX' }],
  };
  harness.savedMailboxes = {};
  harness.mailState = {
    accounts: [
      { id: 'a', email: 'me@x.test' },
      { id: 'b', email: 'work@y.test' },
      { id: 'c', email: 'hidden@z.test' },
    ],
    activeAccountId: 'a',
    activeMailbox: 'INBOX',
    mailboxes: [],
    setUndo: vi.fn(),
  };
  useSettingsStore.setState({ hiddenAccounts: { c: true } });
  useNotesStore.getState().close();
});

describe('boardColumns', () => {
  it('orders tag columns A to Z, then Links, Files, Photos, Notes, and leaves out empty ones', () => {
    const cards = [
      card('n', { column: 'Notes' }),
      card('p', { column: 'Photos' }),
      card('r', { column: 'Recipes' }),
      card('l', { column: 'Links' }),
      card('b', { column: 'Books' }),
    ];
    expect(boardColumns(cards).map(column => column.name)).toEqual(['Books', 'Recipes', 'Links', 'Photos', 'Notes']);
    expect(AUTO_COLUMNS).toEqual(['Links', 'Files', 'Photos', 'Notes']);
    expect(boardColumns(cards).find(column => column.name === 'Books').auto).toBe(false);
    expect(boardColumns(cards).find(column => column.name === 'Links').auto).toBe(true);
    expect(boardColumns([])).toEqual([]);
  });

  it('puts starred cards first in their column, then the newest', () => {
    const cards = [
      card('old', { date: 100 }),
      card('new', { date: 300 }),
      card('starred-old', { date: 50, starred: true }),
      card('mid', { date: 200 }),
    ];
    expect(boardColumns(cards)[0].cards.map(c => c.key)).toEqual(['starred-old', 'new', 'mid', 'old']);
  });

  it('narrows by subject or snippet, ignoring case, and drops columns left empty', () => {
    const cards = [
      card('a', { subject: 'Pasta recipe', column: 'Recipes' }),
      card('b', { subject: 'Flight', snippet: 'Seat 12A, gate B', column: 'Links' }),
      card('c', { subject: 'Other', column: 'Notes' }),
    ];
    expect(boardColumns(cards, 'PASTA').map(column => column.name)).toEqual(['Recipes']);
    expect(boardColumns(cards, 'gate b').flatMap(column => column.cards.map(c => c.key))).toEqual(['b']);
    expect(boardColumns(cards, '   ').length).toBe(3);
    expect(boardColumns(cards, 'nothing like it')).toEqual([]);
  });
});

describe('useNotesStore', () => {
  it('asks notes.list with every visible account, folders included, and never a hidden one', async () => {
    harness.daemonCall.mockResolvedValue({ cards: [card('x')] });
    await useNotesStore.getState().open();
    expect(harness.daemonCall).toHaveBeenCalledTimes(1);
    const [method, params] = harness.daemonCall.mock.calls[0];
    expect(method).toBe('notes.list');
    expect(params.accounts).toEqual([
      expect.objectContaining({ accountId: 'a', address: 'me@x.test', knownMailboxes: ['INBOX', '[Gmail]/Sent Mail'] }),
      expect.objectContaining({ accountId: 'b', address: 'work@y.test', knownMailboxes: ['INBOX'] }),
    ]);
    expect(useNotesStore.getState()).toMatchObject({ isOpen: true, status: 'ready' });
    expect(useNotesStore.getState().cards.map(c => c.key)).toEqual(['x']);
  });

  /// The report: star and delete did nothing on a second account's notes.
  /// Its folders were only ever looked up in this session's memory, which
  /// holds an account once it has been opened; the list saved last time is
  /// on disk, and the daemon names a copy's folder from what it is given.
  it('names the folders of an account not opened this session from the saved list, before asking', async () => {
    harness.cacheMailboxes.b = null;
    harness.savedMailboxes.b = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Projects', name: 'Projects', children: [{ path: 'Projects/2026', name: '2026' }] },
    ];
    const note = card('b-note', { accountId: 'b', copies: [{ accountId: 'b', mailbox: 'Projects/2026', uid: 4 }] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    const [, params] = harness.daemonCall.mock.calls[0];
    expect(params.accounts.find(account => account.accountId === 'b').knownMailboxes).toEqual(['INBOX', 'Projects', 'Projects/2026']);
    const { accounts } = useNotesStore.getState();
    expect(serverCopies(note, accounts).map(copy => copy.uid)).toEqual([4]);
    expect(canToggleStar(note, accounts)).toBe(true);
  });

  it('never replaces a folder list this session already holds with the saved one', async () => {
    harness.savedMailboxes.a = [{ path: 'Old', name: 'Old' }];
    await useNotesStore.getState().open();
    const [, params] = harness.daemonCall.mock.calls[0];
    expect(params.accounts.find(account => account.accountId === 'a').knownMailboxes).toEqual(['INBOX', '[Gmail]/Sent Mail']);
  });

  it('says it could not load rather than showing an empty board', async () => {
    harness.daemonCall.mockRejectedValue(new Error('index unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useNotesStore.getState().open();
    expect(useNotesStore.getState().status).toBe('error');
    warn.mockRestore();
  });

  it('closing hides the board and a late answer does not bring cards back', async () => {
    let answer;
    harness.daemonCall.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    const opening = useNotesStore.getState().open();
    useNotesStore.getState().close();
    answer({ cards: [card('late')] });
    await opening;
    expect(useNotesStore.getState()).toMatchObject({ isOpen: false, cards: [] });
  });

  it('marks every copy done through notes.set_done and takes the card off the board', async () => {
    const note = card('d', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3, messageId: '<d@x.test>' },
      { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9, messageId: '<d@x.test>' },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note, card('keep')] });
    await useNotesStore.getState().open();
    harness.daemonCall.mockResolvedValue({ count: 2 });
    await useNotesStore.getState().markDone(note);
    expect(harness.daemonCall).toHaveBeenCalledWith('notes.set_done', { copies: note.copies, done: true });
    expect(useNotesStore.getState().cards.map(c => c.key)).toEqual(['keep']);
  });

  /// Refresh, then Done before the list answers: that list was read before
  /// the Done landed and still holds the card.
  it('a list already on its way when a note is finished does not bring it back', async () => {
    const note = card('d');
    harness.daemonCall.mockResolvedValue({ cards: [note, card('keep')] });
    await useNotesStore.getState().open();
    let answer;
    harness.daemonCall.mockImplementation(method => (method === 'notes.list'
      ? new Promise(resolve => { answer = resolve; })
      : Promise.resolve(method === 'tags.list' ? [] : { count: 1 })));
    const loading = useNotesStore.getState().load();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await useNotesStore.getState().markDone(note);
    answer({ cards: [note, card('keep')] });
    await loading;
    expect(useNotesStore.getState().cards.map(c => c.key)).toEqual(['keep']);
  });

  /// The first Done creates the tag: the tag list, its counts and any chips
  /// already cached for these copies must learn about it, or the user can
  /// neither see nor remove it.
  it('tells the tag store: reloads the tag list and drops the copies cached chips', async () => {
    const note = card('d', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3 },
      { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9 },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    useTagStore.setState({ tags: [], byRow: { 'a|INBOX|3': [], 'a|[Gmail]/Sent Mail|9': ['t1'], 'b|INBOX|1': ['t1'] } });
    const done = { id: 'done-id', name: 'Done', color: '' };
    harness.daemonCall.mockImplementation(async method => (method === 'tags.list' ? [done] : method === 'notes.set_done' ? { count: 2 } : {}));

    await useNotesStore.getState().markDone(note);

    expect(harness.daemonCall).toHaveBeenCalledWith('tags.list', {});
    expect(useTagStore.getState().tags).toEqual([done]);
    expect(useTagStore.getState().byRow).toEqual({ 'b|INBOX|1': ['t1'] });
  });

  /// Done takes a card off the board like a delete takes a row off the list,
  /// and it was the one card action with nothing to undo it.
  it('offers Done back: the undo takes the tag off every copy and puts the card back', async () => {
    const note = card('d', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3 },
      { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9 },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note, card('keep')] });
    await useNotesStore.getState().open();
    harness.daemonCall.mockImplementation(async method => (method === 'tags.list' ? [] : { count: 2 }));
    await useNotesStore.getState().markDone(note);
    expect(harness.mailState.setUndo).toHaveBeenCalledTimes(1);
    const [slot] = harness.mailState.setUndo.mock.calls[0];
    expect(slot.labelKey).toBe('undo.noteDone');

    useTagStore.setState({ byRow: { 'a|INBOX|3': ['done-id'], 'b|INBOX|1': ['t1'] } });
    harness.daemonCall.mockClear();
    await slot.run();

    expect(harness.daemonCall).toHaveBeenCalledWith('notes.set_done', { copies: note.copies, done: false });
    expect(harness.daemonCall).toHaveBeenCalledWith('tags.list', {});
    expect(useTagStore.getState().byRow).toEqual({ 'b|INBOX|1': ['t1'] });
    expect(useNotesStore.getState().cards.map(c => c.key).sort()).toEqual(['d', 'keep']);
  });

  it('an undone Done is not dropped by a list already on its way', async () => {
    const note = card('d');
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    let answer;
    harness.daemonCall.mockImplementation(method => (method === 'notes.list'
      ? new Promise(resolve => { answer = resolve; })
      : Promise.resolve(method === 'tags.list' ? [] : { count: 1 })));
    const loading = useNotesStore.getState().load();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await useNotesStore.getState().markDone(note);
    const [slot] = harness.mailState.setUndo.mock.calls[0];
    await slot.run();
    answer({ cards: [note] });
    await loading;
    expect(useNotesStore.getState().cards.map(c => c.key)).toEqual(['d']);
  });

  it('an undone Done with the board closed changes only the tag', async () => {
    const note = card('d');
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    harness.daemonCall.mockImplementation(async method => (method === 'tags.list' ? [] : { count: 1 }));
    await useNotesStore.getState().markDone(note);
    const [slot] = harness.mailState.setUndo.mock.calls[0];
    useNotesStore.getState().close();
    await slot.run();
    expect(harness.daemonCall).toHaveBeenCalledWith('notes.set_done', { copies: note.copies, done: false });
    expect(useNotesStore.getState().cards).toEqual([]);
  });

  const target = (accountId, mailbox, uid) => ({
    account: harness.mailState.accounts.find(account => account.id === accountId), accountId, mailbox, uid, named: true,
  });

  /// Each copy goes to the flag core as a target that names its own folder:
  /// the daemon listed it from the vault, which is the proof a list row
  /// gives that core. So the core writes the vault copy too, for the star
  /// and for its undo, and the store writes none of its own.
  it('stars every server copy as a target naming its own folder, and unstars a starred card', async () => {
    const note = card('s', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3, flags: ['\\Seen'] },
      { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9, flags: [] },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    await useNotesStore.getState().toggleStar(note);
    const both = [target('a', 'INBOX', 3), target('a', '[Gmail]/Sent Mail', 9)];
    expect(harness.applyFlagToTargets).toHaveBeenCalledWith(both, '\\Flagged', true);
    expect(harness.vaultApplyFlags).not.toHaveBeenCalled();
    expect(useNotesStore.getState().cards[0].starred).toBe(true);
    expect(useNotesStore.getState().cards[0].copies.map(copy => copy.flags)).toEqual([['\\Seen', '\\Flagged'], ['\\Flagged']]);

    await useNotesStore.getState().toggleStar(useNotesStore.getState().cards[0]);
    expect(harness.applyFlagToTargets).toHaveBeenLastCalledWith(both, '\\Flagged', false);
    expect(useNotesStore.getState().cards[0].starred).toBe(false);
    expect(useNotesStore.getState().cards[0].copies.map(copy => copy.flags)).toEqual([['\\Seen'], []]);
  });

  /// A copy the server cannot be asked about may be the flagged one: a star
  /// can go on through the others, but never come off while it is skipped.
  it('stars through the reachable copies but never unstars past a skipped one', async () => {
    const note = card('s', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3 },
      // A vault folder the server does not have: never addressed.
      { accountId: 'a', mailbox: 'Local-Only', uid: 4 },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    const accounts = useNotesStore.getState().accounts;
    expect(canToggleStar(note, accounts)).toBe(true);
    await useNotesStore.getState().toggleStar(note);
    expect(harness.applyFlagToTargets).toHaveBeenCalledWith([target('a', 'INBOX', 3)], '\\Flagged', true);

    const starred = useNotesStore.getState().cards[0];
    expect(canToggleStar(starred, accounts)).toBe(false);
    harness.applyFlagToTargets.mockClear();
    await useNotesStore.getState().toggleStar(starred);
    expect(harness.applyFlagToTargets).not.toHaveBeenCalled();
    expect(useNotesStore.getState().cards[0].starred).toBe(true);
  });

  it('puts the star back when the flag write fails', async () => {
    const note = card('s');
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    harness.applyFlagToTargets.mockRejectedValue(new Error('offline'));
    await expect(useNotesStore.getState().toggleStar(note)).rejects.toThrow('offline');
    expect(useNotesStore.getState().cards[0]).toEqual(note);
  });

  /// Whatever lands a flag on a copy on the board (its own star, the undo of
  /// one, a star from the list) reaches the card through here.
  it('repaints the cards holding a changed copy, and only those', async () => {
    const two = card('two', { starred: true, copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3, flags: ['\\Flagged'] },
      { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9, flags: ['\\Seen', '\\Flagged'] },
    ] });
    const one = card('one', { starred: true, copies: [{ accountId: 'b', mailbox: 'INBOX', uid: 3, flags: ['\\Flagged'] }] });
    harness.daemonCall.mockResolvedValue({ cards: [two, one] });
    await useNotesStore.getState().open();
    const before = useNotesStore.getState().cards;

    useNotesStore.getState().applyCopyFlag([{ accountId: 'a', mailbox: 'INBOX', uid: 3 }], '\\Flagged', false);
    const [twoAfter, oneAfter] = useNotesStore.getState().cards;
    // Still starred: the Sent copy keeps its star.
    expect(twoAfter.starred).toBe(true);
    expect(twoAfter.copies.map(copy => copy.flags)).toEqual([[], ['\\Seen', '\\Flagged']]);
    expect(oneAfter).toBe(before[1]);

    useNotesStore.getState().applyCopyFlag([{ accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9 }], '\\Flagged', false);
    expect(useNotesStore.getState().cards[0].starred).toBe(false);

    // A read change moves no star.
    useNotesStore.getState().applyCopyFlag([{ accountId: 'b', mailbox: 'INBOX', uid: 3 }], '\\Seen', true);
    expect(useNotesStore.getState().cards[1]).toMatchObject({ starred: true, copies: [{ flags: ['\\Flagged', '\\Seen'] }] });

    const cards = useNotesStore.getState().cards;
    useNotesStore.getState().applyCopyFlag([{ accountId: 'c', mailbox: 'INBOX', uid: 3 }], '\\Flagged', true);
    expect(useNotesStore.getState().cards).toBe(cards);
  });

  it('deletes every server copy through the server delete, then drops the card', async () => {
    const note = card('del', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3 },
      { accountId: 'b', mailbox: 'INBOX', uid: 7 },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note, card('keep')] });
    await useNotesStore.getState().open();
    await expect(useNotesStore.getState().deleteCard(note)).resolves.toEqual({ deleted: 2, kept: 0 });
    expect(harness.deleteEmailFromServer).toHaveBeenCalledWith(3, { accountId: 'a', mailboxOverride: 'INBOX', skipRefresh: true });
    expect(harness.deleteEmailFromServer).toHaveBeenCalledWith(7, { accountId: 'b', mailboxOverride: 'INBOX', skipRefresh: true });
    expect(useNotesStore.getState().cards.map(c => c.key)).toEqual(['keep']);
  });

  /// One delete per copy each filled the undo slot with its own copy, so the
  /// undo put back the last one only, and the Done tag the delete left kept
  /// the card off the board even for that one.
  it('offers one undo for every copy it deleted, which brings the card back', async () => {
    const note = card('del', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3 },
      { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9 },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note, card('keep')] });
    await useNotesStore.getState().open();
    const first = { accountId: 'a', mailbox: 'INBOX', uid: 3, trash: 'Trash', trashUid: 40 };
    const second = { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9, trash: 'Trash', trashUid: 41 };
    harness.deleteEmailFromServer.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await useNotesStore.getState().deleteCard(note);

    expect(harness.setDeleteUndo).toHaveBeenCalledTimes(1);
    const [outcomes, { afterRestore }] = harness.setDeleteUndo.mock.calls[0];
    expect(outcomes).toEqual([first, second]);

    // The restored messages carry new uids: the board asks for its list again.
    harness.daemonCall.mockClear();
    harness.daemonCall.mockImplementation(async method => (method === 'notes.list' ? { cards: [{ ...note, copies: [{ ...note.copies[0], uid: 50 }] }, card('keep')] } : { count: 2 }));
    await afterRestore();
    expect(harness.daemonCall).toHaveBeenCalledWith('notes.set_done', { copies: note.copies, done: false });
    expect(harness.daemonCall).toHaveBeenCalledWith('notes.list', expect.anything());
    expect(useNotesStore.getState().cards.map(c => c.key)).toEqual(['del', 'keep']);
  });

  it('a partly deleted card was never tagged Done, and its undo leaves the tag alone', async () => {
    const skipped = { accountId: 'a', mailbox: 'Local-Only', uid: 4 };
    const note = card('part', { copies: [{ accountId: 'a', mailbox: 'INBOX', uid: 3 }, skipped] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    harness.deleteEmailFromServer.mockResolvedValueOnce({ accountId: 'a', mailbox: 'INBOX', uid: 3, trash: 'Trash', trashUid: 40 });
    await useNotesStore.getState().deleteCard(note);
    const [, { afterRestore }] = harness.setDeleteUndo.mock.calls[0];
    harness.daemonCall.mockClear();
    await afterRestore();
    expect(harness.daemonCall).not.toHaveBeenCalledWith('notes.set_done', expect.anything());
    expect(harness.daemonCall).toHaveBeenCalledWith('notes.list', expect.anything());
  });

  it('offers the copies it did delete back when the server refuses a later one', async () => {
    const note = card('mid', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 3 },
      { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9 },
    ] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    const first = { accountId: 'a', mailbox: 'INBOX', uid: 3, trash: 'Trash', trashUid: 40 };
    harness.deleteEmailFromServer.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('refused'));
    await expect(useNotesStore.getState().deleteCard(note)).rejects.toThrow('refused');
    expect(harness.setDeleteUndo).toHaveBeenCalledWith([first], expect.objectContaining({ afterRestore: expect.any(Function) }));
  });

  it('tags a note Done once its last copy is deleted, so the vault copy that stays does not bring it back', async () => {
    const note = card('gone', { copies: [{ accountId: 'a', mailbox: 'INBOX', uid: 3 }] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    await useNotesStore.getState().deleteCard(note);
    expect(harness.daemonCall).toHaveBeenCalledWith('notes.set_done', { copies: note.copies, done: true });
  });

  it('still deletes when tagging Done fails, and leaves a partly deleted note untagged', async () => {
    const skipped = { accountId: 'a', mailbox: 'Local-Only', uid: 4 };
    const part = card('part2', { copies: [{ accountId: 'a', mailbox: 'INBOX', uid: 3 }, skipped] });
    harness.daemonCall.mockResolvedValue({ cards: [part] });
    await useNotesStore.getState().open();
    await useNotesStore.getState().deleteCard(part);
    expect(harness.daemonCall).not.toHaveBeenCalledWith('notes.set_done', expect.anything());

    const whole = card('whole');
    harness.daemonCall.mockImplementation(async method => {
      if (method === 'notes.set_done') throw new Error('db busy');
      return { cards: [whole] };
    });
    await useNotesStore.getState().open();
    await expect(useNotesStore.getState().deleteCard(whole)).resolves.toEqual({ deleted: 1, kept: 0 });
  });

  it('keeps the card, with the copy it could not address, and says how many stayed', async () => {
    const skipped = { accountId: 'a', mailbox: 'Local-Only', uid: 4 };
    const note = card('part', { copies: [{ accountId: 'a', mailbox: 'INBOX', uid: 3 }, skipped] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    await expect(useNotesStore.getState().deleteCard(note)).resolves.toEqual({ deleted: 1, kept: 1 });
    expect(harness.deleteEmailFromServer).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().cards).toHaveLength(1);
    expect(useNotesStore.getState().cards[0].copies).toEqual([skipped]);
  });

  it('keeps only the copies not yet deleted when the server refuses one part way', async () => {
    const second = { accountId: 'a', mailbox: '[Gmail]/Sent Mail', uid: 9 };
    const note = card('mid', { copies: [{ accountId: 'a', mailbox: 'INBOX', uid: 3 }, second] });
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    harness.deleteEmailFromServer.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('refused'));
    await expect(useNotesStore.getState().deleteCard(note)).rejects.toThrow('refused');
    expect(useNotesStore.getState().cards[0].copies).toEqual([second]);
  });

  it('runs one delete per card at a time: a second click while it runs does nothing', async () => {
    const note = card('twice');
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    let finish;
    harness.deleteEmailFromServer.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = useNotesStore.getState().deleteCard(note);
    expect(useNotesStore.getState().busy).toEqual({ twice: true });
    await expect(useNotesStore.getState().deleteCard(note)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(harness.deleteEmailFromServer).toHaveBeenCalledTimes(1));
    finish();
    await first;
    expect(harness.deleteEmailFromServer).toHaveBeenCalledTimes(1);
    expect(useNotesStore.getState().busy).toEqual({});
  });

  it('keeps the card when the server refuses a delete, and says so', async () => {
    const note = card('del');
    harness.daemonCall.mockResolvedValue({ cards: [note] });
    await useNotesStore.getState().open();
    harness.deleteEmailFromServer.mockRejectedValue(new Error('refused'));
    await expect(useNotesStore.getState().deleteCard(note)).rejects.toThrow('refused');
    expect(useNotesStore.getState().cards.map(c => c.key)).toEqual(['del']);
  });

  it('never addresses a copy whose folder the account list did not name', () => {
    const accounts = [{ accountId: 'a', knownMailboxes: ['INBOX'] }, { accountId: 'b', knownMailboxes: [] }];
    const note = card('x', { copies: [
      { accountId: 'a', mailbox: 'INBOX', uid: 1 },
      { accountId: 'a', mailbox: 'archive-slug', uid: 2 },
      { accountId: 'b', mailbox: 'INBOX', uid: 3 },
    ] });
    expect(serverCopies(note, accounts).map(copy => copy.uid)).toEqual([1]);
  });
});
