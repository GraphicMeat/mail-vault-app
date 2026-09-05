// Creating, renaming and deleting a folder — Thunderbird's model: "delete"
// RENAMEs the folder under Trash and only a folder already under Trash is
// DELETEd for real. Whatever the server does, the vault's directories have to
// follow, one pair per descendant.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { t as tr } from '../../../i18n/index.js';

const api = {
  createMailbox: vi.fn(),
  renameMailbox: vi.fn(),
  deleteMailbox: vi.fn(),
  vaultRenameMailbox: vi.fn(),
  graphCreateFolder: vi.fn(),
  graphRenameFolder: vi.fn(),
  graphMoveFolder: vi.fn(),
  graphDeleteFolder: vi.fn(),
};
vi.mock('../../api', () => api);
vi.mock('../../authUtils', () => ({ ensureFreshToken: async (a) => a }));
vi.mock('../../graphConfig', () => ({
  isGraphAccount: (a) => a?.oauth2Transport === 'graph',
}));
const mockForce = vi.fn();
vi.mock('../helpers/mailboxRefetch', () => ({ forceMailboxRefetch: (...a) => mockForce(...a) }));

let state;
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; },
  },
}));

const { createFolder, renameFolder, deleteFolder, folderDelimiter, trashPathOf, specialOrInbox } =
  await import('../folderOps');

const ACCOUNT = { id: 'a1', email: 'a1@x' };
const GRAPH_ACCOUNT = { id: 'a1', email: 'a1@x', oauth2Transport: 'graph', oauth2AccessToken: 'tok' };

/** The store as folderOps reads it. */
function store(mailboxes, activeMailbox = 'INBOX', account = ACCOUNT) {
  state = {
    accounts: [account],
    activeAccountId: 'a1',
    activeMailbox,
    mailboxes,
    activateAccount: vi.fn(),
  };
}

const box = (path, extra = {}) => ({ path, delimiter: '/', specialUse: null, ...extra });

const DOTTED = [
  box('INBOX', { delimiter: '.' }),
  box('INBOX.Trash', { delimiter: '.', specialUse: '\\Trash' }),
];

const SLASHED = [
  box('INBOX'),
  box('Trash', { specialUse: '\\Trash' }),
  box('Projects'),
  box('Projects/Alpha'),
  box('Projects/Alpha/Deep'),
  box('Projects-Alt'),   // the near-miss the delimiter boundary has to exclude
];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mockForce.mockReset();
  api.deleteMailbox.mockResolvedValue({ success: true, deleted: 2 });
});

describe('createFolder', () => {
  it('builds the path from the parent and the delimiter, encodes the name, refetches and reactivates', async () => {
    store(DOTTED);
    const p = await createFolder('a1', 'INBOX', 'Kunden Ü');
    expect(p).toBe('INBOX.Kunden &ANw-');
    expect(api.createMailbox).toHaveBeenCalledWith(ACCOUNT, 'INBOX.Kunden &ANw-');
    expect(mockForce).toHaveBeenCalledWith('a1');
    expect(state.activateAccount).toHaveBeenCalledWith('a1', 'INBOX');
  });

  it('puts a folder with no parent at the root', async () => {
    store(SLASHED);
    expect(await createFolder('a1', null, 'Kunden')).toBe('Kunden');
    expect(api.createMailbox).toHaveBeenCalledWith(ACCOUNT, 'Kunden');
  });
});

describe('renameFolder', () => {
  it('renames on the server and moves every local directory of the subtree', async () => {
    store(SLASHED, 'Projects/Alpha');
    await renameFolder('a1', 'Projects', 'Work');
    expect(api.renameMailbox).toHaveBeenCalledWith(ACCOUNT, 'Projects', 'Work');
    expect(api.vaultRenameMailbox).toHaveBeenCalledWith('a1', 'a1@x', [
      { from: 'Projects', to: 'Work' },
      { from: 'Projects/Alpha', to: 'Work/Alpha' },
      { from: 'Projects/Alpha/Deep', to: 'Work/Alpha/Deep' },
    ]);
    // The open folder follows its new path; the near-miss sibling is untouched.
    expect(state.activateAccount).toHaveBeenCalledWith('a1', 'Work/Alpha');
  });

  it('keeps the folder where it is in the hierarchy', async () => {
    store(SLASHED, 'INBOX');
    expect(await renameFolder('a1', 'Projects/Alpha', 'Beta')).toBe('Projects/Beta');
    expect(state.activateAccount).toHaveBeenCalledWith('a1', 'INBOX');
  });

  it('still refreshes the list when the vault half fails, and reports it', async () => {
    // The server rename already happened: leaving the sidebar on the old name
    // would be a second, invisible failure.
    store(SLASHED, 'INBOX');
    api.vaultRenameMailbox.mockRejectedValue(new Error('vault rename incomplete: x'));
    await expect(renameFolder('a1', 'Projects', 'Work')).rejects.toThrow('vault rename incomplete');
    expect(mockForce).toHaveBeenCalledWith('a1');
  });
});

