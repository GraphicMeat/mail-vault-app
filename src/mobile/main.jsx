// Mobile entry (mobile.html): the account header, folder drawer, account switcher, add-account
// screen and the live message list over the mobile store (`store.js`), a viewer stub on tap, and
// with `?perf=1` the perf probe, whose result the engine logs as `MV_MOBILE {"perf":…}`. With
// `?probe=host:port` (perf-gate builds) it logs one `MV_MOBILE {"probe":…}` line: DNS + TLS to that
// host and a secret store round trip. `?ui=switcher|drawer` opens that panel at start (for
// screenshots). The `mobile.ping` line is logged first: scripts/mobile-run.sh waits for it.
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/fonts.css';
import './mobile.css';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import MessageList from './MessageList.jsx';
import ViewerStub from './ViewerStub.jsx';
import AddAccount from './AddAccount.jsx';
import AccountSwitcher, { Avatar } from './AccountSwitcher.jsx';
import FolderDrawer from './FolderDrawer.jsx';
import { folderLabel } from './folders.js';
import { errorKey } from './errors.js';
import { runPerfGate } from './perf.js';
import { loadMobileLocale, useT } from './i18n.js';

function logLine(payload) {
  const line = `MV_MOBILE ${JSON.stringify(payload)}`;
  console.log(line);
  // The shell copies the line to the platform log (unified log on iOS, logcat on Android).
  window.__TAURI__?.core?.invoke('mobile_log', { line }).catch(() => {});
}

const errorOf = (err) => ({ code: err?.code ?? null, message: err?.message ?? String(err) });

const QUERY = new URLSearchParams(window.location.search);
const PERF = QUERY.get('perf') === '1';
const START_PANEL = ['switcher', 'drawer'].includes(QUERY.get('ui')) ? QUERY.get('ui') : null;
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

const PROBE = QUERY.get('probe');

// Device proof for the core link: the engine resolves and handshakes through core's TLS seam,
// then sets, reads and deletes a dummy secret (booleans only, never the value).
async function probeRun(target) {
  const at = target.lastIndexOf(':');
  const host = target.slice(0, at);
  const port = Number(target.slice(at + 1));
  const out = {};
  try {
    Object.assign(out, await daemonCall('mobile.debug.probe', { host, port }));
  } catch (err) {
    out.error = errorOf(err);
  }
  try {
    out.secrets = await daemonCall('mobile.debug.secretsRoundTrip');
  } catch (err) {
    out.secrets = { error: errorOf(err) };
  }
  logLine({ probe: out });
}

/** How long a pull-to-refresh spinner waits for the engine's sync state before giving up. */
const REFRESH_SPIN_MS = 20_000;

function SyncChip({ sync, total, onRetry }) {
  const t = useT();
  if (sync?.state === 'syncing') {
    return (
      <span className="mv-chip" role="status">
        <span className="mv-chip__spinner" aria-hidden="true" />
        {t('mobile.sync.syncing')}
      </span>
    );
  }
  if (sync?.state === 'error') {
    return (
      <button type="button" className="mv-chip mv-chip--error" onClick={onRetry} aria-label={`${t('mobile.sync.failed')}. ${t(errorKey(sync.code))} ${t('common.retry')}`}>
        {t('mobile.sync.failed')}
      </button>
    );
  }
  if (total == null) return null;
  return <span className="mv-header__count">{t('common.messageCount', { count: total })}</span>;
}

