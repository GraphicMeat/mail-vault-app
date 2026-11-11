// Mobile entry (mobile.html): picks the language (the stored one, else the system's), then mounts
// the app (App.jsx).
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/fonts.css';
import './mobile.css';
import App from './App.jsx';
import { startMobileLocale } from './i18n.js';
import { daemonCall } from './transport.js';

// The language is picked before the first paint, so no string changes under the user at launch.
startMobileLocale(() => daemonCall('mobile.settings.get')).finally(() => {
  createRoot(document.getElementById('root')).render(<App />);
});
