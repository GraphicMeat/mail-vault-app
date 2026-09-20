import { listen } from '@tauri-apps/api/event';
import { send } from './transport.js';
import { onDaemonReconnected } from './searchIndex.js';

const PROGRESS_EVENT = 'mail-search-progress';

export async function startMailSearch(request, onProgress, onReconnect) {
  const unlistenProgress = await listen(PROGRESS_EVENT, event => {
    if (event?.event === PROGRESS_EVENT) onProgress?.(event.payload);
  });
  let acknowledged = false;
  let unlistenReconnect = null;
  const unlisten = () => {
    try { unlistenProgress?.(); } catch { /* Cleanup both event listeners independently. */ }
    try { unlistenReconnect?.(); } catch { /* The other listener is still released. */ }
  };

  try {
    unlistenReconnect = await onDaemonReconnected(() => {
      if (acknowledged) onReconnect?.();
    });
    await send('mail_search_start', request);
    acknowledged = true;
    return { unlisten };
  } catch (error) {
    unlisten();
    throw error;
  }
}

export async function cancelMailSearch(searchId) {
  try {
    await send('mail_search_cancel', { searchId });
  } catch (error) {
    console.warn('[mailSearch] cancellation failed:', error);
  }
}