function App() {
  const t = useT();
  const status = useMobileStore((s) => s.status);
  const accounts = useMobileStore((s) => s.accounts);
  const activeAccountId = useMobileStore((s) => s.activeAccountId);
  const folders = useMobileStore((s) => s.folders);
  const activeFolder = useMobileStore((s) => s.activeFolder);
  const unread = useMobileStore((s) => s.unread);
  const list = useMobileStore((s) => s.list);
  const sync = useMobileStore((s) => (s.activeAccountId ? s.syncState[s.activeAccountId] : null));
  const actions = useMobileStore.getState();

  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'failed'
  const [panel, setPanel] = useState(null); // null | 'switcher' | 'drawer' | 'add'
  const [open, setOpen] = useState(null);
  const [pulled, setPulled] = useState(false);
  const [total, setTotal] = useState(null);

  const start = useCallback(() => {
    actions.init({ sync: !PERF }).catch((err) => logLine({ error: errorOf(err) }));
  }, [actions]);

  useEffect(() => {
    daemonCall('mobile.ping').then(
      (ping) => logLine({ ping }),
      (err) => logLine({ error: errorOf(err) }),
    );
    if (PROBE) probeRun(PROBE);
    start();
  }, [start]);

  // The open folder's first page decides between the list, a spinner and a retry.
  const loadList = useCallback(() => {
    if (!list) return;
    setListState('loading');
    list.ensure(0).then(
      () => setListState('ready'),
      (err) => {
        logLine({ error: errorOf(err) });
        setListState('failed');
      },
    );
  }, [list]);
  useEffect(loadList, [loadList]);

  useEffect(() => {
    if (!list) return undefined;
    const update = () => setTotal(list.total);
    update();
    return list.subscribe(update);
  }, [list]);

  useEffect(() => {
    if (PERF && listState === 'ready') perfRun();
  }, [listState]);

  useEffect(() => {
    if (status === 'ready' && START_PANEL && listState === 'ready') setPanel((p) => p ?? START_PANEL);
  }, [status, listState]);

  // Back in the foreground: sync the open folder.
  useEffect(() => {
    if (PERF) return undefined;
    const onVisible = () => { if (document.visibilityState === 'visible') useMobileStore.getState().refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // The pull spinner ends when the engine reports the pass done (or failed), or after a timeout.
  useEffect(() => {
    if (!pulled) return undefined;
    if (sync && sync.state !== 'syncing' && sync.at > pulled) setPulled(false);
    const timer = setTimeout(() => setPulled(false), REFRESH_SPIN_MS);
    return () => clearTimeout(timer);
  }, [pulled, sync]);

  const onRefresh = useCallback(() => {
    setPulled(Date.now());
    useMobileStore.getState().refresh();
  }, []);
  const onOpen = useCallback((row) => setOpen(row), []);
  const onClose = useCallback(() => setOpen(null), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const onSelectFolder = useCallback((path) => {
    setPanel(null);
    useMobileStore.getState().selectFolder(path);
  }, []);
  const onSelectAccount = useCallback((id) => {
    setPanel(null);
    useMobileStore.getState().selectAccount(id);
  }, []);
  const onAdd = useCallback(async (form) => {
    const result = await useMobileStore.getState().addAccount(form);
    if (result.ok) setPanel(null);
    return result;
  }, []);

  if (status === 'noAccount') {
    return (
      <div className="mv-app">
        <AddAccount onSubmit={onAdd} />
      </div>
    );
  }
  if (status === 'loading' || status === 'failed') {
    return (
      <div className="mv-app">
        {status === 'loading' ? (
          <p className="mv-status">{t('explorer.loading')}</p>
        ) : (
          <div className="mv-status">
            <p>{t('mobile.list.loadFailed')}</p>
            <button type="button" onClick={start}>{t('common.retry')}</button>
          </div>
        )}
      </div>
    );
  }

  const account = accounts.find((a) => a.id === activeAccountId);
  const folder = folders.find((f) => f.path === activeFolder) || { path: activeFolder || 'INBOX', name: activeFolder };
  const listKey = `${activeAccountId}/${activeFolder}`;

  return (
    <div className="mv-app">
      <header className="mv-header">
        <button type="button" className="mv-iconbtn" aria-label={t('mobile.drawer.open')} onClick={() => setPanel('drawer')}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div className="mv-header__titles">
          <h1 className="mv-header__title" dir="auto">{folderLabel(folder, t)}</h1>
          {account && (
            <button
              type="button"
              className="mv-header__account"
              aria-label={t('mobile.switcher.open', { email: account.email })}
              onClick={() => setPanel('switcher')}
            >
              <Avatar account={account} small />
              <span className="mv-header__email" dir="auto">{account.email}</span>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        <SyncChip sync={sync} total={listState === 'ready' ? total : null} onRetry={onRefresh} />
      </header>
      {listState === 'ready' && list && (
        <MessageList
          key={listKey}
          cache={list}
          onOpen={onOpen}
          onRefresh={onRefresh}
          refreshing={Boolean(pulled)}
        />
      )}
      {listState === 'loading' && <p className="mv-status">{t('explorer.loading')}</p>}
      {listState === 'failed' && (
        <div className="mv-status">
          <p>{t('mobile.list.loadFailed')}</p>
          <button type="button" onClick={loadList}>{t('common.retry')}</button>
        </div>
      )}
      {panel === 'drawer' && (
        <FolderDrawer account={account} folders={folders} activeFolder={activeFolder} onSelect={onSelectFolder} onClose={closePanel} />
      )}
      {panel === 'switcher' && (
        <AccountSwitcher
          accounts={accounts}
          activeAccountId={activeAccountId}
          unread={unread}
          onSelect={onSelectAccount}
          onAdd={() => setPanel('add')}
          onRemove={(id) => useMobileStore.getState().removeAccount(id)}
          onClose={closePanel}
        />
      )}
      {panel === 'add' && (
        <div className="mv-add-overlay">
          <AddAccount onSubmit={onAdd} onCancel={closePanel} />
        </div>
      )}
      {open && <ViewerStub key={open.uid} row={open} onClose={onClose} />}
    </div>
  );
}

// The language is picked before the first paint, so no string ever changes under the user.
loadMobileLocale().finally(() => {
  createRoot(document.getElementById('root')).render(<App />);
});
