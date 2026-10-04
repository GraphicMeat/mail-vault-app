import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage } from './safeStorage';

// What the reader surfaces render in: the transient capture override (the
// social export shooting the app in the other theme) or the real theme.
export const selectTheme = (s) => s.captureTheme ?? s.theme;

export const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: 'dark', // 'light' | 'dark'
      palette: 'graphite', // 'indigo' | 'graphite'; independent of light/dark
      // Transient override for a capture ('light' | 'dark' | null); never
      // persisted and kept apart from `theme` so nothing that follows the real
      // theme (other windows, settings) sees it.
      captureTheme: null,
      // Transient mail (message content) theme for a capture, over the reader's
      // own choice; never persisted, like captureTheme.
      captureMailTheme: null,

      toggleTheme: () => {
        const newTheme = get().theme === 'dark' ? 'light' : 'dark';
        set({ theme: newTheme });
        document.documentElement.setAttribute('data-theme', newTheme);
      },
      
      setTheme: (theme) => {
        if (!['light', 'dark'].includes(theme)) return;
        set({ theme });
        document.documentElement.setAttribute('data-theme', theme);
      },

      setCaptureTheme: (theme) => {
        const next = theme === 'light' || theme === 'dark' ? theme : null;
        set({ captureTheme: next });
        document.documentElement.setAttribute('data-theme', next ?? get().theme);
      },

      setCaptureMailTheme: (theme) => {
        set({ captureMailTheme: theme === 'light' || theme === 'dark' ? theme : null });
      },

      setPalette: (palette) => {
        if (!['indigo', 'graphite'].includes(palette)) return;
        set({ palette });
        document.documentElement.setAttribute('data-palette', palette);
      },
      
      initTheme: () => {
        const theme = get().captureTheme ?? get().theme;
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-palette', get().palette || 'graphite');
      }
    }),
    {
      name: 'mailvault-theme',
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ theme: s.theme, palette: s.palette }),
      onRehydrateStorage: () => (state) => state?.initTheme(),
    }
  )
);
