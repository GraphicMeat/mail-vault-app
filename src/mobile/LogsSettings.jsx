// Settings > Logs (desktop's LogsSettings): the engine's log file (`logs.rs`), the newest 500
// lines, with Refresh, Copy (into a bug report or a message to support) and Clear log after a
// confirm. Log detail (`logVerbosity`, a preference): Standard masks email addresses in the file,
// Verbose keeps them for a support session; the engine applies it to the next line it writes.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { Choice } from './SettingsPrefs.jsx';

const LEVELS = ['standard', 'verbose'];
// Literal keys, so the catalog tests can see every one.
const LEVEL_KEYS = Object.freeze({ standard: 'settings.logs.verbosity.standard', verbose: 'settings.logs.verbosity.verbose' });

export default function LogsSettings() {
  const t = useT();
  const level = useMobileStore((s) => s.prefs?.logVerbosity) || 'standard';
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
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

  const pickLevel = async (logVerbosity) => {
    const ok = await useMobileStore.getState().setPrefs({ logVerbosity });
    if (mounted.current) setSaveFailed(!ok);
  };

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
    <>
      <div className="mv-settings__list" data-mv-log-verbosity>
        <Choice
          name="logVerbosity"
          label={t('settings.logs.verbosityTitle')}
          value={level}
          options={LEVELS.map((v) => [v, t(LEVEL_KEYS[v])])}
          onChange={pickLevel}
        />
      </div>
      <p className="mv-settings__note">{t('settings.logs.verbosityDescription')}</p>
      {saveFailed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}

      <h2 className="mv-settings__heading">{t('settings.logs.applicationLogs')}</h2>
      <p className="mv-settings__note">{t('settings.logs.viewRecentApplicationLogsLast')}</p>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}
      <div className="mv-settings__row mv-logs__actions">
        <button type="button" className="mv-textbtn" data-mv-logs-refresh disabled={busy} onClick={load}>{t('settings.logs.refresh')}</button>
        <button type="button" className="mv-textbtn" data-mv-logs-copy disabled={busy || !text} onClick={copy}>
          {copied ? t('settings.logs.copied') : t('viewer.copy')}
        </button>
        <button type="button" className="mv-textbtn mv-textbtn--danger" data-mv-logs-clear disabled={busy} onClick={() => setConfirming(true)}>
          {t('settings.logs.clearLog2')}
        </button>
      </div>
      {confirming && (
        <div className="mv-settings__note" role="alertdialog" aria-label={t('settings.logs.clearLog')} data-mv-logs-confirm>
          <p>{t('mobile.logs.clearConfirm')}</p>
          <button type="button" className="mv-textbtn mv-textbtn--danger" onClick={clear}>{t('settings.logs.clearLog2')}</button>
          <button type="button" className="mv-textbtn" onClick={() => setConfirming(false)}>{t('settings.logs.keep')}</button>
        </div>
      )}
      {text !== null && (
        <pre className="mv-logs" data-mv-logs-text tabIndex={0} aria-label={t('settings.logs.applicationLogs')}>
          {text || t('mobile.logs.empty')}
        </pre>
      )}
    </>
  );
}
