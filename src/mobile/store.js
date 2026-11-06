// The mobile app's state: accounts, the active account's folders, the open folder's message list
// and each account's sync state, over the `mobile.*` RPCs and engine events. Store-free of the
// desktop: it imports nothing from src/stores, and reaches the engine only through transport.js
// with literal method and event names (the seam test reads them off this file).
import { create } from 'zustand';
import { daemonCall, listen } from './transport.js';
import { createPageCache, PAGE_SIZE } from './messagePages.js';
import { errorCodeOf } from './errors.js';

export const STORAGE_ACCOUNT = 'mv.mobile.activeAccount';
export const STORAGE_FOLDER = 'mv.mobile.activeFolder';
export const INBOX = 'INBOX';

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

  return create((set, get) => {
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
      const list = listFor(accountId, folder);
      set({ activeAccountId: accountId, activeFolder: folder, list, listGen: null });
      writeStorage(STORAGE_ACCOUNT, accountId);
      writeStorage(STORAGE_FOLDER, JSON.stringify({ accountId, path: folder }));
      return list;
    }

    async function activate(accountId, folder) {
      set({ activeAccountId: accountId, folders: [] });
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
      ];
      for (const [name, subscribeOne] of on) {
        try {
          unsubscribers.push(subscribeOne());
        } catch (err) {
          // No event bridge (plain browser dev): the list still works, it just will not go live.
          console.warn(`[mobile] cannot listen to ${name}`, err?.message || err);
        }
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
