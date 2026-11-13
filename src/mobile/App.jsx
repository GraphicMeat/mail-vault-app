// The mobile app (mounted by main.jsx): the account header, folder drawer, account switcher, add-account
// screen and the live message list over the mobile store (`store.js`), the message viewer on tap
// (`Viewer.jsx`), and with `?perf=1` the perf probe, whose result the engine logs as
// `MV_MOBILE {"perf":…}`. With `?probe=host:port` (perf-gate builds) it logs one
// `MV_MOBILE {"probe":…}` line: DNS + TLS to that host and a secret store round trip.
// `?ui=switcher|drawer` opens that panel at start (for screenshots); `?ui=swipe` and
// `?ui=swipe-trailing` show the first row slid open, `?ui=toast` (or `&toast=1` with another `ui`)
// the undo toast and the pending chip (display only, nothing is sent; these two in a perf-gate
// bundle only; so are `?ui=compose` (a new message), `?ui=reply` (a reply to the newest row) and
// `?ui=outbox` (the outbox sheet over two made-up unsent rows, display only)), `?ui=signin` (the
// add-account screen, which starts the Google sign-in sheet at once; `?ui=signin-close` also closes
// the sheet 20 s later, as a finished sign-in would)); `?ui=viewer` runs the scripted viewer in `viewerProbe.js`
// (perf-gate builds only: the bundle has it only when built with MV_PERF_GATE=1, and it runs only
// when the engine's ping says `perfGate`), with `&move=1` the move picker open. The `mobile.ping`
// line is logged first: scripts/mobile-run.sh waits for it.
//
// Compose (Compose.jsx) is a full-screen layer over the list or the viewer: the button at the
// bottom right starts a new message, the viewer's More sheet a reply, reply to all or forward.
// The drawer's Drafts entry opens the drafts list (DraftsList.jsx); a draft reopens in Compose.
// Its Follow up entry opens the reminders list (FollowUpList.jsx); a reminder with no reply opens
// its Sent copy the way a notification tap opens a message.
// The outbox row (Outbox.jsx) sits between the header and the list while anything is unsent.
//
// Back (Android) closes the top layer (viewer, picker, sheet, compose) through `backStack.js`.
//
// A tapped new-mail notification (`{accountId, folder, uid?}`, held by the shell) is taken on
// mount (a cold launch's tap came before the page) and on each `mobile.notification.open`: the app
// opens that account and folder and the message, or says the message is gone. `?ui=notify`
// (perf-gate only) turns notifications on and asks for the permission, for the device check.
//
// A fresh install (no accounts, tour never finished) opens the first-run tour (onboarding/) before
// anything else; Settings' Replay tour opens it again, without its account step.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { daemonCall, closeAuthSheet, listen, requestNotificationPermission, takeNotificationTap } from './transport.js';
import { useMobileStore, ALL_INBOXES } from './store.js';
import MessageList from './MessageList.jsx';
import Viewer from './Viewer.jsx';
import AddAccount from './AddAccount.jsx';
import AccountSwitcher, { Avatar, ReauthBanner, RefusedBanner } from './AccountSwitcher.jsx';
import FolderDrawer from './FolderDrawer.jsx';
import { folderLabel } from './folders.js';
import { errorKey } from './errors.js';
import { runPerfGate } from './perf.js';
import { useT } from './i18n.js';
import { useBackLayer } from './backStack.js';
import Toasts from './Toasts.jsx';
import Compose from './Compose.jsx';
import OutboxRow from './Outbox.jsx';
import DraftsList from './DraftsList.jsx';
import FollowUpList from './FollowUpList.jsx';
import Settings from './Settings.jsx';
import Search from './Search.jsx';
import Premium from './Premium.jsx';
import Onboarding from './onboarding/Onboarding.jsx';
import KeyboardLayer from './KeyboardLayer.jsx';
import { combinedSync } from './syncSummary.js';
import { mobileOnboardingSteps, onboardingGate } from './onboarding/steps.js';
import { startPremiumSync } from './premium.js';

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
// `?ui=viewer` (viewerProbe.js): a scripted viewer for screenshots, the timing of large opens
// and the on-device network proof. Perf-gate builds only: the engine's ping says which.
const VIEWER_SCRIPT = QUERY.get('ui') === 'viewer';
// Screenshot-only hooks: a perf-gate bundle only (build constant, see vite.mobile.config.js).
const PERF_BUILD = import.meta.env.MV_PERF_GATE === '1';
const DEMO_SWIPE = (PERF_BUILD && { swipe: { index: 0, side: 'leading' }, 'swipe-trailing': { index: 0, side: 'trailing' } }[QUERY.get('ui')]) || null;
const DEMO_TOAST = PERF_BUILD && (QUERY.get('ui') === 'toast' || QUERY.get('toast') === '1');
const DEMO_MOVE = VIEWER_SCRIPT && QUERY.get('move') === '1';
const DEMO_COMPOSE = (PERF_BUILD && { compose: 'new', reply: 'reply' }[QUERY.get('ui')]) || null;
const DEMO_OUTBOX = PERF_BUILD && QUERY.get('ui') === 'outbox';
// `?ui=drafts` (perf-gate only): the drafts list over two saved drafts of the seed account.
const DEMO_DRAFTS = PERF_BUILD && QUERY.get('ui') === 'drafts';
// `?ui=settings` (perf-gate only): the settings screen open, for screenshots.
const DEMO_SETTINGS = PERF_BUILD && QUERY.get('ui') === 'settings';
// `?ui=search` (perf-gate only): the search layer, with `&q=word` already typed; `?ui=premium`: the
// paywall open. Both for the store screenshots (scripts/mobile-store-shots.sh).
const DEMO_SEARCH = PERF_BUILD && QUERY.get('ui') === 'search';
const DEMO_SEARCH_QUERY = (DEMO_SEARCH && QUERY.get('q')) || '';
const DEMO_PREMIUM = PERF_BUILD && QUERY.get('ui') === 'premium';
// `?ui=signin` / `?ui=signin-close` (perf-gate only): the device check of the sign-in sheet. No
// credentials are ever entered; the close variant proves `mobile_auth_close` takes the sheet down.
const DEMO_SIGNIN = (PERF_BUILD && { signin: 'open', 'signin-close': 'close' }[QUERY.get('ui')]) || null;
// `?ui=notify` (perf-gate only): notifications on and the permission asked, as the Settings
// screen will (the device check of background fetch). With `&imap=127.0.0.1:port&smtp=port` it
// first adds a password account on that local mock server (perf-gate shells allow plaintext to
// loopback only).
const DEMO_NOTIFY = PERF_BUILD && QUERY.get('ui') === 'notify';
// The first-run tour never runs under the perf probe, the device probe or a `?ui=` screen hook:
// those start on a fresh engine and expect the add-account screen or the list.
const NO_TOUR = PERF || QUERY.has('ui') || QUERY.has('probe');
let demoComposeStarted = false;
let viewerScriptStarted = false;
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

