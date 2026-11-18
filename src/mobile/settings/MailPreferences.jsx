// Settings > Mail preferences on the phone: desktop's Behavior and Notifications views
// (src/components/settings/views) over the phone's preferences and engine.
//
// Behavior: each row one preference (`mobile.prefs.set` through the store's setPrefs), read where
// it acts: the sync on opening and on coming to the front (store.js `init`, App.jsx, the engine's
// live catch-up) and every `refreshInterval` minutes while in front (App.jsx); attachments fetched
// as a message opens (AttachmentChip.jsx); the send delay and the attachment reminder (Compose,
// the outbox); marking read (App.jsx `markReadPlan`); row swipes (MessageRow.jsx); deleting (the
// viewer's confirm, the row after a delete: prefs.js `afterDeletePick`). A swipe does what the
// phone's rows can (the engine's SWIPES); after a delete the next, the previous or nothing opens
// (the phone has no unread-only pick). Signatures on outgoing mail sit under Sending until the
// account page moves (desktop keeps that switch with the accounts). Desktop's default mail app,
// close to tray, compose window, update track and search history are not a phone's.
//
// Notifications: the switch asks the system's permission before it turns on, and stays off with a
// pointer to the system settings when the answer is no. Each time the page shows (and when the
// app comes back to the front) it reads the system's current answer without asking: turned off
// there, notifications show off here too, with the same pointer. Both live in the engine
// (`mobile.settings.*`): the background run has no page, and reads the same rows. Then the
// system's sound and, on iOS, the app icon's badge (an Android launcher badges from the
// notifications themselves); each account's switch, folders (its own, `mobile.folders.list`, plus
// any stored one it does not list) and quiet hours (`mobile.accountSettings.*`: `notify`,
// `notifyFolders`, `quietHours`); and the priority senders (`importantSenders`,
// `mobile.prefs.*`). The background run applies them with desktop's policy
// (`notify_policy::decide`, `background.rs`).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BehaviorView } from '../../components/settings/views/BehaviorView';
import { NotificationsView, DEFAULT_QUIET_HOURS } from '../../components/settings/views/NotificationsView';
import { SettingRow } from '../../components/ui/SettingRow';
import { ToggleSwitch } from '../../components/ui/ToggleSwitch';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { daemonCall, notificationPermission, requestNotificationPermission } from '../transport.js';
import { SWIPE_ACTIONS, visibleAccounts } from '../prefs.js';
import { accountColor } from '../accountColor.js';
import { initialOf } from '../AccountSwitcher.jsx';
import { folderLabel } from '../folders.js';
import { MobileViewEnv, SaveFailed, useSavePrefs } from './MobileViewEnv.jsx';

