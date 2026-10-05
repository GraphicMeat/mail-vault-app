// Same window detection safeStorage uses for its write gate. Its own file so
// the store and the sync can both import it without a cycle.
export const isChildWindow = () => typeof window !== 'undefined'
  && ['compose', 'original', 'settings', 'social', 'export'].some(k => new URLSearchParams(window.location?.search || '').has(k));