function PendingChip() {
  const t = useT();
  const pending = useMobileStore((s) => s.pending);
  if (!pending) return null;
  return <span className="mv-chip mv-chip--pending" role="status">{t('mobile.actions.waiting', { count: pending })}</span>;
}

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
  // In All Inboxes the header and the pull spinner follow every account's pass, not only the one
  // in front: syncing until all are done, a failed one shown as the account's own would be.
  const syncState = useMobileStore((s) => s.syncState);
  const sync = useMemo(() => {
    const ids = activeFolder === ALL_INBOXES ? accounts.map((a) => a.id) : activeAccountId ? [activeAccountId] : [];
    return combinedSync(syncState, ids);
  }, [syncState, accounts, activeFolder, activeAccountId]);

  const [listState, setListState] = useState('loading'); // 'loading' | 'ready' | 'failed'
  const [panel, setPanel] = useState(null); // null | 'switcher' | 'drawer' | 'add'
  const [open, setOpen] = useState(null);
  // A message opened from another account (a search result in All accounts) moves within that
  // account's folders: they are read for it, so Move offers them.
  const [otherFolders, setOtherFolders] = useState(null); // { accountId, folders }
  const openAccount = open?.accountId ?? null;
  useEffect(() => {
    if (!openAccount || openAccount === activeAccountId) return undefined;
    let live = true;
    daemonCall('mobile.folders.list', { accountId: openAccount }).then(
      (reply) => { if (live) setOtherFolders({ accountId: openAccount, folders: reply?.folders ?? [] }); },
      () => { if (live) setOtherFolders({ accountId: openAccount, folders: [] }); },
    );
    return () => { live = false; };
  }, [openAccount, activeAccountId]);
  const [compose, setCompose] = useState(null); // { key, accountId, mode, original?, draftId? }
  const [draftsOpen, setDraftsOpen] = useState(DEMO_DRAFTS);
  const [followUpsOpen, setFollowUpsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(DEMO_SETTINGS);
  const [searchOpen, setSearchOpen] = useState(DEMO_SEARCH);
  const drafts = useMobileStore((s) => s.drafts);
  const followUps = useMobileStore((s) => s.followUps);
  const [pulled, setPulled] = useState(false);
  const [total, setTotal] = useState(null);
  const [perfGate, setPerfGate] = useState(false);
  const [tap, setTap] = useState(null); // a notification tap waiting for the app to be ready

  // Stable: the store's actions never change, so this never re-runs the mount effect below.
  // (`getState()` itself returns a new object after every `set`; it must not be a dependency.)
  const start = useCallback(() => {
    useMobileStore.getState().init({ sync: !PERF }).catch((err) => logLine({ error: errorOf(err) }));
  }, []);

  // Once per mount: the ping line scripts wait for, the optional device probe, and the first load.
  useEffect(() => {
    daemonCall('mobile.ping').then(
      (ping) => {
        logLine({ ping });
        setPerfGate(ping?.perfGate === true);
      },
      (err) => logLine({ error: errorOf(err) }),
    );
    if (PROBE) probeRun(PROBE);
    start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Premium: read at launch, re-checked on return to the app, live on `mobile.premium.changed`.
  useEffect(() => (PERF ? undefined : startPremiumSync()), []);

  // Notification taps: the shell's held one on mount, then each one it announces. Taking it is
  // what opens it, so a tap announced and also taken on mount opens once.
  useEffect(() => {
    if (PERF) return undefined;
    let live = true;
    const take = () => {
      takeNotificationTap().then(
        (next) => {
          if (live && next) {
            logLine({ notificationOpen: 'taken' });
            setTap(next);
          }
        },
        (err) => logLine({ error: errorOf(err) }),
      );
    };
    take();
    let off = () => {};
    try {
      off = listen('mobile.notification.open', take);
    } catch {
      // No event bridge (not in the shell): the mount take is all there is.
    }
    return () => { live = false; off(); };
  }, []);

  useEffect(() => {
    if (!DEMO_NOTIFY || status !== 'ready') return;
    (async () => {
      logLine({ demo: 'notify-start' });
      const imap = QUERY.get('imap');
      if (imap) {
        const at = imap.lastIndexOf(':');
        const host = imap.slice(0, at);
        const added = await useMobileStore.getState().addAccount({
          email: 'device-check@example.test', password: 'device-check', imapHost: host, imapPort: Number(imap.slice(at + 1)),
          security: 'none', smtpHost: host, smtpPort: Number(QUERY.get('smtp')), smtpSecurity: 'starttls',
        });
        logLine({ demo: 'notify-account', ok: added.ok, code: added.code ?? null });
      }
      // The prompt answers only once someone taps it: not waited for.
      requestNotificationPermission().then(
        (permission) => logLine({ demo: 'notify-permission', permission }),
        (err) => logLine({ demo: 'notify-permission', error: errorOf(err) }),
      );
      const settings = await daemonCall('mobile.settings.set', { notifications: 'on' }).catch((err) => ({ error: errorOf(err) }));
      logLine({ demo: 'notify', settings });
    })();
  }, [status]);

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

  useEffect(() => {
    // MV_PERF_GATE is a build constant (vite.mobile.config.js): a shipping bundle drops this branch
    // and with it the probe module.
    if (import.meta.env.MV_PERF_GATE !== '1') return;
    if (!VIEWER_SCRIPT || !perfGate || viewerScriptStarted || status !== 'ready' || listState !== 'ready' || !list) return;
    viewerScriptStarted = true;
    const openRow = (row) => {
      setOpen({ row, ...useMobileStore.getState().placeOf(row) });
    };
    import('./viewerProbe.js')
      .then(({ runViewerProbe }) => runViewerProbe({ query: QUERY, list, open: openRow, close: () => setOpen(null), log: logLine }))
      .catch((err) => logLine({ error: errorOf(err) }));
  }, [perfGate, status, listState, list]);

  useEffect(() => {
    if (DEMO_TOAST && status === 'ready') useMobileStore.setState({ undo: { id: -1, kind: 'delete', count: 1, target: null }, pending: 2 });
  }, [status]);

  useEffect(() => {
    if (!DEMO_COMPOSE || demoComposeStarted || status !== 'ready' || listState !== 'ready' || !list) return;
    demoComposeStarted = true;
    const row = list.rowAt(0);
    const { accountId, folder } = useMobileStore.getState().placeOf(row);
    setCompose(DEMO_COMPOSE === 'reply' && row
      ? { key: 1, accountId, mode: 'reply', original: { folder, uid: row.uid, dateMs: row.dateMs } }
      : { key: 1, accountId, mode: 'new' });
    // The line scripts/mobile-run.sh can wait for before its screenshot (the reply's prepare is in).
    setTimeout(() => logLine({ demo: DEMO_COMPOSE }), 2000);
  }, [status, listState, list]);

  useEffect(() => {
    if (!DEMO_OUTBOX || status !== 'ready') return;
    const accountId = useMobileStore.getState().activeAccountId;
    useMobileStore.setState({
      outbox: [
        { id: 'demo-1', accountId, subject: 'Quarterly numbers', state: 'uncertain', lastError: 'TIMEOUT' },
        { id: 'demo-2', accountId, subject: 'Lunch on Friday?', state: 'queued', lastError: null },
      ],
    });
    setTimeout(() => logLine({ demo: 'outbox' }), 1000);
  }, [status]);

  useEffect(() => {
    if (!DEMO_DRAFTS || status !== 'ready') return;
    // Two real drafts of the seed account (perf-gate data only), saved once.
    (async () => {
      const accountId = useMobileStore.getState().activeAccountId;
      const have = await daemonCall('mobile.drafts.list').catch(() => []);
      if (!have.some((d) => d.accountId === accountId)) {
        const base = { accountId, cc: '', bcc: '', inReplyTo: '', references: '', attachments: [] };
        await daemonCall('mobile.drafts.save', { ...base, to: 'grace@example.test', subject: 'Notes from Tuesday', text: 'Here are the notes.' }).catch(() => {});
        await daemonCall('mobile.drafts.save', { ...base, to: '', subject: '', text: 'Remember to' }).catch(() => {});
      }
      await useMobileStore.getState().loadDrafts();
      setTimeout(() => logLine({ demo: 'drafts' }), 1000);
    })();
  }, [status]);

  // Back in the foreground: sync the open folder. Either way the engine hears it: it listens for
  // new mail only while the app is in front.
  useEffect(() => {
    if (PERF) return undefined;
    const onVisible = () => {
      const store = useMobileStore.getState();
      const visible = document.visibilityState === 'visible';
      store.appState(visible, visible);
      if (visible) store.refresh();
    };
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
  // The viewer keeps the account and folder the row was opened from (in All Inboxes, the row's
  // own), whatever the list does next. Opening a message marks it read.
  const onOpen = useCallback((row, index) => {
    const s = useMobileStore.getState();
    const { accountId, folder } = s.placeOf(row);
    s.markSeen(accountId, folder, row);
    setOpen({ row: row.seen ? row : { ...row, seen: true }, index, accountId, folder });
  }, []);
  const onClose = useCallback(() => setOpen(null), []);
  const closePanel = useCallback(() => setPanel(null), []);

  // A tap opens its account and folder, then the message: from the list's first page (asked
  // again once, in case the page held is older than the run that found the mail). A message no
  // longer there says so; a summary's tap (no uid) stops at the folder.
  useEffect(() => {
    if (!tap || status !== 'ready') return;
    setTap(null);
    (async () => {
      const store = useMobileStore.getState();
      if (!(await store.openAt(tap.accountId, tap.folder))) return;
      setPanel(null);
      setDraftsOpen(false);
      setFollowUpsOpen(false);
      // Settings sits above the viewer: the message would open underneath it.
      setSettingsOpen(false);
      setOpen(null);
      if (tap.uid == null) return;
      const { list, activeAccountId, activeFolder } = useMobileStore.getState();
      if (!list || activeAccountId !== tap.accountId || activeFolder !== tap.folder) return;
      let index = -1;
      try {
        await list.ensure(0);
        index = list.indexOfUid(tap.uid);
        if (index < 0) {
          list.invalidate(null, 0);
          await list.ensure(0);
          index = list.indexOfUid(tap.uid);
        }
      } catch (err) {
        logLine({ error: errorOf(err) });
      }
      const row = index >= 0 ? list.rowAt(index) : undefined;
      const found = Boolean(row && row.uid === tap.uid);
      logLine({ notificationOpen: found ? 'message' : 'gone' });
      if (found) onOpen(row, index);
      else useMobileStore.getState().showNotice('mobile.viewer.gone');
    })();
  }, [tap, status, onOpen]);
  useBackLayer(Boolean(open), onClose);
  useBackLayer(Boolean(panel), closePanel);

  const onSwipe = useCallback((kind, row) => {
    const s = useMobileStore.getState();
    s.act(kind, { ...s.placeOf(row), uids: [row.uid] });
  }, []);
  const onViewerAction = useCallback((kind) => {
    if (!open) return undefined;
    return useMobileStore.getState().act(kind, { accountId: open.accountId, folder: open.folder, uids: [open.row.uid] });
  }, [open]);
  const onViewerMove = useCallback((target) => {
    if (!open) return;
    useMobileStore.getState().act('move', { accountId: open.accountId, folder: open.folder, uids: [open.row.uid], target });
    setOpen(null);
  }, [open]);
  // Delete closes the message and opens the next row of the list (the one below it), if any.
  // The delete keeps its own undo toast either way; undo puts the row back in the list (the viewer
  // stays where it is). Moving on with another delete or move sends this one first.
  const onViewerDelete = useCallback(() => {
    if (!open) return;
    const s = useMobileStore.getState();
    const { accountId, folder } = open;
    const list = s.listShowing(accountId, folder);
    // Where the message is now: the list may have moved since it was opened (new mail, an undo).
    const key = list ? list.keyFor(accountId, open.row.uid) : null;
    const index = list ? list.indexOf(key) : -1;
    const below = index >= 0 ? list.rowAt(index + 1) : undefined;
    const next = below && list.keyFor(below.accountId, below.uid) !== key ? below : undefined;
    s.act('delete', { accountId, folder, uids: [open.row.uid] });
    if (next) {
      // In All Inboxes the next row can be another account's.
      const place = s.placeOf(next);
      s.markSeen(place.accountId, place.folder, next);
      setOpen({ row: next.seen ? next : { ...next, seen: true }, index, ...place });
    } else {
      setOpen(null);
    }
  }, [open]);
  const onNewMessage = useCallback(() => {
    const { activeAccountId: accountId } = useMobileStore.getState();
    if (accountId) setCompose({ key: Date.now(), accountId, mode: 'new' });
  }, []);
  const onViewerCompose = useCallback((mode) => {
    if (!open) return;
    setCompose({
      key: Date.now(),
      accountId: open.accountId,
      mode,
      original: { folder: open.folder, uid: open.row.uid, dateMs: open.row.dateMs },
    });
  }, [open]);
  const closeCompose = useCallback(() => {
    setCompose(null);
    // A draft may have been saved, sent or deleted: the drawer count and the list follow.
    useMobileStore.getState().loadDrafts();
  }, []);
  const onDrafts = useCallback(() => {
    setPanel(null);
    setDraftsOpen(true);
  }, []);
  const closeDrafts = useCallback(() => setDraftsOpen(false), []);
  const onFollowUps = useCallback(() => {
    setPanel(null);
    setFollowUpsOpen(true);
  }, []);
  const closeFollowUps = useCallback(() => setFollowUpsOpen(false), []);
  // A reminder opens its Sent copy the way a notification tap opens a message.
  const onOpenFollowUp = useCallback((f) => {
    useMobileStore.getState().followUpSeen(f.id);
    setFollowUpsOpen(false);
    setTap({ accountId: f.accountId, folder: f.folder, uid: f.uid });
  }, []);
  const onOpenDraft = useCallback((id) => {
    const { activeAccountId: accountId } = useMobileStore.getState();
    if (accountId) setCompose({ key: Date.now(), accountId, mode: 'new', draftId: id });
  }, []);
  const onSettings = useCallback(() => {
    setPanel(null);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  // A search result is opened from its own account and folder, which need not be the open list's.
  const onOpenResult = useCallback((row) => {
    const { accountId, folder } = row;
    useMobileStore.getState().markSeen(accountId, folder, row);
    setOpen({ row: row.seen ? row : { ...row, seen: true }, accountId, folder });
  }, []);
  useBackLayer(searchOpen, closeSearch);
  useBackLayer(draftsOpen, closeDrafts);
  useBackLayer(followUpsOpen, closeFollowUps);
  useBackLayer(settingsOpen, closeSettings);
  const paywall = useMobileStore((s) => s.paywall);
  useEffect(() => {
    if (DEMO_PREMIUM) useMobileStore.getState().openPaywall();
  }, []);
  const closePaywall = useCallback(() => useMobileStore.getState().closePaywall(), []);
  useBackLayer(Boolean(paywall), closePaywall);
  const onSelectFolder = useCallback((path) => {
    setPanel(null);
    useMobileStore.getState().selectFolder(path);
  }, []);
  const onAllInboxes = useCallback(() => {
    setPanel(null);
    useMobileStore.getState().selectAllInboxes();
  }, []);
  // All Inboxes marks each row with its account (desktop's account dot).
  const allInboxes = activeFolder === ALL_INBOXES;
  const accountOf = useMemo(() => {
    if (!allInboxes) return null;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return (row) => byId.get(row.accountId);
  }, [allInboxes, accounts]);
  const onSelectAccount = useCallback((id) => {
    setPanel(null);
    useMobileStore.getState().selectAccount(id);
  }, []);
  const onAdd = useCallback(async (form) => {
    const result = await useMobileStore.getState().addAccount(form);
    if (result.ok) setPanel(null);
    return result;
  }, []);
  const onImport = useCallback((request) => useMobileStore.getState().importFromDesktop(request), []);
  // The import's Done: open the first imported account and close the panel; nothing imported
  // leaves the picker up.
  const onImported = useCallback(async ({ imported }) => {
    if (!imported?.length) return;
    setPanel(null);
    await useMobileStore.getState().openImported(imported);
  }, []);
  const onOAuth = useCallback(async (provider) => {
    if (DEMO_SIGNIN === 'close') {
      setTimeout(() => {
        logLine({ signinDemo: 'close' });
        closeAuthSheet().catch((err) => logLine({ signinDemo: 'closeFailed', error: errorOf(err) }));
      }, 20000);
    }
    const result = await useMobileStore.getState().signIn(provider);
    if (DEMO_SIGNIN) logLine({ signinDemo: 'finished', ok: result.ok, code: result.code ?? null });
    if (result.ok) setPanel(null);
    return result;
  }, []);
  // Both "Sign in again" controls run the store's one reauth, whose busy and error state the
  // banner shows; the switcher opens that account first, so its banner is the one on screen.
  const reauthState = useMobileStore((s) => s.reauthState);
  const onReauth = useCallback((id) => useMobileStore.getState().reauth(id), []);
  const onRetrySignIn = useCallback((id) => useMobileStore.getState().retrySignIn(id), []);
  const onSwitcherReauth = useCallback(async (id) => {
    setPanel(null);
    const store = useMobileStore.getState();
    if (store.reauthState?.busy) return;
    if (store.activeAccountId !== id) await store.selectAccount(id);
    await store.reauth(id);
  }, []);
  const onOAuthCancel = useCallback(() => useMobileStore.getState().cancelSignIn(), []);
  useEffect(() => {
    if (DEMO_SIGNIN && status === 'ready') setPanel('add');
  }, [status]);

  // The first-run tour (onboarding/): decided once, when the accounts are known. A fresh install
  // (never finished, no accounts) shows it before anything else; one with accounts is marked done
  // without seeing it. Held in state from then on: adding an account in the tour makes the store
  // 'ready' mid-way, and the tour must stay up. Settings' Replay tour opens it again.
  const [tour, setTour] = useState(null); // null | { steps }
  const [tourChecked, setTourChecked] = useState(NO_TOUR);
  useEffect(() => {
    if (tourChecked || (status !== 'noAccount' && status !== 'ready')) return undefined;
    let live = true;
    const accountCount = useMobileStore.getState().accounts.length;
    daemonCall('mobile.settings.get').then(
      (settings) => {
        if (!live) return;
        const gate = onboardingGate(settings, accountCount);
        if (gate === 'show') setTour({ steps: mobileOnboardingSteps(0) });
        if (gate === 'markComplete') daemonCall('mobile.settings.set', { onboardingComplete: true }).catch(() => {});
        setTourChecked(true);
      },
      () => { if (live) setTourChecked(true); },
    );
    return () => { live = false; };
  }, [status, tourChecked]);
  const onReplayTour = useCallback(() => {
    setSettingsOpen(false);
    setPanel(null);
    setTour({ steps: mobileOnboardingSteps(useMobileStore.getState().accounts.length) });
  }, []);
  const closeTour = useCallback(() => setTour(null), []);

  if (tour) {
    return (
      <div className="mv-kb-layer mv-app">
        <Onboarding steps={tour.steps} onAdd={onAdd} onOAuth={onOAuth} onOAuthCancel={onOAuthCancel} onFinish={closeTour} />
        <Toasts />
      </div>
    );
  }

  // Until the tour check answers, a fresh install shows loading: an add-account screen here would
  // be swapped for the tour a moment later, unmounting a sign-in or import already under way.
  if (status === 'loading' || status === 'failed' || (status === 'noAccount' && !tourChecked)) {
    return (
      <div className="mv-kb-layer mv-app">
        {status !== 'failed' ? (
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

  if (status === 'noAccount') {
    return (
      <KeyboardLayer className="mv-app" scroll=".mv-add">
        <AddAccount onSubmit={onAdd} onOAuth={onOAuth} onOAuthCancel={onOAuthCancel} onImport={onImport} onImported={onImported} autoStart={DEMO_SIGNIN ? 'google' : null} />
      </KeyboardLayer>
    );
  }

  const account = accounts.find((a) => a.id === activeAccountId);
  const folder = folders.find((f) => f.path === activeFolder) || { path: activeFolder || 'INBOX', name: activeFolder };
  const listKey = `${activeAccountId}/${activeFolder}`;

  return (
    <div className="mv-kb-layer mv-app">
      <header className="mv-header">
        <button type="button" className="mv-iconbtn" aria-label={t('mobile.drawer.open')} onClick={() => setPanel('drawer')}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div className="mv-header__titles">
          <h1 className="mv-header__title" dir="auto">{allInboxes ? t('sidebar.allInboxes') : folderLabel(folder)}</h1>
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
        <PendingChip />
        <button type="button" className="mv-iconbtn" data-mv-search-open aria-label={t('mobile.search.open')} onClick={() => setSearchOpen(true)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" />
          </svg>
        </button>
        <SyncChip sync={sync} total={listState === 'ready' ? total : null} onRetry={onRefresh} />
      </header>
      <ReauthBanner account={account} state={reauthState} onReauth={onReauth} />
      <RefusedBanner account={account} onRetry={onRetrySignIn} />
      <OutboxRow initialOpen={DEMO_OUTBOX} />
      {listState === 'ready' && list && (
        <MessageList
          key={listKey}
          cache={list}
          onOpen={onOpen}
          onSwipe={onSwipe}
          accountOf={accountOf}
          onRefresh={onRefresh}
          refreshing={Boolean(pulled)}
          demoSwipe={DEMO_SWIPE}
        />
      )}
      {listState === 'loading' && <p className="mv-status">{t('explorer.loading')}</p>}
      {listState === 'failed' && (
        <div className="mv-status">
          <p>{t('mobile.list.loadFailed')}</p>
          <button type="button" onClick={loadList}>{t('common.retry')}</button>
        </div>
      )}
      {!open && (
        <button type="button" className="mv-fab" data-mv-compose aria-label={t('mobile.compose.new')} onClick={onNewMessage}>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
      )}
      {panel === 'drawer' && (
        <FolderDrawer
          account={account}
          folders={folders}
          activeFolder={activeFolder}
          onSelect={onSelectFolder}
          allInboxes={accounts.length >= 2 ? { unread: accounts.reduce((n, a) => n + (unread[a.id] || 0), 0) } : null}
          onAllInboxes={onAllInboxes}
          onClose={closePanel}
          drafts={drafts.length}
          onDrafts={onDrafts}
          followUps={followUps.length}
          followUpsDue={followUps.filter((f) => f.state === 'due').length}
          onFollowUps={onFollowUps}
          onSettings={onSettings}
        />
      )}
      {panel === 'switcher' && (
        <AccountSwitcher
          accounts={accounts}
          activeAccountId={activeAccountId}
          unread={unread}
          onSelect={onSelectAccount}
          onAdd={() => setPanel('add')}
          onRemove={(id) => useMobileStore.getState().removeAccount(id)}
          onReauth={onSwitcherReauth}
          reauthBusy={Boolean(reauthState?.busy)}
          onClose={closePanel}
        />
      )}
      {panel === 'add' && (
        <KeyboardLayer className="mv-add-overlay" scroll=".mv-add">
          <AddAccount onSubmit={onAdd} onOAuth={onOAuth} onOAuthCancel={onOAuthCancel} onCancel={closePanel} onImport={onImport} onImported={onImported} autoStart={DEMO_SIGNIN ? 'google' : null} />
        </KeyboardLayer>
      )}
      {open && (
        <Viewer
          key={`${open.accountId}/${open.folder}/${open.row.uid}`}
          accountId={open.accountId}
          folder={open.folder}
          row={open.row}
          folders={open.accountId === activeAccountId ? folders : (otherFolders?.accountId === open.accountId ? otherFolders.folders : [])}
          onClose={onClose}
          onAction={onViewerAction}
          onMove={onViewerMove}
          onDelete={onViewerDelete}
          onCompose={onViewerCompose}
          initialPicking={DEMO_MOVE}
        />
      )}
      {searchOpen && <Search onOpen={onOpenResult} onClose={closeSearch} initialQuery={DEMO_SEARCH_QUERY} />}
      {draftsOpen && <DraftsList onOpen={onOpenDraft} onClose={closeDrafts} />}
      {followUpsOpen && <FollowUpList onOpen={onOpenFollowUp} onClose={closeFollowUps} />}
      {settingsOpen && <Settings onClose={closeSettings} onReplayTour={onReplayTour} />}
      {paywall && <Premium feature={paywall.feature} signIn={paywall.signIn} onClose={closePaywall} />}
      {compose && (
        <Compose
          key={compose.key}
          accountId={compose.accountId}
          fromEmail={accounts.find((a) => a.id === compose.accountId)?.email || ''}
          mode={compose.mode}
          original={compose.original || null}
          draftId={compose.draftId || null}
          onClose={closeCompose}
        />
      )}
      <Toasts />
    </div>
  );
}

export default App;
