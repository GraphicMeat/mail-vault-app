// Mobile entry (mobile.html). Plan 1 gate: the message list over `mobile.messages.page`, a viewer
// stub on tap, and with `?perf=1` the perf probe, whose result the engine logs as
// `MV_MOBILE {"perf":…}`. The `mobile.ping` line is logged first: scripts/mobile-run.sh waits for it.
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/fonts.css';
import './mobile.css';
import { daemonCall } from './transport.js';
import { createPageCache, LIST_ACCOUNT, LIST_FOLDER } from './messagePages.js';
import MessageList from './MessageList.jsx';
import ViewerStub from './ViewerStub.jsx';
import { runPerfGate } from './perf.js';
import { useT } from './i18n.js';

function logLine(payload) {
  const line = `MV_MOBILE ${JSON.stringify(payload)}`;
  console.log(line);
  // The shell copies the line to the platform log (unified log on iOS, logcat on Android).
  window.__TAURI__?.core?.invoke('mobile_log', { line }).catch(() => {});
}

const errorOf = (err) => ({ code: err?.code ?? null, message: err?.message ?? String(err) });

const cache = createPageCache((offset, limit) =>
  daemonCall('mobile.messages.page', { accountId: LIST_ACCOUNT, folder: LIST_FOLDER, offset, limit }),
);

const PERF = new URLSearchParams(window.location.search).get('perf') === '1';
let perfStarted = false;

// One probe per launch, even if the list loads twice (a retry after a failed first page).
async function perfRun() {
  if (perfStarted) return;
  perfStarted = true;
  let result;
  try {
    result = await runPerfGate();
  } catch (err) {
    result = { pass: false, reasons: [`probe failed: ${errorOf(err).message}`], webview: navigator.userAgent };
  }
  try {
    await daemonCall('mobile.perf.report', result);
  } catch (err) {
    logLine({ error: errorOf(err) });
  }
}

function App() {
  const t = useT();
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'failed'
  const [open, setOpen] = useState(null);

  const load = useCallback(() => {
    setState('loading');
    cache.ensure(0).then(
      () => setState('ready'),
      (err) => {
        logLine({ error: errorOf(err) });
        setState('failed');
      },
    );
  }, []);

  useEffect(() => {
    daemonCall('mobile.ping').then(
      (ping) => logLine({ ping }),
      (err) => logLine({ error: errorOf(err) }),
    );
    load();
  }, [load]);

  useEffect(() => {
    if (PERF && state === 'ready') perfRun();
  }, [state]);

  const onOpen = useCallback((row) => setOpen(row), []);
  const onClose = useCallback(() => setOpen(null), []);
  const total = cache.total ?? 0;

  return (
    <div className="mv-app">
      <header className="mv-header">
        <h1 className="mv-header__title">{t('sidebar.inbox')}</h1>
        {state === 'ready' && <span className="mv-header__count">{t('common.messageCount', { count: total })}</span>}
      </header>
      {state === 'ready' && <MessageList cache={cache} onOpen={onOpen} />}
      {state === 'loading' && <p className="mv-status">{t('explorer.loading')}</p>}
      {state === 'failed' && (
        <div className="mv-status">
          <p>{t('mobile.list.loadFailed')}</p>
          <button type="button" onClick={load}>{t('common.retry')}</button>
        </div>
      )}
      {open && <ViewerStub key={open.uid} row={open} onClose={onClose} />}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
