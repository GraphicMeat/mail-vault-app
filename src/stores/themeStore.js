import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: 'dark', // 'light' | 'dark'
      
      toggleTheme: () => {
        const newTheme = get().theme === 'dark' ? 'light' : 'dark';
        set({ theme: newTheme });
        document.documentElement.setAttribute('data-theme', newTheme);
      },
      
      setTheme: (theme) => {
        set({ theme });
        document.documentElement.setAttribute('data-theme', theme);
      },
      
      initTheme: () => {
        const theme = get().theme;
        document.documentElement.setAttribute('data-theme', theme);
      }
    }),
    {
      name: 'mailvault-theme'
    }
  )
);
