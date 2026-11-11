// The mobile app's state: accounts, the active account's folders, the open folder's message list
// and each account's sync state, over the `mobile.*` RPCs and engine events.
//
// Actions (`act`): read, unread, flag and unflag go to `mobile.actions.apply` at once. A move or a
// delete is deferred on this side: its rows leave the list at once (`list.hide`), an undo toast
// shows for UNDO_MS, and only then is it applied, or sooner when the page is hidden or unloaded,
// the account or folder changes, or the next move or delete comes (one deferred action at a time;
// a delete in the viewer that opens the next message keeps its own toast).
// Undo forgets it and shows the rows again; nothing reached the engine. A killed app can lose an
// unsent move or delete, which keeps the mail.
//
// Outbox (`outbox`): the rows `mobile.outbox.list` still holds (queued, sending, failed, uncertain),
// re-read on start, on resume, after a send and on every `mobile.send.result`. A failed or
// uncertain send shows a toast once per message and outcome. Store-free of the
// desktop: it imports nothing from src/stores, and reaches the engine only through transport.js
// with literal method and event names (the seam test reads them off this file).
import { create } from 'zustand';
import { daemonCall, listen } from './transport.js';
import { createPageCache, PAGE_SIZE } from './messagePages.js';
import { errorCodeOf, errorKey } from './errors.js';
import { oauthSignIn, oauthReauth, cancelOAuth } from './oauth.js';

// The import's own refusals (`mobile.transfer.import`), shown by ImportFromDesktop.
const IMPORT_CODES = ['BAD_PASSWORD', 'PASSWORD_SHORT', 'INVALID'];

export const STORAGE_ACCOUNT = 'mv.mobile.activeAccount';
export const STORAGE_FOLDER = 'mv.mobile.activeFolder';
/** The last searches typed, newest first. Page storage only: they never reach the engine. */
export const STORAGE_RECENT_SEARCHES = 'mv.mobile.recentSearches';
export const RECENT_SEARCHES = 8;
export const INBOX = 'INBOX';
/** How long a move or delete waits for an undo before it is applied. */
export const UNDO_MS = 5000;
/** Most uids one `mobile.actions.apply` takes. */
export const MAX_APPLY = 199;
const HIDES = new Set(['move', 'delete']);
const DROP_REASONS = new Set(['GONE', 'FOLDER_GONE', 'REFUSED']);
/** Send outcomes that are news: each to its toast. Literal keys for the catalog tests. */
const SEND_TOASTS = Object.freeze({
  failed: 'mobile.outbox.toast.failed',
  uncertain: 'mobile.outbox.toast.uncertain',
});

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

