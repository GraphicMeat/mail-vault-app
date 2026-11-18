// Settings > Unsubscribe as a view: the senders whose mail carries an unsubscribe link (one row
// each: name or address, messages, the newest one, how it unsubscribes, Unsubscribe) and the
// history of unsubscribes. Both apps hand it their answers, already narrowed to the scope.
//
// - `scopes`: the pills (All accounts, then each account: `{ value, label, color, state, count,
//   title }`), shown with more than one account; `scope` / `onScope`.
// - `failures`: `[{ id, text }]`, an account whose list could not be read; `loading`.
// - `senders`: `[{ accountId, address, name, count, lastAt, method }]` (`lastAt` a date or ms);
//   `accountOf(id)`: `{ email, color }` for the account line under a sender in All accounts
//   (`showAccounts`). `onUnsubscribe(sender)`; `onShowSender(sender)` (desktop's main window) makes
//   the sender's name open its mail. `pendingKey` / `confirm`: an inline question rendered under
//   that sender's row (the phone's; desktop asks in its own dialog).
// - `history`: `[{ accountId, address, unsubscribedAt, method, status }]`; `accountLabel(id)`.
// - `notice`: rendered above the lists (the phone's outcome of the last unsubscribe).
import React, { useRef } from 'react';
import { AlertCircle, Loader, MailX } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsPageLayout, SettingsSection } from '../../ui/SettingsForm';
import { useT, useViewEnv } from './viewContext';

const CELL = 'py-1.5 px-2 text-left align-middle';
const PILL_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** The key of one sender row: its account and address. */
export const senderKey = sender => `${sender.accountId}\u0000${sender.address}`;

/** One pill per scope, a radio group with the arrow keys, Home and End. */
function ScopePills({ label, options, value, onChange }) {
  const { locale } = useViewEnv();
  const pills = useRef([]);
  const move = (event, index) => {
    const step = PILL_KEYS[event.key];
    const next = step ? (index + step + options.length) % options.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(options[next].value);
    pills.current[next]?.focus();
  };
  return <div role="radiogroup" aria-label={label} data-testid="unsubscribe-scope" className="flex flex-wrap gap-2 mb-4">
    {options.map((option, index) => {
      const on = option.value === value;
      return <button key={option.value || '*'} ref={node => { pills.current[index] = node; }} type="button"
        role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-scope={option.value}
        data-state={option.state} aria-busy={option.state === 'loading' || undefined} title={option.title}
        onClick={() => onChange(option.value)} onKeyDown={event => move(event, index)}
        className={`inline-flex items-center gap-1.5 min-w-0 max-w-full px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${on
          ? 'bg-mail-accent-fill text-white border-mail-accent'
          : 'border-mail-border text-mail-text-muted hover:border-mail-accent hover:text-mail-text'}`}>
        {option.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: option.color }} aria-hidden="true" />}
        <span className="truncate">{option.label}</span>
        {option.state === 'loading' ? <Loader size={12} className="animate-spin shrink-0" aria-hidden="true" />
          : option.state === 'error' ? <AlertCircle size={12} className={`shrink-0 ${on ? '' : 'text-mail-danger'}`} aria-hidden="true" />
          : <span className={`shrink-0 rounded-full px-1.5 text-[11px] leading-4 tabular-nums ${on
            ? 'bg-white/20 text-white' : 'bg-mail-accent/10 text-mail-accent-text'}`}>{Number(option.count).toLocaleString(locale)}</span>}
      </button>;
    })}
  </div>;
}

