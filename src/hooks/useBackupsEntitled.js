import { useEffect, useState } from 'react';
import { IS_APPSTORE_BUILD, IAP_PRODUCT_BACKUPS } from '../utils/buildFlags';

/**
 * Whether external backups are unlocked. Non-MAS builds always are; the Mac
 * App Store build asks StoreKit once on mount (the shell's save command
 * refuses an external folder without it). Settings > Backup and the onboarding
 * storage step share this so both gate the backup folder the same way.
 * The setter is for Settings' purchase / restore flow.
 */
export function useBackupsEntitled() {
  const [entitled, setEntitled] = useState(!IS_APPSTORE_BUILD);
  useEffect(() => {
    const inv = window.__TAURI__?.core?.invoke;
    if (!inv || !IS_APPSTORE_BUILD) return;
    inv('iap_is_entitled', { productId: IAP_PRODUCT_BACKUPS })
      .then(v => setEntitled(!!v))
      .catch(() => setEntitled(false));
  }, []);
  return [entitled, setEntitled];
}
