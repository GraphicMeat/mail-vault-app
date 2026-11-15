// Settings > Unsubscribe: desktop's page (UnsubscribeSettings.jsx) for the phone. The senders
// whose mail carries an unsubscribe link, one per account and address with how many messages and
// how it unsubscribes (`mobile.unsubscribe.list`, engine `unsubscribe.rs`: core's `plan`, as on
// desktop), and the history. Unsubscribe asks first (desktop's confirm, inline), then
// `mobile.unsubscribe.run`: a one-click list is done right here; otherwise the reply names the
// list's own web page or email, offered as a link (the shell hands it to the browser or the mail
// app, the one path every link takes). Accounts narrow the list when there are several.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT, getMobileLocale } from './i18n.js';
import { Choice } from './SettingsPrefs.jsx';

function when(ms) {
  try {
    return new Intl.DateTimeFormat(getMobileLocale(), { dateStyle: 'medium' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export default function UnsubscribeSettings() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [scope, setScope] = useState('');
  const [confirming, setConfirming] = useState(null); // the sender asked about
  const [busy, setBusy] = useState(null);
  const [outcome, setOutcome] = useState(null); // { sender, label, reply } | { sender, label, error }
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const reply = await daemonCall('mobile.unsubscribe.list', {});
      if (mounted.current) {
        setData(reply);
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const accountOf = (id) => accounts.find((a) => a.id === id);
  const current = accounts.some((a) => a.id === scope) ? scope : '';
  const senders = (data?.senders || []).filter((s) => !current || s.accountId === current);
  const history = (data?.history || []).filter((h) => !current || h.accountId === current);
  const labelOf = (s) => s.name || s.address;
  const methodLabel = (m) => (m === 'one-click' ? t('unsubscribe.methodOneClick') : m === 'browser' ? t('unsubscribe.methodLink') : t('unsubscribe.methodEmail'));
  const statusLabel = (s) => (s === 'ok' ? t('common.done') : s === 'failed' ? t('unsubscribe.statusFailed') : t('unsubscribe.statusOpened'));

  const run = async (sender) => {
    setConfirming(null);
    setBusy(`${sender.accountId}\u0000${sender.address}`);
    setOutcome(null);
    const label = labelOf(sender);
    try {
      const reply = await daemonCall('mobile.unsubscribe.run', { accountId: sender.accountId, address: sender.address });
      if (mounted.current) setOutcome({ sender, label, reply });
    } catch {
      if (mounted.current) setOutcome({ sender, label, error: true });
    } finally {
      if (mounted.current) setBusy(null);
      load();
    }
  };

  const key = (s) => `${s.accountId}\u0000${s.address}`;
  return (
    <div data-mv-unsubscribe>
      <p className="mv-settings__note">{t('unsubscribe.intro')}</p>
      {accounts.length > 1 && (
        <div className="mv-settings__list">
          <Choice
            name="unsubScope"
            label={t('unsubscribe.scope')}
            value={current}
            options={[['', t('unsubscribe.allAccounts')], ...accounts.map((a) => [a.id, a.email])]}
            onChange={setScope}
          />
        </div>
      )}
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}

      {outcome && (
        <div className={`mv-settings__note${outcome.error || outcome.reply?.status === 'failed' ? ' mv-settings__note--error' : ''}`} role="status" data-mv-unsub-outcome>
          {outcome.error && t('unsubscribe.failed', { sender: outcome.label })}
          {outcome.reply?.status === 'ok' && t('unsubscribe.done', { sender: outcome.label })}
          {outcome.reply?.status === 'opened' && outcome.reply.url && (
            <a
              className="mv-settings__link"
              href={outcome.reply.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {outcome.reply.method === 'mailto' ? t('mobile.unsubscribe.sendEmail') : t('mobile.unsubscribe.openPage')}
            </a>
          )}
        </div>
      )}

      <h2 className="mv-settings__heading">{t('unsubscribe.subscriptions')}</h2>
      {!data && !failed && <p className="mv-settings__note" aria-busy="true">{t('unsubscribe.loading')}</p>}
      {data && senders.length === 0 && <p className="mv-settings__note">{t('unsubscribe.empty')}</p>}
      {data && senders.length === 0 && <p className="mv-settings__note">{t('mobile.unsubscribe.newMailOnly')}</p>}
      {senders.length > 0 && (
        <ul className="mv-settings__list">
          {senders.map((s) => {
            const account = !current && accounts.length > 1 ? accountOf(s.accountId) : null;
            const asking = confirming && key(confirming) === key(s);
            return (
              <li key={key(s)} className={asking ? 'mv-setrow mv-acct--confirm mv-unsub__row' : 'mv-setrow mv-unsub__row'} data-mv-unsub-sender={s.address}>
                <span className="mv-setting__text">
                  <span className="mv-setting__label" dir="auto">{labelOf(s)}</span>
                  {s.name && <span className="mv-setting__hint" dir="auto">{s.address}</span>}
                  {account && <span className="mv-setting__hint" dir="auto">{account.email}</span>}
                  <span className="mv-setting__hint">
                    {t('unsubscribe.colMessages')} {s.count} · {when(s.lastMs)} · {methodLabel(s.method)}
                  </span>
                  {asking && (
                    <>
                      <span className="mv-setting__hint">{t('unsubscribe.confirmBody')}</span>
                      <span className="mv-unsub__confirm">
                        <button type="button" className="mv-textbtn" onClick={() => setConfirming(null)}>{t('common.cancel')}</button>
                        <button
                          type="button"
                          className="mv-textbtn"
                          aria-label={t('unsubscribe.confirmTitle', { sender: labelOf(s) })}
                          onClick={() => run(s)}
                        >
                          {t('unsubscribe.action')}
                        </button>
                      </span>
                    </>
                  )}
                </span>
                {!asking && (
                  <button type="button" className="mv-textbtn" disabled={busy === key(s)} onClick={() => setConfirming(s)}>
                    {t('unsubscribe.action')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mv-settings__heading">{t('unsubscribe.history')}</h2>
      {history.length === 0 ? (
        <p className="mv-settings__note">{t('unsubscribe.historyEmpty')}</p>
      ) : (
        <ul className="mv-settings__list" data-mv-unsub-history>
          {history.map((h, i) => (
            <li key={`${h.accountId}-${h.address}-${h.unsubscribedAt}-${i}`} className="mv-setrow">
              <span className="mv-setting__text">
                <span className="mv-setting__label" dir="auto">{h.address}</span>
                <span className="mv-setting__hint" dir="auto">
                  {accountOf(h.accountId)?.email || h.accountId} · {when(h.unsubscribedAt)} · {methodLabel(h.method)} · {statusLabel(h.status)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
