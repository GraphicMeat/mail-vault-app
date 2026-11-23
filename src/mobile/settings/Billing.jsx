// Settings > Billing on the phone (in the navigation while Premium is on): desktop's Billing views
// for what a phone can honestly do.
//
// - The plan: "Premium: active until <date> (App Store)" (premium.js), as desktop's current plan.
// - Manage subscription, on the plan's card: a store subscription goes to the store's own page (Apple's subscriptions
//   page on iOS, Play's on Android), handed to the system as every link is. A website
//   subscription has none here: its page (the Stripe portal) can buy or restart a plan, which
//   neither store lets an app offer. Buying and restoring stay on the Premium screen (Premium.jsx).
// - Devices: the website account's devices (`mobile.premium.devices`), this phone marked, every
//   other one with Remove (`mobile.premium.removeDevice`), which frees its place. The engine
//   answers with opaque keys; no device's client id reaches the page.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BillingPlanView, BillingDevicesView, ManageSubscriptionButton } from '../../components/settings/views/BillingViews';
import { Button } from '../../components/ui/Button';
import { SettingsPageLayout } from '../../components/ui/SettingsForm';
import { daemonCall } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { errorKey } from '../errors.js';
import { MANAGE_URL, premiumSummary } from '../premium.js';
import { MobileViewEnv, openExternal } from './MobileViewEnv.jsx';

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

export default function Billing() {
  const t = useT();
  const premium = useMobileStore((s) => s.premium);
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

  const store = premium.source === 'apple' || premium.source === 'google' ? premium.source : null;
  const data = list.data;
  const devices = data?.available ? data.devices ?? [] : [];

  return (
    <MobileViewEnv>
      <SettingsPageLayout>
        <BillingPlanView isPremium={premium.premium === true} statusLabel={premiumSummary(premium)}>
          {store && (
            <ManageSubscriptionButton data-mv-manage={store} onClick={() => openExternal(MANAGE_URL[store])}
              hint={t('mobile.premium.manageHint', { store: t(`mobile.premium.source.${store}`) })} />
          )}
        </BillingPlanView>

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
      </SettingsPageLayout>
    </MobileViewEnv>
  );
}
