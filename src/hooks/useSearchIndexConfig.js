import { useEffect } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { configure } from '../services/searchIndex';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent || '');

/** What the index should actually do: the switches, gated by plan and platform. */
export function effectiveSearchIndexConfig(state, { isMac = IS_MAC } = {}) {
  const premium = hasPremiumAccess(state.billingProfile);
  const attachments = !!state.searchIndexAttachments && premium;
  return { bodies: state.searchIndexBodies !== false, attachments, imageText: attachments && !!state.searchIndexImageText && isMac };
}

/** Pushes the effective index config to the app whenever it can change. */
export function useSearchIndexConfig() {
  useEffect(() => {
    let last = '';
    const push = () => {
      // Settings hydrate from disk through a Promise. Pushing the defaults
      // first would start a body sweep the user's saved `false` then undoes.
      if (useSettingsStore.persist?.hasHydrated?.() === false) return;
      const next = effectiveSearchIndexConfig(useSettingsStore.getState());
      const key = JSON.stringify(next);
      if (key === last) return; // the store changes often; the config rarely
      last = key;
      configure(next);
    };
    const unsubHydrate = useSettingsStore.persist?.onFinishHydration?.(push);
    push();
    const unsub = useSettingsStore.subscribe(push);
    return () => { unsubHydrate?.(); unsub(); };
  }, []);
}
