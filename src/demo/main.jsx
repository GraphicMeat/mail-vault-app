import React from 'react';
import ReactDOM from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { bindDemoSettingsStore, bindDemoThemeStore, initializeDemoSession, installDemoGlobals } from './runtime.js';
import { demoLocaleFromLocation } from './locale.js';
import '../styles/index.css';
import './demo-shell.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
initializeDemoSession()
  .then(() => {
    installDemoGlobals();
    // Both imports remain behind the hydration barrier. safeStorage captures
    // the Tauri invoke seam at module evaluation, so importing App or Shell
    // earlier would overwrite restored settings with the seed defaults.
    return Promise.all([import('../App.jsx'), import('./DemoShell.jsx'), import('../stores/settingsStore.js'), import('../stores/themeStore.js')]);
  })
  .then(async ([{ default: App }, { DemoShell }, { useSettingsStore }, { useThemeStore }]) => {
    const persist = useSettingsStore.persist;
    const themePersist = useThemeStore.persist;
    const awaitHydration = async candidate => {
      if (!candidate || candidate.hasHydrated?.()) return;
      await new Promise(resolve => {
        if (typeof candidate.onFinishHydration !== 'function') { resolve(); return; }
        candidate.onFinishHydration(() => resolve());
      });
    };
    await Promise.all([awaitHydration(persist), awaitHydration(themePersist)]);
    bindDemoSettingsStore(useSettingsStore);
    bindDemoThemeStore(useThemeStore);
    const { setLocale } = await import('../i18n/index.js');
    const explicitLocale = demoLocaleFromLocation();
    const persistedLocale = useSettingsStore.getState().language;
    await setLocale(explicitLocale || persistedLocale || 'en').catch(() => {});
    root.render(
      <React.StrictMode>
        <MotionConfig reducedMotion="user">
          <DemoShell><App /></DemoShell>
        </MotionConfig>
      </React.StrictMode>,
    );
  })
  .catch(error => {
    // Storage is best effort; a failed IndexedDB must never leave a blank
    // demo. Globals are still installed before the fallback import.
    installDemoGlobals();
    import('../App.jsx').then(({ default: App }) => root.render(<App />)).catch(() => {});
    console.warn('[MailVault demo] bootstrap fallback', error);
  });
