// Settings > Notifications, the parts desktop's NotificationSettings.jsx has beside the switches:
// per account its own switch, then (while it is on) the folders that notify and its quiet hours;
// and the priority senders. Every value lives in the engine, which the background run reads and
// applies with desktop's policy (`notify_policy::decide`, `background.rs`):
//
// - `acct.<id>.notify`, `.notifyFolders` (`["INBOX"]` by default) and `.quietHours`
//   (`{enabled, start, end}`, local `HH:MM`, may cross midnight) through `mobile.accountSettings.*`.
//   The folders are the account's own (`mobile.folders.list`), not desktop's fixed names; a stored
//   one the list does not hold (a desktop import's) stays listed so it can be unticked.
// - `importantSenders` (`[{match, throughQuietHours}]`, an address or a bare domain) through
//   `mobile.prefs.*`: they notify through the account's switch, its folders and its quiet hours
//   (unless the entry says not through quiet hours), never through the global switch.
import React, { useCallback, useEffect, useId, useState } from 'react';
import { daemonCall } from './transport.js';
import { useT } from './i18n.js';
import { folderLabel } from './folders.js';

// Desktop's window when quiet hours are first turned on.
const DEFAULT_QUIET_HOURS = { enabled: false, start: '22:00', end: '07:00' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function Switch({ checked, busy, disabled, label, onChange }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-busy={busy || undefined}
      className="mv-setting"
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span className="mv-setting__text">
        <span className="mv-setting__label" id={`${id}-l`}>{label}</span>
      </span>
      <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
    </button>
  );
}