export function UnsubscribeView({
  scopes, scope, onScope, failures = [], loading, senders, history, showAccounts = false, accountOf, accountLabel,
  onUnsubscribe, onShowSender, pendingKey = null, confirm = null, notice = null,
}) {
  const t = useT();
  const { locale, formatDateTime, Private, privateAttr: pa } = useViewEnv();
  const count = n => Number(n).toLocaleString(locale);
  const methodLabel = method => method === 'one-click' ? t('unsubscribe.methodOneClick')
    : method === 'browser' ? t('unsubscribe.methodLink') : t('unsubscribe.methodEmail');
  const statusLabel = status => status === 'ok' ? t('common.done')
    : status === 'failed' ? t('unsubscribe.statusFailed') : t('unsubscribe.statusOpened');

  return <SettingsPageLayout as="section" spaced={false} data-testid="unsubscribe-settings" aria-label={t('unsubscribe.tabLabel')}>
    <SettingsSection title={t('unsubscribe.subscriptions')} description={t('unsubscribe.intro')}>
      {scopes.length > 2 && <ScopePills label={t('unsubscribe.scope')} options={scopes} value={scope} onChange={onScope} />}
      {failures.length > 0 && <div role="alert" className="mb-3 space-y-1">
        {failures.map(({ id, text }) => <p key={id} className="text-sm text-mail-danger">{text}</p>)}
      </div>}
      {notice}
      {loading && senders.length === 0 && <p className="text-sm text-mail-text-muted" aria-busy="true">{t('unsubscribe.loading')}</p>}
      {!loading && senders.length === 0 && failures.length === 0 && <p className="text-sm text-mail-text-muted" data-testid="unsubscribe-empty">{t('unsubscribe.empty')}</p>}
      {senders.length > 0 && <table className="unsubscribe-table w-full text-sm" data-testid="unsubscribe-senders">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colSender')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colMessages')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colLast')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colMethod')}</th>
          <th className={CELL}><span className="sr-only">{t('unsubscribe.action')}</span></th>
        </tr></thead>
        <tbody>{senders.map(sender => {
          const label = pa(sender.name || sender.address, 'name');
          const account = showAccounts && accountOf(sender.accountId);
          const asking = pendingKey === senderKey(sender);
          return <React.Fragment key={senderKey(sender)}>
            <tr data-sender={pa(sender.address, 'email')} className={asking ? '' : 'border-b border-mail-border last:border-0'}>
              <td className={`${CELL} max-w-0 w-1/2`}>
                {onShowSender
                  ? <button type="button" onClick={() => onShowSender(sender)} aria-label={t('unsubscribe.showMail', { sender: label })}
                    title={t('unsubscribe.showMail', { sender: label })}
                    className="block max-w-full truncate text-left font-medium text-mail-accent-text hover:underline underline-offset-2 rounded-sm">{label}</button>
                  : <div className="font-medium text-mail-text truncate" dir="auto">{label}</div>}
                {(sender.name || account) && <div className="flex items-center gap-x-2 min-w-0 text-xs text-mail-text-muted">
                  {sender.name && <span className="truncate"><Private kind="email">{sender.address}</Private></span>}
                  {account && <span data-testid="unsubscribe-row-account" className="inline-flex items-center gap-1 min-w-0 shrink-0 max-w-[50%]">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: account.color }} aria-hidden="true" />
                    <span className="truncate"><Private kind="email">{account.email}</Private></span>
                  </span>}
                </div>}
              </td>
              <td className={`${CELL} tabular-nums`}>{count(sender.count)}</td>
              <td className={`${CELL} text-xs text-mail-text-muted`}>{sender.lastAt ? formatDateTime(sender.lastAt) : ''}</td>
              <td className={CELL}><span className="text-xs whitespace-nowrap rounded-full px-2 py-0.5 bg-mail-accent/10 text-mail-accent-text">{methodLabel(sender.method)}</span></td>
              <td className={`${CELL} text-right`}>
                {!asking && <Button variant="secondary" size="sm" data-testid="unsubscribe-sender" onClick={() => onUnsubscribe(sender)}>
                  <MailX size={14} aria-hidden="true" />{t('unsubscribe.action')}
                </Button>}
              </td>
            </tr>
            {asking && <tr className="unsubscribe-confirm border-b border-mail-border last:border-0"><td colSpan={5} className={CELL}>{confirm}</td></tr>}
          </React.Fragment>;
        })}</tbody>
      </table>}
    </SettingsSection>

    <SettingsSection title={t('unsubscribe.history')}>
      {history.length === 0 && !loading && <p className="text-sm text-mail-text-muted">{t('unsubscribe.historyEmpty')}</p>}
      {history.length > 0 && <table className="unsubscribe-table w-full text-sm" data-testid="unsubscribe-history">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colSender')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colAccount')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colDate')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colStatus')}</th>
        </tr></thead>
        <tbody>{history.map((row, index) => <tr key={`${row.accountId}-${row.address}-${row.unsubscribedAt}-${index}`} className="border-b border-mail-border last:border-0">
          <td className={CELL}><Private kind="email">{row.address}</Private></td>
          <td className={`${CELL} text-xs text-mail-text-muted`}><Private kind="name">{accountLabel(row.accountId)}</Private></td>
          <td className={`${CELL} text-xs text-mail-text-muted`}>{formatDateTime(row.unsubscribedAt)}</td>
          <td className={`${CELL} text-xs`}>{methodLabel(row.method)} · {statusLabel(row.status)}</td>
        </tr>)}</tbody>
      </table>}
    </SettingsSection>
  </SettingsPageLayout>;
}
