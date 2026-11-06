// Mobile entry (mobile.html): picks the language, then mounts the app (App.jsx).
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/fonts.css';
import './mobile.css';
import App from './App.jsx';
import { loadMobileLocale } from './i18n.js';

// The language is picked before the first paint, so no string ever changes under the user.
loadMobileLocale().finally(() => {
  createRoot(document.getElementById('root')).render(<App />);
});
