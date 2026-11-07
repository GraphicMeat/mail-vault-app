// The mobile app's state: accounts, the active account's folders, the open folder's message list
// and each account's sync state, over the `mobile.*` RPCs and engine events.
//
// Actions (`act`): read, unread, flag and unflag go to `mobile.actions.apply` at once. A move or a
// delete is deferred on this side: its rows leave the list at once (`list.hide`), an undo toast
// shows for UNDO_MS, and only then is it applied, or sooner when the page is hidden or unloaded,
// the account or folder changes, the viewer moves on to another message (App.jsx calls `flush`),
// or the next move or delete comes (one deferred action at a time).
// Undo forgets it and shows the rows again; nothing reached the engine. A killed app can lose an
// unsent move or delete, which keeps the mail. Store-free of the
// desktop: it imports nothing from src/stores, and reaches the engine only through transport.js
// with literal method and event names (the seam test reads them off this file).
import { create } from 'zustand';
import { daemonCall, listen } from './transport.js';
import { createPageCache, PAGE_SIZE } from './messagePages.js';
import { errorCodeOf } from './errors.js';

export const STORAGE_ACCOUNT = 'mv.mobile.activeAccount';
export const STORAGE_FOLDER = 'mv.mobile.activeFolder';
export const INBOX = 'INBOX';
/** How long a move or delete waits for an undo before it is applied. */
export const UNDO_MS = 5000;
/** Most uids one `mobile.actions.apply` takes. */
export const MAX_APPLY = 199;
const HIDES = new Set(['move', 'delete']);
const DROP_REASONS = new Set(['GONE', 'FOLDER_GONE', 'REFUSED']);

