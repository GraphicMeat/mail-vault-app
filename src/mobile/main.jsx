// Mobile entry (mobile.html): picks the language (the stored one, else the system's), then mounts
// the app (App.jsx).
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/fonts.css';
import './tailwind-base.css';
import './shared-ui.css';
import './mobile.css';
import App from './App.jsx';
import { startMobileLocale } from './i18n.js';
import { daemonCall } from './transport.js';
import { applyLook, watchSystemTheme } from './prefs.js';
import { useMobileStore } from './store.js';
import { watchSwitchHaptics } from './haptics.js';

// The shared tokens need an explicit theme before the first paint (the defaults: the system's
// light or dark); the stored preferences replace it once read. `system` then follows the system.
applyLook(useMobileStore.getState().prefs);
watchSystemTheme(() => useMobileStore.getState().prefs);
// Every settings switch ticks (the desktop's own control, untouched).
watchSwitchHaptics();

// The language is picked before the first paint, so no string changes under the user at launch.
startMobileLocale(() => daemonCall('mobile.settings.get')).finally(() => {
  createRoot(document.getElementById('root')).render(<App />);
});