const SWIPE_LABELS = {
  toggleRead: 'settings.behavior.swipe.toggleRead',
  delete: 'common.delete',
  flag: 'mobile.actions.flag',
  move: 'mobile.actions.move',
  none: 'settings.behavior.swipe.none',
};
const SWIPES = SWIPE_ACTIONS.map((value) => ({ value, labelKey: SWIPE_LABELS[value] }));
const AFTER_DELETE = ['none', 'next', 'previous'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The phone is an Android one (its launcher badges from the notifications, not the app). */
export function isAndroid() {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

export function Behavior() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [save, failed] = useSavePrefs();
  return (
    <MobileViewEnv>
      <BehaviorView values={prefs} onChange={(key, value) => save({ [key]: value })} rows={['refreshInterval']}
        swipeActions={SWIPES} afterDeleteModes={AFTER_DELETE} sameAccountApplies={prefs.afterDeleteSelect !== 'none'}
        sendDelayWarning={false}
        copy={{ autoDownloadHint: t('mobile.prefs.autoDownloadHint'), swipeLabel: t('mobile.prefs.swipeRows'), swipeHint: t('mobile.prefs.swipeRowsHint') }}
        sendingExtra={(
          <SettingRow label={t('settings.accounts.automaticallyAddOutgoingEmails')}>
            <ToggleSwitch label={t('settings.accounts.automaticallyAddOutgoingEmails')} active={prefs.defaultSignatureEnabled}
              onClick={() => save({ defaultSignatureEnabled: !prefs.defaultSignatureEnabled })} />
          </SettingRow>
        )} />
      <SaveFailed failed={failed} />
    </MobileViewEnv>
  );
}

/** Each account's notification settings (`mobile.accountSettings.*`), and its folders once opened. */
function useAccountNotifications(accounts) {
  const [values, setValues] = useState({});
  const [folders, setFolders] = useState({});
  const ids = accounts.map((a) => a.id).join('\n');
  useEffect(() => {
    let live = true;
    for (const id of ids ? ids.split('\n') : []) {
      daemonCall('mobile.accountSettings.get', { accountId: id }).then(
        (v) => { if (live) setValues((all) => ({ ...all, [id]: v || {} })); },
        () => { if (live) setValues((all) => ({ ...all, [id]: {} })); },
      );
    }
    return () => { live = false; };
  }, [ids]);
  const save = useCallback(async (accountId, patch) => {
    try {
      const v = await daemonCall('mobile.accountSettings.set', { accountId, values: patch });
      setValues((all) => ({ ...all, [accountId]: v || {} }));
    } catch {
      // The controls stay where they were.
    }
  }, []);
  const loadFolders = useCallback((accountId) => {
    daemonCall('mobile.folders.list', { accountId }).then(
      (r) => setFolders((all) => ({ ...all, [accountId]: (r?.folders || []).filter((f) => !f.noselect) })),
      () => setFolders((all) => ({ ...all, [accountId]: [] })),
    );
  }, []);
  return { values, folders, save, loadFolders };
}

/** The priority senders (`importantSenders`, kept by the engine with the preferences). */
function usePrioritySenders() {
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    daemonCall('mobile.prefs.get').then(
      (p) => { if (live) setList(Array.isArray(p?.importantSenders) ? p.importantSenders : []); },
      () => { if (live) setList([]); },
    );
    return () => { live = false; };
  }, []);
  const save = useCallback(async (next) => {
    try {
      const p = await daemonCall('mobile.prefs.set', { importantSenders: next });
      setList(Array.isArray(p?.importantSenders) ? p.importantSenders : next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  return { list: list || [], save, failed };
}

export function Notifications() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const allAccounts = useMobileStore((s) => s.accounts);
  const accounts = visibleAccounts(allAccounts);
  const [savePref, prefFailed] = useSavePrefs();
  const [values, setValues] = useState(null); // { notifications: 'on'|'off', notificationPreview: bool }
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(null); // the key being saved
  const [problem, setProblem] = useState(null); // 'denied' | 'failed'
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let live = true;
    daemonCall('mobile.settings.get').then(
      (v) => { if (live) setValues(v); },
      () => { if (live) setLoadFailed(true); },
    );
    return () => { live = false; };
  }, []);

  const save = useCallback(async (key, patch) => {
    setBusy(key);
    try {
      const next = await daemonCall('mobile.settings.set', patch);
      if (mounted.current) {
        setValues(next);
        setProblem(null);
      }
    } catch {
      if (mounted.current) setProblem('failed');
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, []);

  // The system's answer against the stored "on": turned off in the system settings, they are off.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const reconcile = useCallback(async () => {
    if (valuesRef.current?.notifications !== 'on') return;
    let granted = true;
    try {
      ({ granted } = await notificationPermission());
    } catch {
      return; // No answer: leave it as it is.
    }
    if (granted || !mounted.current || valuesRef.current?.notifications !== 'on') return;
    setProblem('denied');
    try {
      const next = await daemonCall('mobile.settings.set', { notifications: 'off' });
      if (mounted.current) setValues(next);
    } catch {
      if (mounted.current) setValues((v) => (v ? { ...v, notifications: 'off' } : v));
    }
  }, []);
  const checkedOnce = useRef(false);
  useEffect(() => {
    if (!values || checkedOnce.current) return;
    checkedOnce.current = true;
    reconcile();
  }, [values, reconcile]);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onVisible = () => { if (document.visibilityState !== 'hidden') reconcile(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reconcile]);

  const onNotifications = useCallback(async (on) => {
    if (!on) return save('notifications', { notifications: 'off' });
    setBusy('notifications');
    let granted = false;
    try {
      ({ granted } = await requestNotificationPermission());
    } catch {
      if (mounted.current) { setProblem('failed'); setBusy(null); }
      return undefined;
    }
    if (!mounted.current) return undefined;
    if (!granted) {
      setProblem('denied');
      setBusy(null);
      return undefined;
    }
    return save('notifications', { notifications: 'on' });
  }, [save]);

  const perAccount = useAccountNotifications(accounts);
  const senders = usePrioritySenders();
  const shownAccounts = accounts.map((account) => {
    const v = perAccount.values[account.id] || {};
    const watched = Array.isArray(v.notifyFolders) ? v.notifyFolders : ['INBOX'];
    const listed = perAccount.folders[account.id];
    // A stored folder the list does not hold (a desktop import's) stays listed so it can be unticked.
    const extra = listed ? watched.filter((p) => !listed.some((f) => f.path === p)).map((p) => ({ path: p, label: p })) : [];
    return {
      id: account.id,
      name: account.displayName || account.email,
      color: accountColor(account),
      initial: initialOf(account),
      config: { enabled: v.notify !== false, folders: watched, quietHours: v.quietHours && typeof v.quietHours === 'object' ? v.quietHours : null },
      folderOptions: listed ? [...listed.map((f) => ({ path: f.path, label: folderLabel(f) })), ...extra] : null,
    };
  });
  const setQuietHours = (accountId, quietHours) => {
    const span = { ...DEFAULT_QUIET_HOURS, ...quietHours };
    if (HHMM.test(span.start) && HHMM.test(span.end)) perAccount.save(accountId, { quietHours: span });
  };
  const addSender = (match) => {
    // As desktop's addImportantSender: once per sender in any case.
    if (senders.list.some((x) => String(x.match).toLowerCase() === match.toLowerCase())) return;
    senders.save([...senders.list, { match, throughQuietHours: true }]);
  };

  const on = values?.notifications === 'on';
  return (
    <MobileViewEnv>
      <NotificationsView
        enabled={on} onEnabled={onNotifications} enabledBusy={!values || busy === 'notifications'}
        showPreview={values ? values.notificationPreview !== false : true}
        onShowPreview={(v) => save('notificationPreview', { notificationPreview: v })}
        sound={{ kind: 'switch', on: prefs.notificationSound, onChange: (v) => savePref({ notificationSound: v }) }}
        accounts={shownAccounts} onAccountExpand={perAccount.loadFolders}
        onAccountEnabled={(id, next) => perAccount.save(id, { notify: next })}
        onAccountFolders={(id, next) => perAccount.save(id, { notifyFolders: next })}
        onAccountQuietHours={setQuietHours}
        importantSenders={senders.list} onAddSender={addSender}
        onRemoveSender={(match) => senders.save(senders.list.filter((x) => x.match !== match))}
        onSenderThroughQuietHours={(match, through) => senders.save(senders.list.map((x) => (x.match === match ? { ...x, throughQuietHours: through } : x)))}
        badge={isAndroid() ? null : { enabled: prefs.badgeEnabled, mode: prefs.badgeMode, onEnabled: (v) => savePref({ badgeEnabled: v }), onMode: (v) => savePref({ badgeMode: v }) }}
        copy={{
          enableLabel: t('mobile.settings.notifyToggle'), enableHint: t('mobile.settings.notifyHint'),
          soundHint: t('mobile.prefs.soundHint'), badgeHint: t('mobile.prefs.badgeHint'), badgeDescription: null,
        }}
        notice={(
          <>
            {loadFailed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}
            {problem === 'denied' && <p className="mv-settings__note" role="status">{t('mobile.settings.notifyDenied')}</p>}
            {problem === 'failed' && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
          </>
        )} />
      <SaveFailed failed={prefFailed || senders.failed} />
    </MobileViewEnv>
  );
}
