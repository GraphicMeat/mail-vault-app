// Premium on the phone: the engine decides (`mobile.premium.*`), the page only shows. This keeps
// the store's copy of the answer current: read at launch, re-checked when the app comes back to
// the front (the engine rate-limits `refresh` to once in 12 hours by itself), and updated by
// `mobile.premium.changed` (renewals, a purchase approved later, a sign-in).
//
// A locked feature calls `openPaywall(feature)`: the paywall layer opens with that feature
// highlighted. `usePremium()` is the one place a feature asks "is Premium on?".
import { daemonCall, listen } from './transport.js';
import { useMobileStore } from './store.js';
import { formatFullDate } from './format.js';
import { t } from './i18n.js';

/** The features Premium adds on the phone; ids are what `openPaywall` takes. */
export const PREMIUM_FEATURES = Object.freeze(['scheduledSend', 'followUp', 'trackerBlocking']);

/** Opens the paywall with `feature` highlighted (any of PREMIUM_FEATURES, or none). */
export function openPaywall(feature = null) {
  useMobileStore.getState().openPaywall(PREMIUM_FEATURES.includes(feature) ? feature : null);
}

/** True while Premium is on (the engine's answer). */
export function usePremium() {
  return useMobileStore((s) => s.premium.premium);
}

async function readStatus() {
  try {
    useMobileStore.getState().setPremium(await daemonCall('mobile.premium.status'));
  } catch {
    // No answer: the last one stands.
  }
}

/** Asks the engine to re-check with the server (it skips the call when the last check is recent). */
export async function refreshPremium(force = false) {
  const store = useMobileStore.getState();
  try {
    store.setPremium(await daemonCall('mobile.premium.refresh', force ? { force: true } : {}));
    return null;
  } catch (err) {
    const code = err?.code ?? 'INTERNAL';
    if (code === 'DEVICE_REPLACED') {
      store.setPremiumLost('DEVICE_REPLACED');
      await readStatus();
    } else if (code === 'REFUSED') {
      await readStatus();
    }
    return code;
  }
}

/** Starts the upkeep; returns the stop function. Called once by the app. */
export function startPremiumSync() {
  let stopped = false;
  const offs = [];
  readStatus().then(() => { if (!stopped) refreshPremium(); });
  try {
    offs.push(listen('mobile.premium.changed', (status) => {
      if (status && typeof status === 'object') useMobileStore.getState().setPremium(status);
    }));
  } catch {
    // No event bridge (plain browser dev): the screens re-read on their own actions.
  }
  if (typeof document !== 'undefined') {
    const onVisible = () => { if (document.visibilityState !== 'hidden') refreshPremium(); };
    document.addEventListener('visibilitychange', onVisible);
    offs.push(() => document.removeEventListener('visibilitychange', onVisible));
  }
  return () => {
    stopped = true;
    for (const off of offs) off();
  };
}

/** Which store this phone buys from: the active subscription's, else by the system. */
export function storeOf(source) {
  if (source === 'apple' || source === 'google') return source;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  return /android/i.test(ua) ? 'google' : 'apple';
}

/** "Premium: active until <date> (App Store)" or "Free". */
export function premiumSummary(premium) {
  if (!premium?.premium) return t('mobile.premium.free');
  const source = ['apple', 'google', 'web'].includes(premium.source) ? premium.source : 'web';
  return t('mobile.premium.active', {
    date: premium.expiresMs ? formatFullDate(premium.expiresMs) : '',
    source: t(`mobile.premium.source.${source}`),
  });
}

const UNITS = { D: 'day', W: 'week', M: 'month', Y: 'year' };

/** A store's ISO 8601 period ("P1M", "P7D", "P1W") taken `count` times, in words ("3 months");
 *  null when it does not read. Both stores send the offer's period and its number of periods. */
export function offerDuration(period, count = 1) {
  const m = /^P(\d+)([DWMY])$/.exec(String(period ?? ''));
  if (!m) return null;
  const times = Number.isInteger(count) && count > 0 ? count : 1;
  return t(`mobile.premium.duration.${UNITS[m[2]]}`, { count: Number(m[1]) * times });
}

/** What an introductory offer gives, with how long it lasts (App Review wants the duration):
 *  a free trial, one price for the whole intro, or a price for each period of it. */
export function introText(offer) {
  const duration = offerDuration(offer?.period, offer?.periodCount);
  if (offer?.paymentMode === 'freeTrial') {
    return duration ? t('mobile.premium.plan.trialFor', { duration }) : t('mobile.premium.plan.trial');
  }
  const price = offer?.price ?? '';
  if (!duration) return t('mobile.premium.plan.intro', { price });
  if (offer?.paymentMode === 'payAsYouGo') return t('mobile.premium.plan.introEach', { price, duration });
  return t('mobile.premium.plan.introFor', { price, duration });
}