function savedSearches() {
  try {
    const saved = JSON.parse(readStorage(STORAGE_RECENT_SEARCHES) || '[]');
    return Array.isArray(saved) ? saved.filter((q) => typeof q === 'string' && q.trim()).slice(0, RECENT_SEARCHES) : [];
  } catch {
    return [];
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
  /** `id:outcome` of the send toasts already shown. */
  const toasted = new Set();

  return create((set, get) => {
    const notice = (key) => set({ notice: { id: ++serial, key } });

    function sendToast(id, outcome) {
      if (!id || !Object.hasOwn(SEND_TOASTS, outcome) || toasted.has(`${id}:${outcome}`)) return;
      toasted.add(`${id}:${outcome}`);
      notice(SEND_TOASTS[outcome]);
    }

    async function loadOutbox() {
      let rows;
      try {
        rows = await daemonCall('mobile.outbox.list');
      } catch {
        return; // the row is a hint: a failed read keeps the last one
      }
      const outbox = Array.isArray(rows) ? rows : [];
      // A row left uncertain by a crash has no event: its toast comes from the list.
      for (const r of outbox) sendToast(r.id, r.state);
      set({ outbox });
    }

    /** The active account's local drafts, newest first (the drawer's Drafts entry and list). */
    async function loadDrafts() {
      const accountId = get().activeAccountId;
      if (!accountId) return;
      let rows;
      try {
        rows = await daemonCall('mobile.drafts.list');
      } catch {
        return; // a hint: a failed read keeps the last list
      }
      if (get().activeAccountId !== accountId) return;
      set({ drafts: (Array.isArray(rows) ? rows : []).filter((d) => d.accountId === accountId) });
    }

    /** The active account's follow-up reminders, soonest first (the drawer's Follow up entry). */
    async function loadFollowUps() {
      const accountId = get().activeAccountId;
      if (!accountId) return;
      let reply;
      try {
        reply = await daemonCall('mobile.followup.list');
      } catch {
        return; // a hint: a failed read keeps the last list
      }
      if (get().activeAccountId !== accountId) return;
      const items = Array.isArray(reply?.items) ? reply.items : [];
      set({ followUps: items.filter((f) => f.accountId === accountId) });
    }

    function onSendResult(p) {
      if (!p?.id) return;
      if (p.outcome === 'sent') set((s) => ({ outbox: s.outbox.filter((r) => r.id !== p.id) }));
      sendToast(p.id, p.outcome);
      loadOutbox();
    }

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
      return { ok: !failed, skipped };
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
      set({ activeAccountId: accountId, folders: [], pending: 0, drafts: [], followUps: [] });
      loadPending();
      loadDrafts();
      loadFollowUps();
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
      if (!get().autoSync) return;
      // New mail live on the account now in front (the engine stops the previous one's listener).
      get().appState();
      await get().refresh();
    }

    function onFolderChanged(p) {
      if (!p || !p.accountId) return;
      const s = get();
      if (p.accountId === s.activeAccountId && p.folder === s.activeFolder && s.list) {
        if (s.list.invalidate(p.listGen)) set({ listGen: s.list.listGen });
      }
      loadFoldersQuietly(p.accountId);
    }

    /** A newly added account: listed, then opened at its inbox. */
    async function adopt(account) {
      set((s) => ({ accounts: [...s.accounts.filter((a) => a.id !== account.id), account], unread: { ...s.unread, [account.id]: 0 } }));
      await activate(account.id, INBOX);
    }

    function subscribe() {
      const on = [
        ['mobile.folder.changed', () => listen('mobile.folder.changed', onFolderChanged)],
        ['mobile.folders.changed', () => listen('mobile.folders.changed', (p) => p?.accountId && loadFoldersQuietly(p.accountId))],
        ['mobile.sync.state', () => listen('mobile.sync.state', (p) => {
          if (!p?.accountId) return;
          set((s) => ({
            syncState: { ...s.syncState, [p.accountId]: { state: p.state, code: p.code ?? null, at: Date.now() } },
            // A lapsed provider sign-in parks the account, and a refused password holds it: the
            // banner and the switcher say so now. A pass that ends well lifts the hold.
            accounts: s.accounts.map((a) => {
              if (a.id !== p.accountId) return a;
              if (p.code === 'NEEDS_AUTH') return { ...a, needsAuth: true };
              if (p.held === true && !a.authRefused) return { ...a, authRefused: true };
              if (p.state === 'idle' && a.authRefused) return { ...a, authRefused: false };
              return a;
            }),
          }));
        })],
        // Results sent before this subscribed are lost: the chip is re-read on start and resume.
        ['mobile.action.result', () => listen('mobile.action.result', onActionResult)],
        ['mobile.send.result', () => listen('mobile.send.result', onSendResult)],
        ['mobile.followup.due', () => listen('mobile.followup.due', () => loadFollowUps())],
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
          else {
            loadPending();
            loadOutbox();
            loadFollowUps();
          }
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
      outbox: [], // unsent messages: [{ id, accountId, subject, state, lastError, scheduledMs, notBeforeMs }]
      recentSearches: savedSearches(),
      drafts: [], // the active account's drafts: [{ id, accountId, to, subject, updatedMs }]
      followUps: [], // the active account's reminders: [{ id, accountId, subject, recipients, sentAt, remindAt, state, folder, uid, seen }]
      premium: { premium: false, source: null, expiresMs: null }, // the engine's Premium answer (premium.js keeps it current)
      premiumLost: null, // 'DEVICE_REPLACED' once the account gave this phone's place to another device
      premiumLapsed: false, // Premium was on in this session and has ended
      paywall: null, // the paywall layer: { feature, signIn } while open, else null
      reauthState: null, // the last "Sign in again": { accountId, busy, code } (code null when fine)

      /**
       * Applies `kind` (seen|unseen|flag|unflag|move|delete) to `uids` of `folder`. A move or
       * delete is deferred (see the top of this file); resolves once anything it sent is applied.
       * An immediate kind resolves to `{ok, skipped}` (ok false when an apply call failed).
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
      loadOutbox,
      loadDrafts,
      loadFollowUps,

      /** Ends a follow-up reminder. False when the engine refused. */
      async dismissFollowUp(id) {
        try {
          await daemonCall('mobile.followup.dismiss', { id });
          set((s) => ({ followUps: s.followUps.filter((f) => f.id !== id) }));
          return true;
        } catch {
          notice('mobile.followUp.dismissFailed');
          return false;
        } finally {
          loadFollowUps();
        }
      },

      /** The user opened a reminder's Sent copy: it stays listed, and is never posted after. */
      followUpSeen(id) {
        set((s) => ({ followUps: s.followUps.map((f) => (f.id === id ? { ...f, seen: true } : f)) }));
        daemonCall('mobile.followup.seen', { id }).catch(() => {});
      },

      /** Takes the engine's Premium answer `{ premium, source, expiresMs }`; a lapse is remembered. */
      setPremium(next) {
        const on = next?.premium === true;
        set((s) => ({
          premium: { premium: on, source: on ? next.source ?? null : null, expiresMs: on ? next.expiresMs ?? null : null },
          premiumLost: on ? null : s.premiumLost,
          premiumLapsed: on ? false : s.premiumLapsed || s.premium.premium,
        }));
      },

      setPremiumLost(code) {
        set({ premiumLost: code ?? null });
      },

      /** Opens the paywall; `feature` (scheduledSend | followUp | trackerBlocking) is highlighted. */
      openPaywall(feature = null, { signIn = false } = {}) {
        set({ paywall: { feature, signIn } });
      },

      closePaywall() {
        set({ paywall: null });
      },

      /** Remembers a search (newest first, one per text, the last RECENT_SEARCHES kept). */
      addRecentSearch(query) {
        const q = String(query ?? '').trim();
        if (!q) return;
        const next = [q, ...get().recentSearches.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_SEARCHES);
        writeStorage(STORAGE_RECENT_SEARCHES, JSON.stringify(next));
        set({ recentSearches: next });
      },

      clearRecentSearches() {
        writeStorage(STORAGE_RECENT_SEARCHES, null);
        set({ recentSearches: [] });
      },

      /** Deletes a draft (and the files only it held). False when the engine refused. */
      async deleteDraft(id) {
        try {
          await daemonCall('mobile.drafts.delete', { id });
          set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) }));
          return true;
        } catch {
          notice('mobile.drafts.deleteFailed');
          return false;
        } finally {
          loadDrafts();
        }
      },

      /** Sends a failed or uncertain message again. False when the engine refused. */
      async retryOutbox(id) {
        try {
          await daemonCall('mobile.outbox.retry', { id });
          // A new attempt that fails again is news again.
          toasted.delete(`${id}:failed`);
          toasted.delete(`${id}:uncertain`);
          set((s) => ({ outbox: s.outbox.map((r) => (r.id === id ? { ...r, state: 'queued' } : r)) }));
          return true;
        } catch {
          notice('mobile.outbox.actionFailed');
          return false;
        } finally {
          loadOutbox();
        }
      },

      /**
       * Moves a scheduled message to `sendAtMs`. False when the engine refused: past 5 minutes
       * without Premium, past a day, or no longer waiting (it went meanwhile).
       */
      async rescheduleOutbox(id, sendAtMs) {
        try {
          await daemonCall('mobile.outbox.reschedule', { id, sendAtMs });
          set((s) => ({ outbox: s.outbox.map((r) => (r.id === id ? { ...r, scheduledMs: sendAtMs, notBeforeMs: sendAtMs } : r)) }));
          return true;
        } catch (err) {
          const code = err?.code;
          notice(code === 'PREMIUM_REQUIRED' || code === 'SCHEDULE_TOO_FAR' ? errorKey(code) : 'mobile.outbox.actionFailed');
          return false;
        } finally {
          loadOutbox();
        }
      },

      /** Drops an unsent message. False when the engine refused (it is being sent). */
      async discardOutbox(id) {
        try {
          await daemonCall('mobile.outbox.discard', { id });
          set((s) => ({ outbox: s.outbox.filter((r) => r.id !== id) }));
          return true;
        } catch {
          notice('mobile.outbox.actionFailed');
          return false;
        } finally {
          loadOutbox();
        }
      },

      dismissNotice(id) {
        if (get().notice?.id === id) set({ notice: null });
      },

      /** Shows a one-line notice (a catalog key), as a dropped action does. */
      showNotice(key) {
        notice(key);
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
          loadOutbox();
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
          reply = await daemonCall('mobile.accounts.add', form.kind === 'jmap' ? {
            kind: 'jmap',
            email: form.email,
            password: form.password,
            ...(form.jmapUrl ? { jmapUrl: form.jmapUrl } : {}),
            ...(form.displayName ? { displayName: form.displayName } : {}),
          } : {
            email: form.email,
            password: form.password,
            imapHost: form.imapHost,
            imapPort: form.imapPort,
            security: form.security,
            smtpHost: form.smtpHost,
            smtpPort: form.smtpPort,
            smtpSecurity: form.smtpSecurity,
            ...(form.displayName ? { displayName: form.displayName } : {}),
          });
        } catch (err) {
          return { ok: false, code: errorCodeOf(err?.code) };
        }
        if (!reply?.ok) {
          const code = errorCodeOf(reply?.code);
          // A JMAP server on another domain: the form asks before the password goes there.
          if (code === 'CONFIRM_HOST') return { ok: false, code, host: reply.host, jmapUrl: reply.jmapUrl };
          return { ok: false, code };
        }
        await adopt(reply.account);
        return { ok: true };
      },

      /**
       * "Import from computer": the engine opens the set-up code's `frames` with `password` and
       * stores its accounts (`mobile.transfer.import`, no sign-in). Answers `{ ok: true, imported,
       * existing, skipped }` or `{ ok: false, code }` (`BAD_PASSWORD`, `PASSWORD_SHORT`, `INVALID`,
       * else an accounts code or `INTERNAL`). The new accounts are listed at once; the open one
       * stays until `openImported`, so the result screen is not replaced under the user.
       * Never keeps the password.
       */
      async importFromDesktop({ frames, password }) {
        let reply;
        try {
          reply = await daemonCall('mobile.transfer.import', { frames, password });
        } catch (err) {
          return { ok: false, code: errorCodeOf(err?.code) };
        }
        if (!reply?.ok) {
          const code = IMPORT_CODES.includes(reply?.code) ? reply.code : errorCodeOf(reply?.code);
          return { ok: false, code };
        }
        const result = {
          ok: true,
          imported: Array.isArray(reply.imported) ? reply.imported : [],
          existing: Array.isArray(reply.existing) ? reply.existing : [],
          skipped: Array.isArray(reply.skipped) ? reply.skipped.map((s) => ({ email: s?.email, reason: s?.reason })) : [],
        };
        if (result.imported.length) {
          try {
            const { accounts } = await daemonCall('mobile.accounts.list');
            const known = new Set(get().accounts.map((a) => a.id));
            set((s) => ({
              accounts,
              unread: Object.fromEntries(accounts.map((a) => [a.id, s.unread[a.id] ?? 0])),
            }));
            for (const a of accounts) if (!known.has(a.id)) loadFoldersQuietly(a.id);
          } catch {
            // Stored all the same: the next launch lists them.
          }
        }
        return result;
      },

      /** Opens the first of the imported addresses, as an added account is opened. */
      async openImported(imported) {
        const first = Array.isArray(imported) && imported.length
          ? get().accounts.find((a) => a.email?.toLowerCase() === String(imported[0]).toLowerCase())
          : null;
        if (first) await activate(first.id, INBOX);
      },

      /**
       * Adds an account through the provider's sign-in sheet (`google` | `microsoft`, oauth.js)
       * and opens it. `{ok}` or `{ok: false, code}`; `CANCELLED` when the user closed the sheet.
       */
      /** Ends the running sign-in or reauth (the in-app Cancel); its call then answers `CANCELLED`. */
      cancelSignIn() {
        cancelOAuth();
      },

      async signIn(provider) {
        const result = await oauthSignIn(provider);
        if (!result.ok) return result;
        await adopt(result.account);
        return { ok: true };
      },

      /**
       * The user's Retry on an account whose password the server refused: the engine tries it
       * exactly once (`mobile.accounts.retrySignIn`); its pass's end says how it went.
       */
      async retrySignIn(accountId) {
        try {
          await daemonCall('mobile.accounts.retrySignIn', { accountId });
          return { ok: true };
        } catch (err) {
          return { ok: false, code: errorCodeOf(err?.code) };
        }
      },

      /**
       * Signs a parked (`needsAuth`) account in again. On success the row is replaced, its sync
       * error cleared, and the open account syncs.
       */
      async reauth(accountId) {
        // One run, whichever control started it: the banner and the switcher both read this.
        if (get().reauthState?.busy) return { ok: false, code: 'SIGNIN_BUSY' };
        set({ reauthState: { accountId, busy: true, code: null } });
        const result = await oauthReauth(accountId);
        // A cancel is the user's own choice and says nothing; any other failure stays on show.
        const code = result.ok || result.code === 'CANCELLED' ? null : result.code;
        set({ reauthState: { accountId, busy: false, code } });
        if (!result.ok) return result;
        const account = { ...result.account, needsAuth: false };
        set((s) => {
          const { [accountId]: _state, ...syncState } = s.syncState;
          return { accounts: s.accounts.map((a) => (a.id === accountId ? { ...a, ...account } : a)), syncState };
        });
        if (get().activeAccountId === accountId) {
          // A parked account's live listener ended; signed in again, it listens again.
          if (get().autoSync) get().appState();
          await get().refresh();
        }
        return { ok: true };
      },

      async removeAccount(id) {
        // A deferred action of the account being removed is dropped unsent: nothing can apply it.
        const dropped = deferred?.accountId === id ? deferred : null;
        if (dropped) {
          clearTimeout(dropped.timer);
          if (get().undo?.id === dropped.id) set({ undo: null });
          deferred = null;
        }
        try {
          await daemonCall('mobile.accounts.remove', { accountId: id });
        } catch (err) {
          // The account stays: its dropped action's rows come back, and the switcher keeps asking.
          dropped?.list?.unhide(dropped.uids);
          notice('mobile.switcher.removeFailed');
          throw err;
        }
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
          get().appState();
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

      /**
       * Opens `folder` of `accountId` (a notification tap): the account in front, then the folder,
       * INBOX when the account has no such folder. Resolves once the list is the new one.
       */
      async openAt(accountId, folder) {
        if (!get().accounts.some((a) => a.id === accountId)) return false;
        if (get().activeAccountId !== accountId) await activate(accountId, folder);
        else await get().selectFolder(folder);
        return get().activeAccountId === accountId;
      },

      async selectFolder(path) {
        const { activeAccountId, activeFolder } = get();
        if (!activeAccountId) return;
        if (path !== activeFolder) open(activeAccountId, path);
        await get().refresh();
      },

      /**
       * Tells the engine whether the page is in front and on which account, so it listens for new
       * mail on that account's INBOX while the app is open (and on nothing in the background).
       * Sent on every visibility change (`resumed` when visible again) and account switch; a
       * failure is left to the next one.
       */
      async appState(foreground = isForeground(), resumed = false) {
        const { activeAccountId: accountId } = get();
        const params = accountId ? { foreground, accountId } : { foreground };
        // Back in the front after being away: the engine replaces a listener whose connection may
        // have died silently meanwhile (a network change, a carrier NAT timeout).
        if (foreground && resumed) params.resumed = true;
        try {
          await daemonCall('mobile.app.state', params);
        } catch {
          // Nothing to show: the list still refreshes by hand and on the next foreground.
        }
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

/** The page is on screen (no document, as in a unit test without jsdom: assume so). */
function isForeground() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** The app's one store. */
export const useMobileStore = createMobileStore();
