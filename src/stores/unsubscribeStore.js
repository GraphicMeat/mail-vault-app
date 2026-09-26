import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { openLink } from '../utils/editorLinks';
import { openMailtoCompose } from '../utils/mailto';

/**
 * What an unsubscribe needs, from a message (row, reader, Insights copy) or a
 * Settings > Unsubscribe sender row. Null when it has no List-Unsubscribe.
 */
export function unsubscribeTarget(source, accountId) {
  if (!source?.listUnsubscribe) return null;
  return {
    accountId: accountId || source._accountId || source.accountId || null,
    sender: source.from?.address || source.address || '',
    name: source.from?.name || source.name || '',
    listUnsubscribe: source.listUnsubscribe,
    listUnsubscribePost: source.listUnsubscribePost || null,
    authenticationResults: source.authenticationResults || null,
  };
}

/**
 * One unsubscribe flow for every surface: `request` opens the confirm dialog
 * (UnsubscribeHost), `confirm` asks the daemon (`unsubscribe` RPC), which
 * POSTs one-click itself or answers the fallback opened here. `version`
 * bumps after each attempt so Settings > Unsubscribe reloads its history.
 */
export const useUnsubscribeStore = create((set, get) => ({
  pending: null,
  busy: false,
  result: null,
  version: 0,

  request: target => { if (target) set({ pending: target, result: null }); },
  cancel: () => { if (!get().busy) set({ pending: null }); },
  dismissResult: () => set({ result: null }),

  confirm: async () => {
    const target = get().pending;
    if (!target || get().busy) return;
    const sender = target.name || target.sender;
    set({ busy: true });
    try {
      const answer = await daemonCall('unsubscribe', target);
      if (answer?.method === 'browser') await openLink(answer.url);
      else if (answer?.method === 'mailto' && !openMailtoCompose(answer.url, target.accountId)) await openLink(answer.url);
      const kind = answer?.status === 'ok' ? 'done' : answer?.method === 'mailto' ? 'openedMailto' : 'openedBrowser';
      set({ result: { type: kind === 'done' ? 'success' : 'info', kind, sender } });
    } catch (error) {
      console.warn('[unsubscribe] failed:', error?.message || error);
      set({ result: { type: 'error', kind: 'failed', sender } });
    } finally {
      set(state => ({ busy: false, pending: null, version: state.version + 1 }));
    }
  },
}));
