import { useEffect, useState } from 'react';
import { IS_APPSTORE_BUILD, IAP_PRODUCT_BACKUPS } from '../utils/buildFlags';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';

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

/**
 * Whether backup to another drive is held behind Premium right now. Only the
 * direct build sells it as Premium (the App Store build has the purchase
 * above); without Premium the daemon writes nothing to the drive, so the UI
 * shows the drive as locked or paused instead of offering a picker that does
 * nothing.
 */
export function useDrivePremiumLocked() {
  const billingProfile = useSettingsStore(s => s.billingProfile);
  // A share grant unlocks Premium too: re-render when it changes.
  useSettingsStore(s => s.shareGrant);
  return !IS_APPSTORE_BUILD && !hasPremiumAccess(billingProfile);
}