describe('deleteFolder', () => {
  it('outside Trash renames under Trash and moves the vault dirs', async () => {
    store(SLASHED, 'Projects/Alpha/Deep');
    expect(await deleteFolder('a1', 'Projects')).toEqual({ movedTo: 'Trash/Projects' });
    expect(api.renameMailbox).toHaveBeenCalledWith(ACCOUNT, 'Projects', 'Trash/Projects');
    expect(api.vaultRenameMailbox).toHaveBeenCalledWith('a1', 'a1@x', [
      { from: 'Projects', to: 'Trash/Projects' },
      { from: 'Projects/Alpha', to: 'Trash/Projects/Alpha' },
      { from: 'Projects/Alpha/Deep', to: 'Trash/Projects/Alpha/Deep' },
    ]);
    expect(api.deleteMailbox).not.toHaveBeenCalled();
    expect(state.activateAccount).toHaveBeenCalledWith('a1', 'INBOX');
  });

  it('already under Trash issues a real DELETE deepest-first and touches no vault dir', async () => {
    store([box('INBOX'), box('Trash', { specialUse: '\\Trash' }), box('Trash/Old'), box('Trash/Old/Deeper')], 'INBOX');
    expect(await deleteFolder('a1', 'Trash/Old')).toEqual({ deleted: 2 });
    expect(api.deleteMailbox).toHaveBeenCalledWith(ACCOUNT, ['Trash/Old', 'Trash/Old/Deeper']);
    expect(api.vaultRenameMailbox).not.toHaveBeenCalled();
    expect(api.renameMailbox).not.toHaveBeenCalled();
    expect(state.activateAccount).toHaveBeenCalledWith('a1', 'INBOX');
  });

  it('without a Trash folder refuses with the catalog key', async () => {
    store([box('INBOX'), box('Projects')], 'INBOX');
    await expect(deleteFolder('a1', 'Projects')).rejects.toThrow(tr('errors.noTrashFolder'));
    expect(api.renameMailbox).not.toHaveBeenCalled();
  });

  it('refuses on an account whose namespace has no hierarchy', async () => {
    // A NIL delimiter means folders cannot nest, so nothing can go under Trash.
    store([box('INBOX', { delimiter: '' }), box('Trash', { delimiter: '', specialUse: '\\Trash' }), box('Projects', { delimiter: '' })], 'INBOX');
    await expect(deleteFolder('a1', 'Projects')).rejects.toThrow(tr('errors.noTrashFolder'));
    expect(api.renameMailbox).not.toHaveBeenCalled();
  });
});

describe('the name the user typed', () => {
  it('is refused when it contains the delimiter', async () => {
    store(SLASHED);
    await expect(createFolder('a1', null, 'a/b')).rejects.toThrow(
      tr('errors.folderNameInvalid', { delimiter: '/' })
    );
    expect(api.createMailbox).not.toHaveBeenCalled();
  });

  it('is refused when it is empty or only spaces', async () => {
    store(SLASHED);
    await expect(createFolder('a1', null, '   ')).rejects.toThrow(tr('errors.folderNameInvalid', { delimiter: '/' }));
  });

  it('is refused when it carries CR or LF', async () => {
    // quote_mailbox in src-core refuses these outright — a newline in a
    // mailbox name is how a second IMAP command gets spliced onto the wire.
    store(SLASHED);
    await expect(createFolder('a1', null, 'a\r\nLOGOUT')).rejects.toThrow(
      tr('errors.folderNameInvalid', { delimiter: '/' })
    );
    await expect(renameFolder('a1', 'Projects', 'x\ny')).rejects.toThrow(
      tr('errors.folderNameInvalid', { delimiter: '/' })
    );
    expect(api.renameMailbox).not.toHaveBeenCalled();
  });
});

describe('Graph', () => {
  const GRAPH_BOXES = [
    box('Inbox', { _graphFolderId: 'id-inbox', specialUse: '\\Inbox' }),
    box('Deleted Items', { _graphFolderId: 'id-trash', specialUse: '\\Trash' }),
    box('Projects', { _graphFolderId: 'id-projects' }),
  ];

  it('create/rename/delete go through the Graph commands with folder ids', async () => {
    store(GRAPH_BOXES, 'Inbox', GRAPH_ACCOUNT);
    await createFolder('a1', 'Projects', 'Kunden');
    expect(api.graphCreateFolder).toHaveBeenCalledWith('tok', 'Kunden', 'id-projects');
    expect(api.createMailbox).not.toHaveBeenCalled();

    await renameFolder('a1', 'Projects', 'Work');
    expect(api.graphRenameFolder).toHaveBeenCalledWith('tok', 'id-projects', 'Work');
    // The local directories still move, whatever moved them on the server.
    expect(api.vaultRenameMailbox).toHaveBeenCalledWith('a1', 'a1@x', [
      { from: 'Projects', to: 'Work' },
    ]);

    await deleteFolder('a1', 'Projects');
    expect(api.graphMoveFolder).toHaveBeenCalledWith('tok', 'id-projects', 'deleteditems');
    expect(api.graphDeleteFolder).not.toHaveBeenCalled();
  });

  it('deletes a folder already in Deleted Items for real', async () => {
    store([...GRAPH_BOXES, box('Deleted Items/Old', { _graphFolderId: 'id-old' })], 'Inbox', GRAPH_ACCOUNT);
    expect(await deleteFolder('a1', 'Deleted Items/Old')).toEqual({ deleted: 1 });
    expect(api.graphDeleteFolder).toHaveBeenCalledWith('tok', 'id-old');
    expect(api.vaultRenameMailbox).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('reads the delimiter off the list and falls back to "/"', () => {
    expect(folderDelimiter(DOTTED)).toBe('.');
    expect(folderDelimiter([])).toBe('/');
    expect(folderDelimiter(undefined)).toBe('/');
  });

  it('finds the Trash folder by its special use, not its name', () => {
    expect(trashPathOf(DOTTED)).toBe('INBOX.Trash');
    expect(trashPathOf([box('Trash')])).toBe(null);
  });

  it('locks INBOX and every special-use folder', () => {
    expect(specialOrInbox({ path: 'INBOX' })).toBe(true);
    expect(specialOrInbox({ path: 'Trash', specialUse: '\\Trash' })).toBe(true);
    expect(specialOrInbox({ path: 'Projects' })).toBe(false);
  });
});
