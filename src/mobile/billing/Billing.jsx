// Billing on the phone: ONE component, desktop's Billing page with the store in place of Stripe.
// It is mounted twice and shows the same content both times: as Settings > Billing (always in the
// footer group where desktop has it, Premium or not) and as the paywall layer a locked feature opens
// (`openPaywall(feature)`, Premium.jsx), which keeps the user in context with that feature marked.
//
// - desktop's BillingPlanView: the plan, "Premium: active until <date> (App Store)" or "Free", with
//   Manage subscription for a store subscription (the store's own page) and, under it, the website
//   sign-in (WebSignIn: a Stripe-bought account logs in here by email and mailed code) and, for a
//   website account, Sign out;
// - what Premium adds (Features, the locked feature highlighted);
// - without Premium, the store's plans (Plans: store price strings, Subscribe, Restore, disclosures);
// - desktop's BillingDevicesView for a website account (Devices).
// A website subscription has no manage link here: its page (the Stripe portal) can buy or restart a
// plan, which neither store lets an app offer. Never the web price, never a link to buy on the web.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BillingPlanView, ManageSubscriptionButton } from '../../components/settings/views/BillingViews';
import { Button } from '../../components/ui/Button';
import { SettingsPageLayout } from '../../components/ui/SettingsForm';
import { daemonCall } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { errorKey } from '../errors.js';
import { MANAGE_URL, premiumSummary } from '../premium.js';
import { MobileViewEnv, openExternal } from '../settings/MobileViewEnv.jsx';
import Features from './Features.jsx';
import Plans from './Plans.jsx';
import WebSignIn from './WebSignIn.jsx';
import Devices from './Devices.jsx';

export { seenAgo } from './Devices.jsx';

export default function Billing({ feature = null }) {
  const t = useT();
  const premium = useMobileStore((s) => s.premium);
  const lost = useMobileStore((s) => s.premiumLost);
  const lapsed = useMobileStore((s) => s.premiumLapsed);
  const [webDone, setWebDone] = useState(false); // a website sign-in just turned Premium on
  const [signOuts, setSignOuts] = useState(0); // a sign-out starts the website form afresh
  const [signingOut, setSigningOut] = useState(false);
  const [problem, setProblem] = useState(null); // a sign-out's error code
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    setProblem(null);
    try {
      const reply = await daemonCall('mobile.premium.webSignOut', {});
      if (!mounted.current) return;
      setWebDone(false);
      setSignOuts((n) => n + 1);
      useMobileStore.getState().setPremium(reply);
    } catch (err) {
      if (mounted.current) setProblem(err?.code ?? 'INTERNAL');
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }, [signingOut]);

  const active = premium.premium === true;
  const store = premium.source === 'apple' || premium.source === 'google' ? premium.source : null;

  return (
    <MobileViewEnv>
      <SettingsPageLayout data-mv-billing>
        <BillingPlanView isPremium={active}
          statusLabel={active ? <span role="status">{premiumSummary(premium)}</span> : t('mobile.premium.free')}
          lines={<>
            {lost === 'DEVICE_REPLACED' && !active && (
              <p className="mv-premium__error" role="alert" data-mv-lost>{t('mobile.premium.deviceReplaced')}</p>
            )}
            {lapsed && !active && lost !== 'DEVICE_REPLACED' && (
              <p className="mv-premium__note" role="status" data-mv-lapsed>{t('mobile.premium.lapsed')}</p>
            )}
          </>}>
          {active && store && (
            <ManageSubscriptionButton data-mv-manage={store} onClick={() => openExternal(MANAGE_URL[store])}
              hint={t('mobile.premium.manageHint', { store: t(`mobile.premium.source.${store}`) })} />
          )}
          {active && premium.source === 'web' && (
            // Releases this phone's place among the account's devices.
            <Button variant="link" size="touch" fullWidth className="justify-start mv-btn-flush" data-mv-web-sign-out disabled={signingOut} onClick={signOut}>
              {t('mobile.premium.web.signOut')}
            </Button>
          )}
          {problem && <p className="mv-premium__error" role="alert">{t(errorKey(problem))}</p>}
          {(!active || webDone) && <WebSignIn key={signOuts} onDone={() => setWebDone(true)} />}
        </BillingPlanView>

        {!active && <p className="mv-premium__lead">{t('mobile.premium.heading')}</p>}
        <Features highlight={feature} />

        {!active && <Plans source={premium.source} />}
        {active && <Devices />}
      </SettingsPageLayout>
    </MobileViewEnv>
  );
}
