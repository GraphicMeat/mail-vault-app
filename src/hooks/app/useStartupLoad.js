import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useMailStore } from '../../stores/mailStore';
import { bulkOperationManager, isDeleteBulkType } from '../../services/BulkOperationManager';
import { tErr } from '../../i18n/index.js';
import { openNotificationTarget, startNotificationDeleteBridge, startNotificationOpenBridge } from '../../utils/notificationOpen';
import { useCodeBubbleStore } from '../../stores/codeBubbleStore';

// Debug: log to Rust side via invoke
const debugLog = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  console.log(msg);
  window.__TAURI__?.core?.invoke?.('log_from_frontend', { message: msg }).catch(() => {});
};

export function useStartupLoad({ setPendingOperation, openMailFromSidebar }) {
  // Track if quick load is done
  const [quickLoadDone, setQuickLoadDone] = useState(false);
  const quickLoadHadAccountsRef = useRef(false);

  // Quick load: get accounts from disk ASAP, then activateAccount handles all email loading.
  useEffect(() => {
    const quickLoadAccounts = async () => {
      try {
        const db = await import('../../services/db');
        await db.initBasic();

        // Start keychain loading in background immediately — the macOS prompt
        // appears sooner, and getAccounts() in init() won't block as long.
        db.startKeychainLoad();

        const accounts = await db.getAccountsWithoutPasswords();
        // Before any pipeline can touch a Graph sidecar: folders written under
        // a localized name move under their storage key once.
        const { adoptGraphFolderKeys } = await import('../../services/workflows/adoptGraphFolderKeys');
        await adoptGraphFolderKeys(accounts);
        // One-time migration: move .eml files from email-address dirs to UUID dirs
        db.migrateMaildirEmailDirs(accounts).catch(() => {});
        quickLoadHadAccountsRef.current = accounts.length > 0;
        if (accounts.length > 0) {
          const { hiddenAccounts } = useSettingsStore.getState();
          const firstVisible = accounts.find(a => !hiddenAccounts[a.id]) || accounts[0];
          debugLog('[QuickLoad] Setting', accounts.length, 'accounts, firstVisible:', firstVisible.email);

          // Set accounts FIRST so the main UI renders immediately
          useMailStore.setState({
            accounts,
            activeAccountId: firstVisible.id,
            activeMailbox: 'INBOX',
            loading: true,
          });

          // Before the first paint: a delete still owed to the server from an
          // earlier session keeps its rows hidden. Deletes come from the
          // daemon's queue (`delete_queue.list`), purges from the journal.
          try {
            const { hideQueuedDeletes } = await import('../../services/workflows/messageMutations');
            // Capped: a daemon still starting must not hold the first paint.
            // If the cap wins, the queue's launch sync (wireDeleteQueueEvents
            // re-reads it once wired) hides the deletes, and the launch replay
            // hides the purges; that replay never touches delete entries.
            await Promise.race([hideQueuedDeletes(), new Promise(resolve => setTimeout(resolve, 300))]);
          } catch (e) {
            console.warn('[QuickLoad] Could not hide queued deletes:', e);
          }

          // activateAccount handles all local cache + server loading in parallel
          useMailStore.getState().activateAccount(firstVisible.id, 'INBOX')
            .catch(e => console.warn('[QuickLoad] activateAccount failed (non-fatal):', e));

          // Check for pending bulk operations
          try {
            const status = await bulkOperationManager.status();
            if (status.active) void bulkOperationManager.attach(status.active, () => {}).catch(error => {
              useMailStore.setState({ error: tErr(error) });
            });
            // An interrupted delete finishes on its own: its rows left the list
            // when it was clicked, and its journal entry owns any retry. Only
            // an archive run asks Resume or Discard.
            if (status.pending && isDeleteBulkType(status.pending.type)) {
              void bulkOperationManager.resume(status.pending, null, () => {}).catch(error => {
                console.warn('[QuickLoad] Could not resume the interrupted delete:', error);
              });
            } else if (status.pending) setPendingOperation(status.pending);
          } catch (e) {
            console.warn('[QuickLoad] Failed to check pending operations:', e);
          }
        }
      } catch (e) {
        console.error('[App] Quick load failed:', e);
      } finally {
        setQuickLoadDone(true);
      }
    };
    quickLoadAccounts();
  }, []);

  // A click on a new-mail banner, and Delete or Copy & delete on a code
  // banner. Gated on quick load: a press that launched the app is already
  // queued, and acting on it needs the accounts in the store.
  useEffect(() => {
    if (!quickLoadDone) return;
    let stops = [];
    let active = true;
    Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]).then(([{ invoke }, { listen }]) => {
      const bridges = [
        startNotificationOpenBridge({
          invoke,
          listen,
          open: (target) => {
            openMailFromSidebar();
            return openNotificationTarget(target, useMailStore.getState)
              .catch(e => console.warn('[notification] could not open the clicked email:', e));
          },
        }),
        // The code bubble's own delete (Trash, with its undo); its bubble goes too.
        startNotificationDeleteBridge({
          invoke,
          listen,
          remove: async ({ accountId, mailbox, uid }) => {
            await useMailStore.getState().deleteEmailFromServer(uid, { accountId, mailboxOverride: mailbox });
            useCodeBubbleStore.getState().dismiss(`${accountId}|${mailbox}|${uid}`);
          },
        }),
      ];
      stops = bridges.map(b => b.stop);
      if (!active) stops.forEach(stop => stop());
    }).catch(() => {}); // not in Tauri
    return () => { active = false; stops.forEach(stop => stop()); };
  }, [quickLoadDone, openMailFromSidebar]);

  return { quickLoadDone, quickLoadHadAccountsRef };
}
