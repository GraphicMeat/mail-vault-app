// Settings > Billing as views, the parts both apps show:
// - `BillingPlanView`: the current plan, `statusLabel` with its `lines` under it (renewal, trial,
//   past due), `isPremium` for the mark, and `children` under them (desktop's sign-in, the phone's
//   Premium screen button);
// - `ManageSubscriptionButton`: Manage subscription (`hint` under it, where the phone names the
//   store that manages it);
// - `BillingDevicesView`: the subscription's devices, `{ key, name, detail, current }`, this one
//   marked, the others removable (`onRemove(key)`, `removingKey` while one goes, `busy` holds them
//   all; `removeLabel(name)`
//   names each button), with `count / limit` and a `notice` above the list.
import React from 'react';
import { CheckCircle2, CreditCard, ExternalLink, Loader, Monitor, Smartphone, X } from 'lucide-react';
import { useT } from './viewContext';

export function BillingPlanView({ isPremium, statusLabel, lines = null, children = null }) {
  return (
    <div className="settings-section">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isPremium ? 'bg-mail-accent-tint' : 'bg-mail-accent/10'}`}>
          {isPremium ? <CheckCircle2 size={20} className="text-mail-accent-text" /> : <CreditCard size={20} className="text-mail-accent-text" />}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-mail-text">{statusLabel}</h3>
          {lines}
        </div>
      </div>

      {children}
    </div>
  );
}

export function ManageSubscriptionButton({ onClick, hint = null, ...rest }) {
  const t = useT();
  const button = (
    <button onClick={onClick} {...rest}
      className="w-full py-2.5 text-sm font-medium bg-mail-surface border border-mail-border rounded-lg hover:bg-mail-surface-hover transition-colors flex items-center justify-center gap-2 text-mail-text">
      <ExternalLink size={14} />
      {t('settings.billing.manageSubscription')}
    </button>
  );
  return hint ? <div className="space-y-1">{button}<p className="text-xs text-mail-text-muted">{hint}</p></div> : button;
}

export function BillingDevicesView({ devices, count, limit, notice = null, onRemove, removingKey = null, busy = false, removeLabel = null }) {
  const t = useT();
  return (
    <div className="settings-section">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-mail-text flex items-center gap-2">
          <Monitor size={16} /> {t('settings.billing.devices')}
        </h4>
        <span className="text-xs text-mail-text-muted">{count} / {limit}</span>
      </div>

      <div className="w-full h-1.5 bg-mail-border rounded-full mb-3">
        <div className={`h-full rounded-full transition-all ${count >= limit ? 'bg-mail-warning' : 'bg-mail-accent'}`}
          style={{ width: `${Math.min(100, (count / limit) * 100)}%` }} />
      </div>

      {notice && <p className="text-xs text-mail-warning mb-3">{notice}</p>}

      <div className="space-y-2">
        {devices.map(device => (
          <div key={device.key} className={`flex items-center justify-between px-3 py-2 rounded-lg ${device.current ? 'bg-mail-accent/5 border border-mail-accent/20' : 'bg-mail-bg'}`}>
            <div className="flex items-center gap-3 min-w-0">
              {React.createElement(device.phone ? Smartphone : Monitor, { size: 14, className: device.current ? 'text-mail-accent-text flex-shrink-0' : 'text-mail-text-muted flex-shrink-0' })}
              <div className="min-w-0">
                <p className="text-xs font-medium text-mail-text truncate">
                  {device.name}
                  {device.current && <span className="ml-1.5 text-xs text-mail-accent-text font-semibold">{t('settings.billing.thisDeviceParen')}</span>}
                </p>
                <p className="text-xs text-mail-text-muted">
                  {device.detail}
                </p>
              </div>
            </div>
            {!device.current && (
              <button onClick={() => onRemove(device.key)}
                disabled={busy || removingKey === device.key}
                aria-label={removeLabel ? removeLabel(device.name) : undefined}
                className="p-1 text-mail-text-muted hover:text-mail-danger rounded transition-colors flex-shrink-0"
                title={t('settings.billing.removeDevice')}>
                {removingKey === device.key ? <Loader size={12} className="animate-spin" /> : <X size={12} />}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
