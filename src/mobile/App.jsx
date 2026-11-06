// The mobile app (mounted by main.jsx): the account header, folder drawer, account switcher, add-account
// screen and the live message list over the mobile store (`store.js`), the message viewer on tap
// (`Viewer.jsx`), and with `?perf=1` the perf probe, whose result the engine logs as
// `MV_MOBILE {"perf":…}`. With `?probe=host:port` (perf-gate builds) it logs one
// `MV_MOBILE {"probe":…}` line: DNS + TLS to that host and a secret store round trip.
// `?ui=switcher|drawer` opens that panel at start, `?ui=viewer[&row=N]` opens the list's row N
// (default 0) in the viewer (both for screenshots; `&loadImagesAfter=S` below for the network proof). The `mobile.ping` line is logged first:
// scripts/mobile-run.sh waits for it.
import React, { useCallback, useEffect, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import MessageList from './MessageList.jsx';
import Viewer from './Viewer.jsx';
import AddAccount from './AddAccount.jsx';
import AccountSwitcher, { Avatar } from './AccountSwitcher.jsx';
import FolderDrawer from './FolderDrawer.jsx';
import { folderLabel } from './folders.js';
import { errorKey } from './errors.js';
import { runPerfGate } from './perf.js';
import { useT } from './i18n.js';

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
const START_ROW = QUERY.get('ui') === 'viewer' ? Math.max(0, Number(QUERY.get('row')) || 0) : null;
let startRowOpened = false;
// `&loadImagesAfter=S` (with `?ui=viewer`, for the on-device network proof): S seconds after the
// viewer opens, log `{"viewerProbe":"loadImages", at}` (the device clock), tap Load images, and 12 s later log
// `{"viewerProbe":"done"}`, so a script can tell requests made before the tap from those after.
const LOAD_IMAGES_AFTER = START_ROW != null ? Math.max(0, Number(QUERY.get('loadImagesAfter')) || 0) : 0;
let viewerProbeStarted = false;
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

  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'failed'
  const [panel, setPanel] = useState(null); // null | 'switcher' | 'drawer' | 'add'
  const [open, setOpen] = useState(null);
  const [pulled, setPulled] = useState(false);
  const [total, setTotal] = useState(null);

  // Stable: the store's actions never change, so this never re-runs the mount effect below.
  // (`getState()` itself returns a new object after every `set`; it must not be a dependency.)
  const start = useCallback(() => {
    useMobileStore.getState().init({ sync: !PERF }).catch((err) => logLine({ error: errorOf(err) }));
  }, []);

  // Once per mount: the ping line scripts wait for, the optional device probe, and the first load.
  useEffect(() => {
    daemonCall('mobile.ping').then(
      (ping) => logLine({ ping }),
      (err) => logLine({ error: errorOf(err) }),
    );
    if (PROBE) probeRun(PROBE);
    start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // `?ui=viewer`: the asked-for row, once it has loaded (its page may need fetching first).
  useEffect(() => {
    if (START_ROW == null || startRowOpened || status !== 'ready' || listState !== 'ready' || !list) return undefined;
    const tryOpen = () => {
      const row = list.rowAt(START_ROW);
      if (!row || startRowOpened) return;
      startRowOpened = true;
      const { activeAccountId: accountId, activeFolder: folder } = useMobileStore.getState();
      setOpen({ row, accountId, folder });
    };
    list.ensure(START_ROW).then(tryOpen, () => {});
    tryOpen();
    return list.subscribe(tryOpen);
  }, [status, listState, list]);

  useEffect(() => {
    if (!open || !LOAD_IMAGES_AFTER || viewerProbeStarted) return;
    viewerProbeStarted = true;
    setTimeout(() => {
      const button = document.querySelector('[data-mv-load-images]');
      logLine({ viewerProbe: 'loadImages', clicked: Boolean(button), at: Date.now() });
      button?.click();
      setTimeout(() => logLine({ viewerProbe: 'done' }), 12_000);
    }, LOAD_IMAGES_AFTER * 1000);
  }, [open]);

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
  // The viewer keeps the account and folder the row was opened from, whatever the list does next.
  const onOpen = useCallback((row) => {
    const { activeAccountId: accountId, activeFolder: folder } = useMobileStore.getState();
    setOpen({ row, accountId, folder });
  }, []);
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
          <h1 className="mv-header__title" dir="auto">{folderLabel(folder)}</h1>
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
      {open && (
        <Viewer key={`${open.accountId}/${open.folder}/${open.row.uid}`} accountId={open.accountId} folder={open.folder} row={open.row} onClose={onClose} />
      )}
    </div>
  );
}

export default App;
