// Settings > Diagnostics on the phone: desktop's Pending actions and Logs views over the engine.
//
// - Unfinished server actions (`mobile.actions.pending`, the engine's journal): the deletes, moves
//   and flag changes the server has not taken yet, why the last try failed and how often it was
//   tried. Retry now (`mobile.actions.retry`: the waits after a failure are forgiven) and, per
//   action, Cancel (`mobile.actions.discard`): it is given up, and a message it hid shows again,
//   since the server still has it. Read again every 4 seconds and on each action result.
// - Logs (`logs.rs`): the newest 500 lines with Refresh, Copy (into a bug report or a message to
//   support) and Clear, asked first right under the buttons. The detail level (`logVerbosity`, a
//   preference) applies to the next line the engine writes.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PendingActionsView } from '../../components/settings/views/PendingActionsView';
import { LogsView } from '../../components/settings/views/LogsView';
import { Button } from '../../components/ui/Button';
import { daemonCall, listen } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { errorKey } from '../errors.js';
import { formatFullDate } from '../format.js';
import { MobileViewEnv, SaveFailed, useSavePrefs } from './MobileViewEnv.jsx';

const PENDING_MS = 4000;

// The engine's action kinds as desktop's ops; literal keys, so the catalog tests see each one.
const OPS = Object.freeze({
  delete: ['delete', 'settings.pendingActions.opDelete'],
  move: ['move', 'settings.pendingActions.opMove'],
  flag: ['flag', 'settings.pendingActions.opFlag'],
  unflag: ['flag', 'settings.pendingActions.opFlag'],
  seen: ['flag', 'settings.pendingActions.opFlag'],
  unseen: ['flag', 'settings.pendingActions.opFlag'],
});
const opOf = (kind) => (Object.hasOwn(OPS, kind) ? OPS[kind] : ['other', 'settings.pendingActions.opOther']);

export function PendingActions() {
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
    const id = setInterval(load, PENDING_MS);
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
  const entries = (list || []).map((entry) => {
    const [op, labelKey] = opOf(entry.kind);
    const count = Array.isArray(entry.uids) ? entry.uids.length : 0;
    const where = [emailOf(entry.accountId), entry.folder,
      entry.createdMs > 0 && t('settings.pendingActions.queuedAt', { date: formatFullDate(entry.createdMs, prefs) })].filter(Boolean).join(' · ');
    return {
      id: entry.seq, seq: entry.seq, op, labelKey, total: count, gone: 0, left: count, where,
      tries: entry.attempts > 0 ? entry.attempts : null, untried: !(entry.attempts > 0),
      reason: entry.lastError ? t(errorKey(entry.lastError)) : null, messages: null,
    };
  });

  return (
    <MobileViewEnv>
      <PendingActionsView entries={entries} busy={busy} loaded={list !== null}
        problem={failed ? t('mobile.settings.loadFailed') : null}
        onRetry={() => act(() => daemonCall('mobile.actions.retry', {}))}
        onCancel={(entry) => act(() => daemonCall('mobile.actions.discard', { seq: entry.seq }))}
        cancelDisabled={busy} cancelLabel={(label) => `${t('common.cancel')}: ${label}`} />
    </MobileViewEnv>
  );
}

export function Logs() {
  const t = useT();
  const level = useMobileStore((s) => s.prefs?.logVerbosity) || 'standard';
  const [save, saveFailed] = useSavePrefs();
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const got = await daemonCall('mobile.logs.get', { lines: 500 });
      if (mounted.current) {
        setText(typeof got?.text === 'string' ? got.text : '');
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      if (mounted.current) setCopied(true);
      setTimeout(() => { if (mounted.current) setCopied(false); }, 2000);
    } catch {
      if (mounted.current) setFailed(true);
    }
  };

  const clear = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      await daemonCall('mobile.logs.clear', {});
    } catch {
      if (mounted.current) setFailed(true);
    }
    await load();
  };

  return (
    <MobileViewEnv>
      <LogsView level={level} onLevel={(logVerbosity) => save({ logVerbosity })} notes={<SaveFailed failed={saveFailed} />}
        text={text} emptyText={t('mobile.logs.empty')} loading={text === null && !failed} busy={busy}
        onRefresh={load} onCopy={copy} copied={copied} onClear={() => setConfirming(true)} clearLabel={t('settings.logs.clearLog2')}
        problem={failed ? <p className="text-xs text-mail-danger mb-2" role="alert">{t('mobile.settings.loadFailed')}</p> : null}
        confirm={confirming && (
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4" role="alertdialog" aria-label={t('settings.logs.clearLog')} data-mv-logs-confirm>
            <p className="text-sm text-mail-text-muted">{t('mobile.logs.clearConfirm')}</p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>{t('settings.logs.keep')}</Button>
              <Button variant="danger" size="sm" onClick={clear}>{t('settings.logs.clearLog2')}</Button>
            </div>
          </div>
        )} />
    </MobileViewEnv>
  );
}
