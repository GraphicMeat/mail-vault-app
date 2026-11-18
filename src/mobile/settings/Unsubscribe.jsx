// Settings > Unsubscribe on the phone: desktop's Unsubscribe view over the engine. The senders whose
// mail carries an unsubscribe link, one per account and address with how many messages and how it
// unsubscribes (`mobile.unsubscribe.list`, engine `unsubscribe.rs`: core's `plan`, as on desktop),
// and the history. Unsubscribe asks first (desktop's confirm words, inline under the sender), then
// `mobile.unsubscribe.run`: a one-click list is done right here; otherwise the reply names the
// list's own web page or email, offered as a link (the shell hands it to the browser or the mail
// app, the one path every link takes). The account pills narrow the list when there are several.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { UnsubscribeView, senderKey } from '../../components/settings/views/UnsubscribeView';
import { Button } from '../../components/ui/Button';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { daemonCall } from '../transport.js';
import { accountColor } from '../accountColor.js';
import { MobileViewEnv } from './MobileViewEnv.jsx';

export default function Unsubscribe() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [scope, setScope] = useState('');
  const [confirming, setConfirming] = useState(null); // the sender asked about
  const [busy, setBusy] = useState(null);
  const [outcome, setOutcome] = useState(null); // { label, reply } | { label, error }
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
  const all = (data?.senders || []).map((s) => ({ ...s, lastAt: s.lastMs || null }));
  const senders = all.filter((s) => !current || s.accountId === current);
  const history = (data?.history || []).filter((h) => !current || h.accountId === current);
  const labelOf = (s) => s.name || s.address;
  const scopes = [
    { value: '', label: t('unsubscribe.allAccounts'), state: data ? 'ready' : 'loading', count: all.length },
    ...accounts.map((a) => ({
      value: a.id, label: a.email, color: accountColor(a), state: data ? 'ready' : 'loading',
      count: all.filter((s) => s.accountId === a.id).length,
    })),
  ];

  const run = async (sender) => {
    setConfirming(null);
    setBusy(senderKey(sender));
    setOutcome(null);
    const label = labelOf(sender);
    try {
      const reply = await daemonCall('mobile.unsubscribe.run', { accountId: sender.accountId, address: sender.address });
      if (mounted.current) setOutcome({ label, reply });
    } catch {
      if (mounted.current) setOutcome({ label, error: true });
    } finally {
      if (mounted.current) setBusy(null);
      load();
    }
  };

  const notice = (
    <>
      {outcome && (
        <div className={`mv-settings__note${outcome.error || outcome.reply?.status === 'failed' ? ' mv-settings__note--error' : ''}`} role="status" data-mv-unsub-outcome>
          {outcome.error && t('unsubscribe.failed', { sender: outcome.label })}
          {outcome.reply?.status === 'ok' && t('unsubscribe.done', { sender: outcome.label })}
          {outcome.reply?.status === 'opened' && outcome.reply.url && (
            <a className="mv-settings__link" href={outcome.reply.url} target="_blank" rel="noopener noreferrer">
              {outcome.reply.method === 'mailto' ? t('mobile.unsubscribe.sendEmail') : t('mobile.unsubscribe.openPage')}
            </a>
          )}
        </div>
      )}
      {data && senders.length === 0 && <p className="text-sm text-mail-text-muted mb-2">{t('mobile.unsubscribe.newMailOnly')}</p>}
    </>
  );

  const confirm = confirming && (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-mail-text-muted">{t('unsubscribe.confirmBody')}</p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" aria-label={t('unsubscribe.confirmTitle', { sender: labelOf(confirming) })} onClick={() => run(confirming)}>
          {t('unsubscribe.action')}
        </Button>
      </div>
    </div>
  );

  return (
    <MobileViewEnv>
      <UnsubscribeView scopes={scopes} scope={current} onScope={setScope} loading={!data && !failed}
        failures={failed ? [{ id: 'list', text: t('mobile.settings.loadFailed') }] : []}
        senders={senders} history={history} showAccounts={!current && accounts.length > 1}
        accountOf={(id) => { const a = accountOf(id); return a && { email: a.email, color: accountColor(a) }; }}
        accountLabel={(id) => accountOf(id)?.email || id}
        onUnsubscribe={(s) => { if (busy !== senderKey(s)) setConfirming(s); }}
        pendingKey={confirming ? senderKey(confirming) : null} confirm={confirm} notice={notice} />
    </MobileViewEnv>
  );
}
