import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage } from './safeStorage';

export const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: 'dark', // 'light' | 'dark'
      palette: 'indigo', // 'indigo' | 'graphite'; independent of light/dark
      
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

      setPalette: (palette) => {
        if (!['indigo', 'graphite'].includes(palette)) return;
        set({ palette });
        document.documentElement.setAttribute('data-palette', palette);
      },
      
      initTheme: () => {
        const theme = get().theme;
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-palette', get().palette || 'indigo');
      }
    }),
    {
      name: 'mailvault-theme',
      storage: createJSONStorage(() => safeStorage),
      onRehydrateStorage: () => (state) => state?.initTheme(),
    }
  )
);
