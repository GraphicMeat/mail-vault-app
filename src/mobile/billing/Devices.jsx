// The website account's devices (`mobile.premium.devices`) as desktop's BillingDevicesView: this
// phone marked, every other one with Remove (`mobile.premium.removeDevice`), which frees its place.
// The engine answers with opaque keys; no device's client id reaches the page. Part of the Billing
// component; nothing shows without a website account (the engine says `available: false`).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BillingDevicesView } from '../../components/settings/views/BillingViews';
import { Button } from '../../components/ui/Button';
import { daemonCall } from '../transport.js';
import { useT } from '../i18n.js';
import { errorKey } from '../errors.js';

// Desktop's device list allows five unless the account says otherwise (BillingSettings).
const DEFAULT_LIMIT = 5;

/** "just now", "5m ago", "3h ago", "2d ago": desktop's device list wording. */
export function seenAgo(translate, ms, now = Date.now()) {
  const mins = Math.floor((now - ms) / 60000);
  if (mins < 1) return translate('settings.billing.justNow');
  if (mins < 60) return translate('settings.billing.mAgo', { mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return translate('settings.billing.hAgo', { hrs });
  return translate('settings.billing.dAgo', { Math: Math.floor(hrs / 24) });
}

export default function Devices() {
  const t = useT();
  const [list, setList] = useState({ state: 'loading', data: null, code: null }); // loading | ready | failed
  const [removing, setRemoving] = useState(null); // the key being removed
  const [problem, setProblem] = useState(null); // a remove's error code
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(() => {
    setList((cur) => ({ ...cur, state: 'loading', code: null }));
    daemonCall('mobile.premium.devices', {}).then(
      (data) => { if (mounted.current) setList({ state: 'ready', data, code: null }); },
      (err) => { if (mounted.current) setList({ state: 'failed', data: null, code: err?.code ?? 'INTERNAL' }); },
    );
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = useCallback(async (key) => {
    if (removing) return;
    setRemoving(key);
    setProblem(null);
    try {
      const data = await daemonCall('mobile.premium.removeDevice', { key });
      if (mounted.current) setList({ state: 'ready', data, code: null });
    } catch (err) {
      if (mounted.current) setProblem(err?.code ?? 'INTERNAL');
    } finally {
      if (mounted.current) setRemoving(null);
    }
  }, [removing]);

  const data = list.data;
  const devices = data?.available ? data.devices ?? [] : [];

  return (
    <>
      {list.state === 'failed' && (
        <div className="flex items-center justify-between gap-3" role="alert">
          <p className="text-xs text-mail-danger">{t(errorKey(list.code))}</p>
          <Button size="sm" onClick={load}>{t('common.retry')}</Button>
        </div>
      )}
      {devices.length > 0 && (
        <div data-mv-devices>
          <BillingDevicesView count={devices.length} limit={data.limit || DEFAULT_LIMIT}
            removingKey={removing} busy={Boolean(removing)} onRemove={remove}
            removeLabel={(name) => `${t('settings.billing.removeDevice')}: ${name}`}
            devices={devices.map((d) => ({
              key: d.key,
              current: Boolean(d.current),
              phone: d.platform === 'ios' || d.platform === 'android',
              name: d.name || d.platform || t('settings.billing.unknownDevice'),
              detail: [d.platform, d.appVersion && `v${d.appVersion}`, d.lastSeenMs && seenAgo(t, d.lastSeenMs)].filter(Boolean).join(' · '),
            }))} />
          {problem && <p className="text-xs text-mail-danger mt-2" role="alert">{t(errorKey(problem))}</p>}
        </div>
      )}
    </>
  );
}
