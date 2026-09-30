import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { getCachedMailboxes, getEmailHeadersByUids } from '../services/db';
import { useMailStore } from './mailStore';
import { useSettingsStore } from './settingsStore';
import { accountPayload } from './viewStore';
import { useTagStore, tagRowKey } from './tagStore';
import { flattenMailboxes } from './slices/unifiedHelpers';
import { registerRows, patchEverywhere } from './messageRows';
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
/// This session only holds the folders of an account it has opened; any
/// other one's come from the list saved last time, the one the sidebar
/// restores from. Without them no copy of its notes could be starred or
/// deleted.
async function visibleAccounts() {
  const mail = useMailStore.getState();
  const hidden = useSettingsStore.getState().hiddenAccounts || {};
  return Promise.all((mail.accounts || []).filter(account => !hidden[account.id]).map(async account => {
    const payload = accountPayload(account, mail);
    if (payload.knownMailboxes.length) return payload;
    const saved = await getCachedMailboxes(account.id).catch(() => null);
    return { ...payload, knownMailboxes: flattenMailboxes(saved).map(box => box.path) };
  }));
}

let generation = 0;
/// Cards finished or deleted since the last list was asked for. A list
/// already on its way was read before that and still holds them.
let offBoard = new Set();

export const useNotesStore = create((set, get) => ({
  isOpen: false,
  status: 'idle',
  cards: [],
  /// The accounts payload the last list was asked with: which copies are
  /// server-addressable is decided against the same folder lists.
  accounts: [],
  filter: '',
  detailOpen: false,
  /// The card the reader shows, for the reader's own star, done and delete.
  openKey: null,
  /// Card key -> true while a star, done or delete for it is running: a
  /// second click on the same card waits for the first to finish.
  busy: {},

  open: async () => {
    if (get().isOpen) return;
    set({ isOpen: true, filter: '', detailOpen: false, openKey: null });
    await get().load();
  },

  close: () => {
    generation += 1;
    set({ isOpen: false, status: 'idle', cards: [], filter: '', detailOpen: false, openKey: null });
  },

  load: async () => {
    const mine = ++generation;
    offBoard = new Set();
    set({ status: 'loading' });
    try {
      // The daemon names each copy's folder from these lists, so they are
      // complete before it is asked.
      const accounts = await visibleAccounts();
      if (mine !== generation) return;
      set({ accounts });
      const reply = await daemonCall('notes.list', { accounts });
      if (mine !== generation) return;
      set({ status: 'ready', cards: (Array.isArray(reply?.cards) ? reply.cards : []).filter(card => !offBoard.has(card.key)) });
    } catch (error) {
      if (mine !== generation) return;
      console.warn('[notes] could not list notes:', error?.message || error);
      set({ status: 'error' });
    }
  },

  setFilter: filter => set({ filter }),
  setDetailOpen: (detailOpen, openKey = null) => set({ detailOpen, openKey }),

  /// Done tags every copy with the app tag `Done`; the server is not touched.
  /// It takes the card off the board the way a delete takes a row off the
  /// list, so it is offered back the same way: the undo takes the tag off and
  /// puts the card back as it was.
  markDone: card => guarded(card, async () => {
    await daemonCall('notes.set_done', { copies: card.copies, done: true });
    offBoard.add(card.key);
    set({ cards: get().cards.filter(other => other.key !== card.key) });
    useMailStore.getState().setUndo({
      labelKey: 'undo.noteDone',
      run: async () => {
        await daemonCall('notes.set_done', { copies: card.copies, done: false });
        // A list asked for before the undo must not drop it again.
        offBoard.delete(card.key);
        if (get().isOpen && !get().cards.some(other => other.key === card.key)) set({ cards: [...get().cards, card] });
        await tagChanged(card.copies);
      },
    });
    await tagChanged(card.copies);
  }),

  /// The card knows whether it is starred; a board card is never a loaded
  /// list row, so the one-row toggle (which reads the row) would always star.
  /// Each copy goes to the flag core as a target that names its own folder:
  /// the daemon listed it from the vault, which is the proof a list row gives
  /// that core, so the core lands the star on the vault copy as well (as a
  /// delta over what the copy holds by then), and its undo takes it back off
  /// there and off this card (applyCopyFlag).
  toggleStar: card => guarded(card, async () => {
    if (!canToggleStar(card, get().accounts)) return;
    const mailAccounts = useMailStore.getState().accounts || [];
    const targets = serverCopies(card, get().accounts).flatMap(copy => {
      const account = mailAccounts.find(candidate => candidate.id === copy.accountId);
      return account ? [{ account, accountId: copy.accountId, mailbox: copy.mailbox, uid: copy.uid, named: true }] : [];
    });
    if (!targets.length) return;
    const starred = !card.starred;
    const before = get().cards.find(other => other.key === card.key);
    get().applyCopyFlag(targets, '\\Flagged', starred);
    try {
      const { applyFlagToTargets } = await import('../services/workflows/messageMutations');
      await applyFlagToTargets(targets, '\\Flagged', starred);
    } catch (error) {
      if (before) set({ cards: get().cards.map(other => (other.key === card.key ? before : other)) });
      throw error;
    }
  }),

  /// One flag change for these copies, painted on the board before the flag
  /// core lands it everywhere else (this board's star). The same patch the
  /// core makes: the board is one of the containers messageRows knows.
  applyCopyFlag: (targets, flag, on) => patchEverywhere(
    targets.map(target => `${target.accountId}-${target.mailbox}-${target.uid}`),
    copy => {
      const flags = (copy.flags || []).filter(other => other !== flag);
      return { ...copy, flags: on ? [...flags, flag] : flags };
    },
    { only: 'notesCards' },
  ),

  /// A sync wrote another device's read or star into the header cache of
  /// this folder (the change feed's `updatedFlags`). The board's copies there
  /// take their \Seen and \Flagged from those cached rows, the same reread the
  /// open list does (loadEmails `rereadFlags`); only a card whose copy
  /// changed is replaced. A copy the cache holds no row for keeps its flags.
  rereadCopyFlags: async (accountId, mailbox) => {
    if (!get().isOpen) return;
    const inFolder = copy => copy.accountId === accountId && copy.mailbox === mailbox;
    const uids = [...new Set(get().cards.flatMap(card => (card.copies || []).filter(inFolder).map(copy => copy.uid)))];
    if (!uids.length) return;
    const mine = generation;
    const rows = await getEmailHeadersByUids(accountId, mailbox, uids).catch(() => []);
    if (mine !== generation || !get().isOpen) return;
    const cached = new Map((rows || []).map(row => [String(row.uid), row.flags || []]));
    const TRACKED = ['\\Seen', '\\Flagged'];
    const reread = copy => {
      const flags = inFolder(copy) && cached.get(String(copy.uid));
      if (!flags) return copy;
      const own = copy.flags || [];
      if (TRACKED.every(flag => own.includes(flag) === flags.includes(flag))) return copy;
      return { ...copy, flags: [...own.filter(flag => !TRACKED.includes(flag)), ...TRACKED.filter(flag => flags.includes(flag))] };
    };
    let touched = false;
    const { busy } = get();
    const cards = get().cards.map(card => {
      // A star still on its way owns the card: the cache may not hold it yet.
      if (busy[card.key]) return card;
      const copies = (card.copies || []).map(reread);
      if (copies.every((copy, i) => copy === card.copies[i])) return card;
      touched = true;
      return { ...card, copies, starred: copies.some(copy => copy.flags?.includes('\\Flagged')) };
    });
    if (touched) set({ cards });
  },

  /// Every copy the server knows goes through the reader's own server delete.
  /// Answers `{ deleted, kept }`: a copy in a folder the account list did not
  /// name is never addressed, and the card stays with just those copies. A
  /// refusal leaves the card holding the copies not yet deleted and is
  /// rethrown for the confirm dialog's error toast.
  ///
  /// One copy at a time (`skipRefresh`), and one undo for all of them: a slot
  /// per copy put back only the last. The undo brings the card back too; the
  /// restored copies carry new uids, which only a fresh list knows.
  deleteCard: card => guarded(card, async () => {
    const copies = serverCopies(card, get().accounts);
    if (!copies.length) return { deleted: 0, kept: (card.copies || []).length };
    const { deleteEmailFromServer, setDeleteUndo } = await import('../services/workflows/messageMutations');
    const gone = new Set();
    const outcomes = [];
    const keep = () => {
      const left = (card.copies || []).filter(copy => !gone.has(copy));
      if (!left.length) offBoard.add(card.key);
      set({ cards: left.length
        ? get().cards.map(other => (other.key === card.key ? { ...other, copies: left } : other))
        : get().cards.filter(other => other.key !== card.key) });
      return left.length;
    };
    const offerUndo = tagged => setDeleteUndo(outcomes.filter(Boolean), {
      afterRestore: async () => {
        if (tagged) await daemonCall('notes.set_done', { copies: card.copies, done: false });
        if (get().isOpen) await get().load();
      },
    });
    try {
      for (const copy of copies) {
        outcomes.push(await deleteEmailFromServer(copy.uid, { accountId: copy.accountId, mailboxOverride: copy.mailbox, skipRefresh: true }));
        gone.add(copy);
      }
    } catch (error) {
      if (gone.size) {
        keep();
        await offerUndo(false);
      }
      throw error;
    }
    const kept = keep();
    // The board lists the vault's copies, and a server delete leaves those:
    // tag the note Done so it does not come back with the next list.
    const tagged = !kept && await daemonCall('notes.set_done', { copies: card.copies, done: true }).then(() => true, () => false);
    await offerUndo(tagged);
    return { deleted: gone.size, kept };
  }),
}));

