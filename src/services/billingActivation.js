import { redeemActivation, fetchSubscriptionStatus, getClientInfo } from './billingApi';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { notify } from '../stores/focusStore';
import { t } from '../i18n/index.js';

/**
 * Activation by link. The website's web checkout ends on a page that opens
 * `mailvault://activate?token=...`; the shell queues the URL and wakes this
 * bridge (the same shape as the mailto bridge). The token is spent for who
 * paid, then the ordinary status call signs in and registers this device, so
 * the 5-device limit stays where it already lives.
 */

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

/** The token in a `mailvault://activate?token=...` URL, or null for anything else. */
export function parseActivationUrl(href) {
  if (typeof href !== 'string') return null;
  const m = /^mailvault:\/\/activate\/?\?(.*)$/i.exec(href.trim());
  if (!m) return null;
  const token = new URLSearchParams(m[1]).get('token');
  return token && TOKEN.test(token) ? token : null;
}

/**
 * Spend a token and sign this install in.
 * @returns {Promise<{ok:true,result:object}|{ok:false,reason:'expired'|'unreachable'|'no_premium'}>}
 */
export async function activateWithToken(token) {
  let who;
  try {
    who = await redeemActivation(token);
  } catch (e) {
    return { ok: false, reason: e?.status === 410 ? 'expired' : 'unreachable' };
  }
  let result;
  try {
    const client = await getClientInfo();
    result = await fetchSubscriptionStatus({
      customerId: who.customerId, email: who.customerEmail,
      clientId: client.clientId, register: true,
      clientName: client.clientName, platform: client.platform,
      appVersion: client.appVersion, osVersion: client.osVersion,
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!hasPremiumAccess(result)) return { ok: false, reason: 'no_premium', result };
  const store = useSettingsStore.getState();
  store.setBillingEmail(result.customerEmail || who.customerEmail);
  store.setBillingProfile(result);
  return { ok: true, result };
}

/** The OS notification that closes the loop for someone who clicked a link in a browser. */
export function announceActivation(outcome) {
  if (outcome.ok) {
    notify(t('settings.billing.activatedTitle'), t('settings.billing.activatedBody', { email: outcome.result.customerEmail }));
    return;
  }
  const body = outcome.reason === 'expired' ? t('settings.billing.activationExpired')
    : outcome.reason === 'no_premium' ? t('settings.billing.activationNoPremium')
      : t('settings.billing.activationUnreachable');
  notify(t('settings.billing.activationFailedTitle'), body);
}

/**
 * Bridges activation links the OS hands to the app. The queue in Rust is the
 * source of truth (a link that launches the app lands there before this webview
 * exists); the event is only a wake-up. `idle()` resolves once the work queued
 * so far has finished.
 */
export function startActivationBridge({ invoke, listen, onResult }) {
  let active = true;
  let unlisten = null;
  let work = Promise.resolve();
  const drain = () => {
    work = work.then(async () => {
      if (!active) return;
      const urls = (await invoke('take_pending_activation')) || [];
      for (const href of urls) {
        const token = parseActivationUrl(href);
        if (!token) continue;
        onResult?.(await activateWithToken(token));
      }
    }).catch(() => {});
    return work;
  };
  const ready = Promise.resolve().then(() => listen('activation-open', () => { void drain(); }))
    .then(fn => { if (active) unlisten = fn; else fn(); })
    .then(() => drain());
  return {
    ready,
    idle: () => work,
    stop: () => { active = false; unlisten?.(); },
  };
}
