import { useEffect, useRef } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useMessageListStore } from '../stores/messageListStore';
import { useSyncStore } from '../stores/syncStore';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { focusNative, noteProgress, readNativeStatus, resendNative, retireObservation, setNativeOnline, viewFacts }
  from '../services/nativePipeline';
import { refreshVaultSets } from '../services/workflows/refreshVaultSets';

/** The wait after a list paints, so the pass starts once the screen has settled. */
const FOCUS_DELAY_MS = 200;
/** Coalesces a burst of progress events into one read of the vault's saved set. */
const VAULT_REFRESH_MS = 300;

const warn = (what, error) => console.warn(`[pipeline] ${what}:`, error?.message || error);

/**
 * Presentation of the native download-ahead pipeline. The daemon owns the
 * queues, policy, retries and daily limits; this hook reports the view on screen
 * (debounced, with an online flag and an ever-growing revision), recovers after a
 * reconnect or an event lag by reading status and resending the latest view once,
 * and shows the saved set when a folder's body pass settles. Unmounting retires
 * this window's observation only: the daemon's work and in-flight children go on.
 */
export function usePipelineCoordinator() {
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const accounts = useAccountStore(s => s.accounts);
  const emails = useMessageListStore(s => s.emails);
  const loading = useSyncStore(s => s.loading);
  const activeMailbox = useMailStore(s => s.activeMailbox);
  const scoped = useMailStore(s => !!s.mailboxScope);
  const hidden = useSettingsStore(s => s.hiddenAccounts);

  const hasRows = emails.length > 0;
  // A new list page or a native repaint changes this; the debounce bounds the cost.
  const rowsKey = `${emails.length}:${emails[0]?.uid ?? ''}:${emails[emails.length - 1]?.uid ?? ''}`;
  const accountsKey = (accounts || []).map(a => a.id).join(',');
  const hiddenKey = Object.keys(hidden || {}).filter(id => hidden[id]).sort().join(',');
  const recovering = useRef(false);

  // Report the view after the list loads, 200ms after it last changed. A view
  // switch, a reload, an account added, hidden or removed all land here.
  useEffect(() => {
    if (!activeAccountId || !hasRows || loading) return undefined;
    const timer = setTimeout(() => {
      const facts = viewFacts(useMailStore.getState());
      if (facts) focusNative(facts).catch(error => warn('focus not delivered', error));
    }, FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [activeAccountId, activeMailbox, scoped, hasRows, rowsKey, loading, accountsKey, hiddenKey]);

  // Online and offline are facts about the window; the daemon decides what they pause.
  useEffect(() => {
    const change = isOnline => () => setNativeOnline(isOnline).catch(error => warn('online state not delivered', error));
    const up = change(true);
    const down = change(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // Progress events, a reconnect and an event lag. Every subscription handles a
  // rejection, a synchronous throw and disposal.
  useEffect(() => {
    let disposed = false;
    let vaultTimer = null;
    const offs = [];
    const recover = () => {
      if (recovering.current) return;
      recovering.current = true;
      // Status first (the daemon may have restarted or kept working), then the
      // latest view once under a newer revision: never a blind restart.
      readNativeStatus()
        .catch(error => warn('status unavailable', error))
        .then(() => resendNative())
        .catch(error => warn('focus not resent', error))
        .finally(() => { recovering.current = false; });
    };
    const progress = event => {
      try {
        const payload = event?.payload;
        noteProgress(payload);
        const view = useMailStore.getState();
        if (payload?.phase === 'done' && payload.accountId === view.activeAccountId && payload.mailbox === view.activeMailbox) {
          clearTimeout(vaultTimer);
          vaultTimer = setTimeout(() => { refreshVaultSets(payload.accountId, payload.mailbox); }, VAULT_REFRESH_MS);
        }
      } catch (error) { warn('progress not applied', error); }
    };
    import('@tauri-apps/api/event')
      .then(({ listen }) => Promise.allSettled([
        listen('pipeline-progress', progress),
        listen('daemon-reconnected', () => recover()),
        listen('daemon-events-lagged', () => recover()),
      ]))
      .then(results => {
        // One refused subscription must not strand the others: keep each that was granted
        // and release it on unmount (or at once, if the window is already gone).
        const handles = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        results.filter(result => result.status === 'rejected').forEach(result => warn('event subscription unavailable', result.reason));
        if (disposed) handles.forEach(off => off?.()); else offs.push(...handles);
      })
      .catch(error => warn('events unavailable', error));
    return () => {
      disposed = true;
      clearTimeout(vaultTimer);
      offs.splice(0).forEach(off => off?.());
      retireObservation();
    };
  }, []);
}
