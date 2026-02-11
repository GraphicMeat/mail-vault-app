import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';

// Debug: Log Tauri API availability at startup
console.log('=== MailVault Frontend Initializing ===');
console.log('[main.jsx] window.__TAURI__:', window.__TAURI__);
console.log('[main.jsx] window.__TAURI__.invoke:', window.__TAURI__?.invoke);
console.log('[main.jsx] All __TAURI__ keys:', window.__TAURI__ ? Object.keys(window.__TAURI__) : 'N/A');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
