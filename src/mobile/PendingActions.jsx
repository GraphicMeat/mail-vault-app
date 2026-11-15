// Settings > Unfinished server actions (desktop's PendingActionsSettings): the deletes, moves and
// flag changes the server has not taken yet (the engine's journal, `mobile.actions.pending`), with
// why the last try failed, how often it was tried, and two ways out: Retry now (`mobile.actions.
// retry`: the waits after a failure are forgiven) and, per action, Cancel (`mobile.actions.
// discard`): it is given up, and a message it hid shows again, since the server still has it.
// Read again every few seconds and on each action result, so a row leaves once it lands.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall, listen } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { errorKey } from './errors.js';
import { formatFullDate } from './format.js';

const REFRESH_MS = 4000;

// Literal keys, so the catalog tests can see every one.
const OP_KEYS = Object.freeze({
  delete: 'settings.pendingActions.opDelete',
  move: 'settings.pendingActions.opMove',
  flag: 'settings.pendingActions.opFlag',
  unflag: 'settings.pendingActions.opFlag',
  seen: 'settings.pendingActions.opFlag',
  unseen: 'settings.pendingActions.opFlag',
});
const opKey = (kind) => (Object.hasOwn(OP_KEYS, kind) ? OP_KEYS[kind] : 'settings.pendingActions.opOther');

function PendingRow({ entry, account, prefs, busy, onDiscard }) {
  const t = useT();
  const label = t(opKey(entry.kind));
  const count = Array.isArray(entry.uids) ? entry.uids.length : 0;
  const where = [account, entry.folder, t('common.messageCount', { count })].filter(Boolean).join(' · ');
  const tries = entry.attempts > 0
    ? t('settings.pendingActions.attempts', { count: entry.attempts })
    : t('settings.pendingActions.notTriedYet');
  return (
    <li className="mv-setrow" data-mv-pending-action={entry.seq}>
      <span className="mv-setting__text">
        <span className="mv-setting__label">{label}</span>
        <span className="mv-setting__hint" dir="auto">{where}</span>
        {entry.createdMs > 0 && (
          <span className="mv-setting__hint">{t('settings.pendingActions.queuedAt', { date: formatFullDate(entry.createdMs, prefs) })}</span>
        )}
        <span className="mv-setting__hint">{tries}</span>
        {entry.lastError && (
          <span className="mv-setting__hint mv-settings__note--error" data-mv-pending-reason>{t(errorKey(entry.lastError))}</span>
        )}
      </span>
      <button
        type="button"
        className="mv-textbtn mv-textbtn--danger"
        disabled={busy}
        aria-label={`${t('common.cancel')}: ${label}`}
        onClick={() => onDiscard(entry.seq)}
      >
        {t('common.cancel')}
      </button>
    </li>
  );
}

export default function PendingActions() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const prefs = useMobileStore((s) => s.prefs);
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const { pending } = await daemonCall('mobile.actions.pending', {});
      if (mounted.current) {
        setList(Array.isArray(pending) ? pending : []);
        setFailed(false);
      }
    } catch {
      // An unreadable journal is not "nothing is waiting": the last list stays, with a note.
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    let stop = () => {};
    try {
      stop = listen('mobile.action.result', () => load());
    } catch {
      // No event bridge (plain browser dev): the timer still refreshes.
    }
    return () => {
      clearInterval(id);
      if (typeof stop === 'function') stop();
    };
  }, [load]);

  // `call` names its method literally, so the seam check can read it.
  const act = useCallback(async (call) => {
    setBusy(true);
    try {
      await call();
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
    load();
  }, [load]);

  const emailOf = (id) => accounts.find((a) => a.id === id)?.email || '';
  const rows = list || [];

  return (
    <>
      <p className="mv-settings__note">{t('settings.pendingActions.blurb')}</p>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}
      {list && rows.length === 0 && <p className="mv-settings__note" role="status" data-mv-pending-empty>{t('settings.pendingActions.empty')}</p>}
      {rows.length > 0 && (
        <>
          <ul className="mv-settings__list" data-mv-pending>
            {rows.map((entry) => (
              <PendingRow
                key={entry.seq}
                entry={entry}
                account={emailOf(entry.accountId)}
                prefs={prefs}
                busy={busy}
                onDiscard={(seq) => act(() => daemonCall('mobile.actions.discard', { seq }))}
              />
            ))}
          </ul>
          <div className="mv-settings__list">
            <button type="button" className="mv-setting" data-mv-pending-retry disabled={busy} onClick={() => act(() => daemonCall('mobile.actions.retry', {}))}>
              <span className="mv-setting__text">
                <span className="mv-setting__label">{t('settings.pendingActions.retryNow')}</span>
              </span>
            </button>
          </div>
        </>
      )}
    </>
  );
}
