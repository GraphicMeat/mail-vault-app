import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { useMailStore } from './mailStore';
import { useSettingsStore } from './settingsStore';
import { accountPayload } from './viewStore';
import { useTagStore, tagRowKey } from './tagStore';
import { compareNames } from '../utils/collation';

/// The columns the daemon files an untagged note into, in board order. A
/// `#tag` column comes before them, A to Z.
export const AUTO_COLUMNS = ['Links', 'Files', 'Photos', 'Notes'];

/// The board as it is drawn: tag columns A to Z, then Links, Files, Photos,
/// Notes, and no column that has nothing in it. `filter` keeps the cards whose
/// subject or text holds it. Inside a column a starred card comes first, then
/// the newest.
export function boardColumns(cards, filter = '') {
  const needle = String(filter || '').trim().toLocaleLowerCase();
  const byColumn = new Map();
  for (const card of cards || []) {
    if (needle && !`${card.subject || ''}\n${card.snippet || ''}`.toLocaleLowerCase().includes(needle)) continue;
    const name = card.column || 'Notes';
    if (!byColumn.has(name)) byColumn.set(name, []);
    byColumn.get(name).push(card);
  }
  const tags = [...byColumn.keys()].filter(name => !AUTO_COLUMNS.includes(name)).sort(compareNames);
  return [...tags, ...AUTO_COLUMNS.filter(name => byColumn.has(name))].map(name => ({
    name,
    auto: AUTO_COLUMNS.includes(name),
    cards: byColumn.get(name).sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || (b.date || 0) - (a.date || 0)),
  }));
}

/// The copies of a card the server can be asked about. A copy's mailbox is
/// the real server path only when the account's folder list named it; for an
/// account whose folders were never loaded the daemon hands back the vault's
/// folder name, and a star or delete aimed at that would be queued for a
/// folder the server does not have.
export function serverCopies(card, accounts) {
  return (card?.copies || []).filter(copy => accounts
    .find(account => account.accountId === copy.accountId)?.knownMailboxes?.includes(copy.mailbox));
}

/// The key the flag workflow takes: the full `account:mailbox:uid`, which
/// names its own folder whatever list is on screen.
export const copyKey = copy => `${copy.accountId}:${copy.mailbox}:${copy.uid}`;

/// A star can go on when any copy can be flagged. It can only come off when
/// every copy can: a copy the server cannot be asked about may be the flagged
/// one, and the card would say unstarred while it stays starred.
export function canToggleStar(card, accounts) {
  const reachable = serverCopies(card, accounts).length;
  return card?.starred ? reachable > 0 && reachable === (card.copies || []).length : reachable > 0;
}

/// Every account the sidebar shows, in the shape `views.*` already sends.
function visibleAccounts() {
  const mail = useMailStore.getState();
  const hidden = useSettingsStore.getState().hiddenAccounts || {};
  return (mail.accounts || []).filter(account => !hidden[account.id]).map(account => accountPayload(account, mail));
}

let generation = 0;

export const useNotesStore = create((set, get) => ({
  isOpen: false,
  status: 'idle',
  cards: [],
  /// The accounts payload the last list was asked with: which copies are
  /// server-addressable is decided against the same folder lists.
  accounts: [],
  filter: '',
  detailOpen: false,
  /// Card key -> true while a star, done or delete for it is running: a
  /// second click on the same card waits for the first to finish.
  busy: {},

  open: async () => {
    if (get().isOpen) return;
    set({ isOpen: true, filter: '', detailOpen: false });
    await get().load();
  },

  close: () => {
    generation += 1;
    set({ isOpen: false, status: 'idle', cards: [], filter: '', detailOpen: false });
  },

  load: async () => {
    const mine = ++generation;
    const accounts = visibleAccounts();
    set({ status: 'loading', accounts });
    try {
      const reply = await daemonCall('notes.list', { accounts });
      if (mine !== generation) return;
      set({ status: 'ready', cards: Array.isArray(reply?.cards) ? reply.cards : [] });
    } catch (error) {
      if (mine !== generation) return;
      console.warn('[notes] could not list notes:', error?.message || error);
      set({ status: 'error' });
    }
  },

  setFilter: filter => set({ filter }),
  setDetailOpen: detailOpen => set({ detailOpen }),

  /// Done tags every copy with the app tag `Done`; the server is not touched.
  /// The tag store is told: the tag may be new (its list and counts), and the
  /// copies' cached chips are dropped so any row showing them asks again.
  markDone: card => guarded(card, async () => {
    await daemonCall('notes.set_done', { copies: card.copies, done: true });
    set({ cards: get().cards.filter(other => other.key !== card.key) });
    const stale = new Set((card.copies || []).map(copy => tagRowKey(copy.accountId, copy.mailbox, copy.uid)));
    useTagStore.setState(state => ({
      byRow: Object.fromEntries(Object.entries(state.byRow).filter(([key]) => !stale.has(key))),
    }));
    await useTagStore.getState().refreshCounts();
  }),

  /// The card knows whether it is starred; a board card is never a loaded
  /// list row, so the one-row toggle (which reads the row) would always star.
  toggleStar: card => guarded(card, async () => {
    if (!canToggleStar(card, get().accounts)) return;
    const keys = serverCopies(card, get().accounts).map(copyKey);
    const starred = !card.starred;
    const flip = value => set({ cards: get().cards.map(other => (other.key === card.key ? { ...other, starred: value } : other)) });
    flip(starred);
    try {
      const { applyFlagToKeys } = await import('../services/workflows/messageMutations');
      await applyFlagToKeys(keys, '\\Flagged', starred);
    } catch (error) {
      flip(!starred);
      throw error;
    }
  }),

  /// Every copy the server knows goes through the reader's own server delete.
  /// Answers `{ deleted, kept }`: a copy in a folder the account list did not
  /// name is never addressed, and the card stays with just those copies. A
  /// refusal leaves the card holding the copies not yet deleted and is
  /// rethrown for the confirm dialog's error toast.
  deleteCard: card => guarded(card, async () => {
    const copies = serverCopies(card, get().accounts);
    if (!copies.length) return { deleted: 0, kept: (card.copies || []).length };
    const { deleteEmailFromServer } = await import('../services/workflows/messageMutations');
    const gone = new Set();
    const keep = () => {
      const left = (card.copies || []).filter(copy => !gone.has(copy));
      set({ cards: left.length
        ? get().cards.map(other => (other.key === card.key ? { ...other, copies: left } : other))
        : get().cards.filter(other => other.key !== card.key) });
      return left.length;
    };
    try {
      for (const copy of copies) {
        await deleteEmailFromServer(copy.uid, { accountId: copy.accountId, mailboxOverride: copy.mailbox });
        gone.add(copy);
      }
    } catch (error) {
      if (gone.size) keep();
      throw error;
    }
    return { deleted: gone.size, kept: keep() };
  }),
}));

/// Runs one action for a card unless one is already running for it.
function guarded(card, action) {
  const { busy } = useNotesStore.getState();
  if (busy[card.key]) return Promise.resolve(undefined);
  useNotesStore.setState({ busy: { ...busy, [card.key]: true } });
  return Promise.resolve().then(action).finally(() => {
    const { [card.key]: _done, ...rest } = useNotesStore.getState().busy;
    useNotesStore.setState({ busy: rest });
  });
}
