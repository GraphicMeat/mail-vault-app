import purple from '../assets/mailvault-icon.png';
import teal from '../assets/mailvault-icon-teal.png';

export const APP_ICONS = Object.freeze({ purple, teal });
export const normalizeAppIcon = value => value === 'teal' ? 'teal' : 'purple';

export async function applyAppIcon(value) {
  const icon = normalizeAppIcon(value);
  if (window.__TAURI__) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_app_icon', { icon });
  }
  let favicon = document.querySelector('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement('link');
    favicon.rel = 'icon';
    document.head.appendChild(favicon);
  }
  favicon.href = APP_ICONS[icon];
}

export function watchAppIcon(store) {
  let current;
  const apply = state => {
    const icon = normalizeAppIcon(state.appIcon);
    if (icon === current) return;
    current = icon;
    void applyAppIcon(icon).catch(error => {
      current = undefined;
      console.warn('[appIcon] Could not apply saved icon:', error);
    });
  };
  const hydrated = () => store.persist?.hasHydrated?.() ?? true;
  if (hydrated()) apply(store.getState());
  const stopHydration = store.persist?.onFinishHydration?.(apply);
  const stop = store.subscribe(state => { if (hydrated()) apply(state); });
  return () => { stop(); stopHydration?.(); };
}
