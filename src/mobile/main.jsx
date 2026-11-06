// Mobile entry (mobile.html). Plan 1 gate: ask the engine for `mobile.ping` through the same
// daemonClient desktop uses, show the reply, and write it to the app log as `MV_MOBILE <json>`.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { daemonCall } from './transport.js';

function logLine(payload) {
  const line = `MV_MOBILE ${JSON.stringify(payload)}`;
  console.log(line);
  // The shell copies the line to the platform log (stdout on iOS, logcat on Android).
  window.__TAURI__?.core?.invoke('mobile_log', { line }).catch(() => {});
}

function App() {
  const [result, setResult] = useState(null);

  useEffect(() => {
    daemonCall('mobile.ping').then(
      ping => {
        logLine({ ping });
        setResult({ ping });
      },
      err => {
        const error = { code: err?.code ?? null, message: err?.message ?? String(err) };
        logLine({ error });
        setResult({ error });
      },
    );
  }, []);

  return (
    <main style={{ padding: 'max(16px, env(safe-area-inset-top)) 16px 16px' }}>
      <pre data-testid="mobile-ping" style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>
        {result ? JSON.stringify(result, null, 2) : '…'}
      </pre>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