/// `Done` went on or came off these copies. The tag store is told: the tag
/// may be new (its list and counts), and the copies' cached chips are dropped
/// so any row showing them asks again.
async function tagChanged(copies) {
  const stale = new Set((copies || []).map(copy => tagRowKey(copy.accountId, copy.mailbox, copy.uid)));
  useTagStore.setState(state => ({
    byRow: Object.fromEntries(Object.entries(state.byRow).filter(([key]) => !stale.has(key))),
  }));
  await useTagStore.getState().refreshCounts();
}

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

// The board's cards are a container of message rows: each keeps every copy's
// own flags and reads its star off them. Only the board's own star used to
// change a card, so a star from the list, or the undo of one, left the card
// showing the star it no longer had. A card is starred while any copy is.
registerRows({
  name: 'notesCards',
  store: useNotesStore,
  fields: ['cards'],
  held: state => state.cards.flatMap(card => card.copies || []),
  mapRows: (state, ctx) => {
    const flagged = copies => copies.some(copy => copy.flags?.includes('\\Flagged'));
    let touched = false;
    const cards = state.cards.map(card => {
      const copies = card.copies || [];
      let mapped = null;
      copies.forEach((copy, index) => {
        const key = `${copy.accountId}-${copy.mailbox}-${copy.uid}`;
        if (!ctx.keys.has(key)) return;
        const next = ctx.mapRow(copy, key);
        if (next !== copy) {
          mapped ??= copies.slice();
          mapped[index] = next;
        }
      });
      if (!mapped) return card;
      touched = true;
      return flagged(mapped) === flagged(copies)
        ? { ...card, copies: mapped }
        : { ...card, copies: mapped, starred: flagged(mapped) };
    });
    return touched ? { cards } : null;
  },
});
