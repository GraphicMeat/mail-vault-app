// Settings > Billing, opened from the Premium section while Premium is on: what desktop's Billing
// page offers that a phone can honestly do.
//
// - Manage subscription: a store subscription goes to the store's own page (Apple's subscriptions
//   page on iOS, Play's on Android), a plain https anchor the shell's navigation guard hands to the
//   system. A website subscription has no link here: its page (the Stripe portal) can buy or
//   restart a plan, which neither store lets an app offer.
// - Devices: the website account's devices (`mobile.premium.devices`), this phone marked, every
//   other one with Remove (`mobile.premium.removeDevice`), which frees its place. The engine
//   answers with opaque keys; no device's client id reaches the page.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { errorKey } from './errors.js';
import { MANAGE_URL } from './premium.js';

function Chevron() {
  return (
    <svg className="mv-setting__chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
    <>
      {store && (
        <>
          <h2 className="mv-settings__heading">{t('settings.billing.manageSubscription')}</h2>
          <div className="mv-settings__list">
            <a className="mv-setting mv-settings__link" data-mv-manage={store} href={MANAGE_URL[store]} target="_blank" rel="noopener noreferrer">
              <span className="mv-setting__text">
                <span className="mv-setting__label">{t('mobile.premium.manage')}</span>
                <span className="mv-setting__hint">{t('mobile.premium.manageHint', { store: t(`mobile.premium.source.${store}`) })}</span>
              </span>
              <Chevron />
            </a>
          </div>
        </>
      )}

      {list.state === 'failed' && (
        <div className="mv-settings__note mv-settings__note--error" role="alert">
          {t(errorKey(list.code))}{' '}
          <button type="button" className="mv-textbtn" onClick={load}>{t('common.retry')}</button>
        </div>
      )}

      {data?.available && devices.length > 0 && (
        <>
          <h2 className="mv-settings__heading">
            {t('settings.billing.devices')}
            {data.limit ? <span className="mv-setting__hint" data-mv-device-count>{` ${devices.length} / ${data.limit}`}</span> : null}
          </h2>
          <ul className="mv-settings__list" data-mv-devices>
            {devices.map((d) => {
              const name = d.name || d.platform || t('settings.billing.unknownDevice');
              const detail = [d.platform, d.appVersion && `v${d.appVersion}`, d.lastSeenMs && seenAgo(t, d.lastSeenMs)].filter(Boolean).join(' · ');
              return (
                <li key={d.key} className="mv-setrow" data-mv-device={d.current ? 'current' : 'other'}>
                  <span className="mv-setting__text">
                    <span className="mv-setting__label" dir="auto">
                      {name}
                      {d.current && <span className="mv-setting__hint">{` ${t('settings.billing.thisDeviceParen')}`}</span>}
                    </span>
                    {detail && <span className="mv-setting__hint">{detail}</span>}
                  </span>
                  {!d.current && (
                    <button
                      type="button"
                      className="mv-textbtn"
                      data-mv-device-remove
                      aria-label={`${t('settings.billing.removeDevice')}: ${name}`}
                      aria-busy={removing === d.key || undefined}
                      disabled={Boolean(removing)}
                      onClick={() => remove(d.key)}
                    >
                      {t('common.remove')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {problem && <p className="mv-settings__note mv-settings__note--error" role="alert">{t(errorKey(problem))}</p>}
        </>
      )}
    </>
  );
}
