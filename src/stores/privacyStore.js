import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage, flushSafeStorage } from './safeStorage';
import { hasPremiumAccess, useSettingsStore } from './settingsStore';
import { isChildWindow } from '../utils/privacy/isChildWindow';

/**
 * Privacy mode: people's names, addresses and numbers masked across the app,
 * for screen recordings and public places.
 *
 * Starting it is Premium; keeping it is not. A lapse never switches it off,
 * because that would unmask the screen in the middle of a recording. Same
 * rule as a running Focus session.
 *
 * `peek` (Option held), `captureMask` (a social capture forcing masks on
 * for a moment) and `dictWanted` (a redacted export needing the name
 * dictionary without masking the UI) are never persisted.
 */
export const usePrivacyStore = create(
  persist(
    (set) => ({
      enabled: false,
      peek: false,
      captureMask: false,
      dictWanted: false,
      setEnabled: (on) => {
        // A detached window follows the main window's event; it never diverges.
        if (isChildWindow()) return 'ok';
        if (on && !hasPremiumAccess(useSettingsStore.getState().billingProfile)) return 'premium';
        set({ enabled: !!on, peek: false });
        // A detached window reads this file at mount; write it now, not in 500 ms.
        flushSafeStorage().catch(() => {});
        return 'ok';
      },
      setPeek: (on) => set({ peek: !!on }),
      setCaptureMask: (on) => set({ captureMask: !!on }),
      setDictWanted: (on) => set({ dictWanted: !!on }),
    }),
    {
      name: 'mailvault-privacy',
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ enabled: s.enabled }),
      merge: (persisted, current) => ({ ...current, enabled: persisted ? !!persisted.enabled : current.enabled }),
    },
  ),
);

export const isPrivacyMasking = (s) => (s.enabled || s.captureMask) && !s.peek;