// localStorage can be missing or throw (private mode, a locked-down WebView): never fatal.
function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeStorage(key, value) {
  try {
    if (value == null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Remembering the last folder is a convenience; losing it is fine.
  }
}

function savedFolder(accountId) {
  try {
    const saved = JSON.parse(readStorage(STORAGE_FOLDER) || 'null');
    return saved && saved.accountId === accountId && typeof saved.path === 'string' ? saved.path : null;
  } catch {
    return null;
  }
}

/** The account's unread count for the switcher: its inbox, not Junk or Trash. */
function inboxUnread(folders) {
  const inbox = folders.find((f) => f.path.toUpperCase() === INBOX) || folders.find((f) => f.specialUse === '\\Inbox');
  return inbox ? inbox.unseen || 0 : 0;
}

function listFor(accountId, folder) {
  return createPageCache((cursor, limit) =>
    daemonCall('mobile.messages.page', { accountId, folder, cursor, limit }), PAGE_SIZE);
}

export function createMobileStore() {
  let initRun = null;
  let unsubscribers = [];
  let deferred = null; // { id, accountId, folder, uids, kind, target, list, timer }
  let serial = 0;

  return create((set, get) => {
    const notice = (key) => set({ notice: { id: ++serial, key } });

    /** The open list, when it shows `folder` of `accountId`. */
    function listOf(accountId, folder) {
      const s = get();
      return s.list && s.activeAccountId === accountId && s.activeFolder === folder ? s.list : null;
    }

    async function loadPending() {
      const accountId = get().activeAccountId;
      if (!accountId) return;
      try {
        const { pending } = await daemonCall('mobile.actions.pending', { accountId });
        if (get().activeAccountId === accountId) set({ pending: Array.isArray(pending) ? pending.length : 0 });
      } catch {
        // The chip is a hint: a failed read keeps the last count.
      }
    }

    /** Applies an action in chunks of MAX_APPLY uids. */
    async function send({ accountId, folder, uids, kind, target, list }) {
      const skipped = [];
      let failed = false;
      for (let i = 0; i < uids.length; i += MAX_APPLY) {
        try {
          const reply = await daemonCall('mobile.actions.apply', {
            accountId, folder, uids: uids.slice(i, i + MAX_APPLY), kind, ...(target ? { target } : {}),
          });
          if (Array.isArray(reply?.skipped)) skipped.push(...reply.skipped);
        } catch {
          failed = true;
          break;
        }
      }
      const hides = HIDES.has(kind);
      // The engine has hidden what it applied and has no row for what it skipped (no
      // `mobile.folder.changed` comes for those): reload the pages, then let the hidden rows go.
      // After a failure the reload brings back whatever was not applied.
      if (list && (hides || skipped.length || failed)) {
        list.invalidate();
        if (hides) list.unhide(uids);
      }
      if (failed) notice('mobile.actions.failed');
      loadPending();
    }

    /** Applies the deferred move or delete now, if there is one. */
    function flush() {
      const d = deferred;
      if (!d) return Promise.resolve();
      deferred = null;
      clearTimeout(d.timer);
      if (get().undo?.id === d.id) set({ undo: null });
      return send(d);
    }

    function onActionResult(p) {
      if (!p) return;
      if (p.outcome === 'dropped') notice(DROP_REASONS.has(p.reason) ? `mobile.actions.dropped.${p.reason}` : 'mobile.actions.failed');
      loadPending();
    }

    async function loadFolders(accountId) {
      const { folders } = await daemonCall('mobile.folders.list', { accountId });
      set((s) => ({
        unread: s.accounts.some((a) => a.id === accountId) ? { ...s.unread, [accountId]: inboxUnread(folders) } : s.unread,
        ...(s.activeAccountId === accountId ? { folders } : {}),
      }));
      return folders;
    }

    // Folder counts are a badge: a failed read keeps the old one.
    const loadFoldersQuietly = (accountId) => loadFolders(accountId).catch(() => undefined);

    /** Opens `folder` of `accountId`: a fresh list, remembered for the next launch. */
    function open(accountId, folder) {
      flush();
      const list = listFor(accountId, folder);
      set({ activeAccountId: accountId, activeFolder: folder, list, listGen: null });
      writeStorage(STORAGE_ACCOUNT, accountId);
      writeStorage(STORAGE_FOLDER, JSON.stringify({ accountId, path: folder }));
      return list;
    }

    async function activate(accountId, folder) {
      flush();
      set({ activeAccountId: accountId, folders: [], pending: 0 });
      loadPending();
      let folders = [];
      try {
        folders = await loadFolders(accountId);
      } catch {
        // No folder list yet (a new account before its first sync): INBOX is always there.
      }
      if (get().activeAccountId !== accountId) return; // another switch won
      const wanted = folder && folders.some((f) => f.path === folder && !f.noselect) ? folder : INBOX;
      open(accountId, wanted);
      set({ status: 'ready' });
      if (get().autoSync) await get().refresh();
    }

    function onFolderChanged(p) {
      if (!p || !p.accountId) return;
      const s = get();
      if (p.accountId === s.activeAccountId && p.folder === s.activeFolder && s.list) {
        if (s.list.invalidate(p.listGen)) set({ listGen: s.list.listGen });
      }
      loadFoldersQuietly(p.accountId);
    }

    function subscribe() {
      const on = [
        ['mobile.folder.changed', () => listen('mobile.folder.changed', onFolderChanged)],
        ['mobile.folders.changed', () => listen('mobile.folders.changed', (p) => p?.accountId && loadFoldersQuietly(p.accountId))],
        ['mobile.sync.state', () => listen('mobile.sync.state', (p) => {
          if (!p?.accountId) return;
          set((s) => ({ syncState: { ...s.syncState, [p.accountId]: { state: p.state, code: p.code ?? null, at: Date.now() } } }));
        })],
        // Results sent before this subscribed are lost: the chip is re-read on start and resume.
        ['mobile.action.result', () => listen('mobile.action.result', onActionResult)],
      ];
      for (const [name, subscribeOne] of on) {
        try {
          unsubscribers.push(subscribeOne());
        } catch (err) {
          // No event bridge (plain browser dev): the list still works, it just will not go live.
          console.warn(`[mobile] cannot listen to ${name}`, err?.message || err);
        }
      }
      // Leaving the app sends the deferred action; coming back re-reads the queue.
      if (typeof document !== 'undefined' && typeof window !== 'undefined') {
        const onVisibility = () => {
          if (document.visibilityState === 'hidden') flush();
          else loadPending();
        };
        const onPageHide = () => { flush(); };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', onPageHide);
        unsubscribers.push(() => {
          document.removeEventListener('visibilitychange', onVisibility);
          window.removeEventListener('pagehide', onPageHide);
        });
      }
    }

    return {
      status: 'loading', // 'loading' | 'ready' | 'noAccount' | 'failed'
      accounts: [],
      activeAccountId: null,
      folders: [],
      activeFolder: null,
      syncState: {}, // accountId -> { state: 'idle'|'syncing'|'error', code, at: ms of the report }
      unread: {}, // accountId -> inbox unseen
      list: null, // the open folder's page cache
      listGen: null,
      autoSync: true, // false under the perf probe: no sync pass during a measurement
      pending: 0, // the active account's actions still to reach the server
      undo: null, // the deferred move or delete's toast: { id, kind, count, target }
      notice: null, // a one-line toast: { id, key }

      /**
       * Applies `kind` (seen|unseen|flag|unflag|move|delete) to `uids` of `folder`. A move or
       * delete is deferred (see the top of this file); resolves once anything it sent is applied.
       */
      act(kind, { accountId, folder, uids, target } = {}) {
        if (!accountId || !folder || !Array.isArray(uids) || uids.length === 0) return Promise.resolve();
        if (!HIDES.has(kind)) return send({ accountId, folder, uids, kind, list: listOf(accountId, folder) });
        const before = flush();
        const list = listOf(accountId, folder);
        list?.hide(uids);
        const id = ++serial;
        const timer = setTimeout(() => { if (deferred?.id === id) flush(); }, UNDO_MS);
        deferred = { id, accountId, folder, uids: [...uids], kind, target, list, timer };
        set({ undo: { id, kind, count: uids.length, target: target ?? null } });
        return before;
      },

      /** Opening a message marks it read. */
      markSeen(accountId, folder, row) {
        if (!row || row.seen) return Promise.resolve();
        return get().act('seen', { accountId, folder, uids: [row.uid] });
      },

      /** Drops the deferred action `id` and shows its rows again. False when it already went. */
      undoDeferred(id) {
        const d = deferred;
        if (!d || d.id !== id) return false;
        deferred = null;
        clearTimeout(d.timer);
        d.list?.unhide(d.uids);
        set({ undo: null });
        return true;
      },

      flush,
      loadPending,

      dismissNotice(id) {
        if (get().notice?.id === id) set({ notice: null });
      },

      /**
       * Loads accounts and opens the remembered (or first) account's folder, then refreshes it
       * (unless `sync` is false). Safe to call twice.
       */
      init({ sync = true } = {}) {
        if (initRun) return initRun;
        set({ autoSync: sync });
        subscribe();
        initRun = (async () => {
          let accounts;
          try {
            ({ accounts } = await daemonCall('mobile.accounts.list'));
          } catch (err) {
            initRun = null; // a retry may succeed
            for (const off of unsubscribers) off();
            unsubscribers = [];
            set({ status: 'failed' });
            throw err;
          }
          set({ accounts });
          if (!accounts.length) {
            set({ status: 'noAccount', list: null });
            return;
          }
          const saved = readStorage(STORAGE_ACCOUNT);
          const active = accounts.find((a) => a.id === saved) || accounts[0];
          for (const a of accounts) if (a.id !== active.id) loadFoldersQuietly(a.id);
          await activate(active.id, savedFolder(active.id));
        })();
        return initRun;
      },

      /** Adds an account (the engine signs in first) and opens it. Never keeps the password. */
      async addAccount(form) {
        let reply;
        try {
          reply = await daemonCall('mobile.accounts.add', {
            email: form.email,
            password: form.password,
            imapHost: form.imapHost,
            imapPort: form.imapPort,
            security: form.security,
            ...(form.displayName ? { displayName: form.displayName } : {}),
          });
        } catch (err) {
          return { ok: false, code: errorCodeOf(err?.code) };
        }
        if (!reply?.ok) return { ok: false, code: errorCodeOf(reply?.code) };
        const account = reply.account;
        set((s) => ({ accounts: [...s.accounts.filter((a) => a.id !== account.id), account], unread: { ...s.unread, [account.id]: 0 } }));
        await activate(account.id, INBOX);
        return { ok: true };
      },

      async removeAccount(id) {
        await daemonCall('mobile.accounts.remove', { accountId: id });
        const { accounts, activeAccountId } = get();
        const at = accounts.findIndex((a) => a.id === id);
        const rest = accounts.filter((a) => a.id !== id);
        set((s) => {
          const { [id]: _gone, ...unread } = s.unread;
          const { [id]: _state, ...syncState } = s.syncState;
          return { accounts: rest, unread, syncState };
        });
        if (activeAccountId !== id) return;
        if (!rest.length) {
          writeStorage(STORAGE_ACCOUNT, null);
          writeStorage(STORAGE_FOLDER, null);
          set({ status: 'noAccount', activeAccountId: null, activeFolder: null, folders: [], list: null, listGen: null });
          return;
        }
        // The next account in the list, or the one before when the last was removed.
        const next = rest[Math.min(at, rest.length - 1)];
        await activate(next.id, INBOX);
      },

      async selectAccount(id) {
        if (!get().accounts.some((a) => a.id === id)) return;
        await activate(id, savedFolder(id));
      },

      async selectFolder(path) {
        const { activeAccountId, activeFolder } = get();
        if (!activeAccountId) return;
        if (path !== activeFolder) open(activeAccountId, path);
        await get().refresh();
      },

      /**
       * Syncs the open folder. A refresh without a folder is the engine's folder list plus INBOX,
       * so the inbox gets that form (the folder list stays fresh) and any other folder is named.
       */
      async refresh() {
        const { activeAccountId: accountId, activeFolder: folder } = get();
        if (!accountId) return;
        try {
          await daemonCall('mobile.sync.refresh', folder && folder !== INBOX ? { accountId, folder } : { accountId });
        } catch (err) {
          set((s) => ({ syncState: { ...s.syncState, [accountId]: { state: 'error', code: errorCodeOf(err?.code), at: Date.now() } } }));
        }
      },
    };
  });
}

/** The app's one store. */
export const useMobileStore = createMobileStore();