/** The account's watched folders as ticks: its selectable folders, then stored ones not listed. */
function NotifyFolders({ accountId, value, disabled, onChange }) {
  const t = useT();
  const [folders, setFolders] = useState(null);
  useEffect(() => {
    let live = true;
    daemonCall('mobile.folders.list', { accountId }).then(
      (r) => { if (live) setFolders((r?.folders || []).filter((f) => !f.noselect)); },
      () => { if (live) setFolders([]); },
    );
    return () => { live = false; };
  }, [accountId]);
  const listed = folders || [];
  const extra = value.filter((p) => !listed.some((f) => f.path === p))
    .map((p) => ({ path: p, name: p }));
  const toggle = (path) => onChange(value.includes(path) ? value.filter((p) => p !== path) : [...value, path]);
  return (
    <fieldset className="mv-notify__folders" disabled={disabled}>
      <legend className="mv-setting__hint">{t('settings.notifications.notifyTheseFolders')}</legend>
      {[...listed, ...extra].map((f) => (
        <label key={f.path} className="mv-notify__check">
          <input type="checkbox" checked={value.includes(f.path)} onChange={() => toggle(f.path)} />
          <span dir="auto">{folderLabel(f)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * One account's notifications: its switch (on unless turned off), usable while notifications are
 * on (`enabled`); while it is on, "Configure folders" opens its watched folders and quiet hours.
 */
export function AccountNotifications({ account, enabled }) {
  const t = useT();
  const [values, setValues] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    daemonCall('mobile.accountSettings.get', { accountId: account.id }).then(
      (v) => { if (live) setValues(v || {}); },
      () => { if (live) setValues({}); },
    );
    return () => { live = false; };
  }, [account.id]);
  const save = useCallback(async (patch) => {
    setBusy(true);
    try {
      const v = await daemonCall('mobile.accountSettings.set', { accountId: account.id, values: patch });
      setValues(v || {});
    } catch {
      // The controls stay where they were.
    } finally {
      setBusy(false);
    }
  }, [account.id]);
  const on = values?.notify !== false;
  const folders = Array.isArray(values?.notifyFolders) ? values.notifyFolders : ['INBOX'];
  const quiet = values?.quietHours && typeof values.quietHours === 'object' ? values.quietHours : null;
  const span = { ...DEFAULT_QUIET_HOURS, ...quiet };
  const setTime = (key, v) => { if (HHMM.test(v)) save({ quietHours: { ...span, enabled: true, [key]: v } }); };
  const configure = `${t('settings.notifications.configureFolders')}: ${account.email}`;
  const usable = enabled && values != null;
  return (
    <div className="mv-notify__account" data-mv-notify-account={account.id}>
      <Switch
        checked={on}
        busy={busy}
        disabled={!usable}
        label={t('mobile.settings.notifyAccount', { account: account.email })}
        onChange={(next) => save({ notify: next })}
      />
      {on && (
        <button
          type="button"
          className="mv-textbtn mv-notify__more"
          aria-label={configure}
          aria-expanded={open}
          disabled={!usable}
          onClick={() => setOpen((o) => !o)}
        >
          {t('settings.notifications.configureFolders')}
        </button>
      )}
      {on && open && usable && (
        <div className="mv-notify__options" role="group" aria-label={configure}>
          <NotifyFolders accountId={account.id} value={folders} disabled={busy} onChange={(next) => save({ notifyFolders: next })} />
          <Switch
            checked={Boolean(quiet?.enabled)}
            busy={busy}
            label={t('notifyPolicy.quietHours.title')}
            onChange={(next) => save({ quietHours: { ...span, enabled: next } })}
          />
          {quiet?.enabled && (
            <div className="mv-notify__times">
              <label className="mv-notify__time">
                <span className="mv-setting__hint">{t('common.from')}</span>
                <input
                  type="time"
                  className="mv-setting__input"
                  aria-label={`${t('notifyPolicy.quietHours.title')}: ${t('common.from')}`}
                  value={span.start}
                  disabled={busy}
                  onChange={(e) => setTime('start', e.target.value)}
                />
              </label>
              <label className="mv-notify__time">
                <span className="mv-setting__hint">{t('common.to')}</span>
                <input
                  type="time"
                  className="mv-setting__input"
                  aria-label={`${t('notifyPolicy.quietHours.title')}: ${t('common.to')}`}
                  value={span.end}
                  disabled={busy}
                  onChange={(e) => setTime('end', e.target.value)}
                />
              </label>
            </div>
          )}
          <p className="mv-settings__note">{t('notifyPolicy.quietHours.hint')}</p>
        </div>
      )}
    </div>
  );
}

/** The priority senders (`importantSenders`), as desktop's list: add, through quiet hours, remove. */
export function PrioritySenders() {
  const t = useT();
  const headingId = useId();
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    try {
      const p = await daemonCall('mobile.prefs.set', { importantSenders: next });
      setList(Array.isArray(p?.importantSenders) ? p.importantSenders : next);
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const entries = list || [];
  const add = async (e) => {
    e.preventDefault();
    // As desktop's addImportantSender: trimmed, once per sender in any case.
    const m = draft.trim();
    if (!m) return;
    if (entries.some((x) => String(x.match).toLowerCase() === m.toLowerCase())) { setDraft(''); return; }
    if (await save([...entries, { match: m, throughQuietHours: true }])) setDraft('');
  };
  return (
    <section aria-labelledby={headingId} data-mv-priority-senders>
      <h2 className="mv-settings__heading" id={headingId}>{t('notifyPolicy.allowlist.title')}</h2>
      <p className="mv-settings__note">{t('notifyPolicy.allowlist.hint')}</p>
      <ul className="mv-settings__list">
        {entries.map((entry) => (
          <li key={entry.match} className="mv-setrow">
            <span className="mv-setting__text"><span className="mv-setting__label" dir="auto">{entry.match}</span></span>
            <label className="mv-notify__check">
              <input
                type="checkbox"
                checked={entry.throughQuietHours !== false}
                disabled={busy}
                onChange={() => save(entries.map((x) => (x.match === entry.match ? { ...x, throughQuietHours: entry.throughQuietHours === false } : x)))}
              />
              <span className="mv-setting__hint">{t('notifyPolicy.allowlist.throughQuietHours')}</span>
            </label>
            <button
              type="button"
              className="mv-textbtn"
              aria-label={`${t('common.remove')}: ${entry.match}`}
              disabled={busy}
              onClick={() => save(entries.filter((x) => x.match !== entry.match))}
            >
              {t('common.remove')}
            </button>
          </li>
        ))}
        {list && entries.length === 0 && <li className="mv-setrow mv-setting__hint">{t('notifyPolicy.allowlist.empty')}</li>}
      </ul>
      <form className="mv-notify__add" onSubmit={add}>
        <input
          className="mv-setting__input"
          type="text"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          value={draft}
          placeholder={t('notifyPolicy.allowlist.placeholder')}
          aria-label={t('notifyPolicy.allowlist.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="mv-textbtn" disabled={busy || list == null}>{t('notifyPolicy.allowlist.add')}</button>
      </form>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
    </section>
  );
}
