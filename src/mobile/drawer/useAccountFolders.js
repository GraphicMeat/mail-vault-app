// An account's folder list for the drawer's account sections, read when the section first opens
// (`mobile.folders.list`, a local read) and kept for as long as the drawer stays up. `failed`
// is a read that threw; the section says so and shows no folders.
import { useEffect, useState } from 'react';
import { daemonCall } from '../transport.js';

export function useAccountFolders(accountId, enabled) {
  const [state, setState] = useState({ status: 'idle', folders: [] });
  useEffect(() => {
    if (!enabled || state.status !== 'idle') return undefined;
    let live = true;
    setState({ status: 'loading', folders: [] });
    daemonCall('mobile.folders.list', { accountId }).then(
      (reply) => { if (live) setState({ status: 'ready', folders: reply?.folders ?? [] }); },
      () => { if (live) setState({ status: 'failed', folders: [] }); },
    );
    return () => { live = false; };
    // The first open reads; a later toggle keeps what was read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, accountId]);
  return state;
}
