import { listen } from '@tauri-apps/api/event';
import { send } from './transport.js';

const PROGRESS_EVENT = 'mail-search-progress';

export async function startMailSearch(request, onProgress) {
  const unlisten = await listen(PROGRESS_EVENT, event => {
    if (event?.event === PROGRESS_EVENT) onProgress?.(event.payload);
  });

  try {
    await send('mail_search_start', request);
    return { unlisten };
  } catch (error) {
    try { unlisten?.(); } catch { /* Preserve the start failure. */ }
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
