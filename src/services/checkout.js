import { createCheckoutSession, openInBrowser } from './billingApi';
import { useSettingsStore } from '../stores/settingsStore';
import { t } from '../i18n/index.js';

/**
 * Start a Stripe checkout for `email` and open it in the system browser. The
 * onboarding paywall and Settings → Billing both buy through this one path:
 * the address is remembered as the billing email before the request, and a
 * customer id the server just created is kept on the profile so the
 * Check Status that follows the purchase finds it.
 *
 * Never throws: `{ ok: true }` or `{ ok: false, error }` with a message a
 * person can read, or at worst a bare API code the caller words itself.
 */
export async function startCheckout({ email, planId }) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return { ok: false, error: t('svc.checkout.noEmail') };
  const { setBillingEmail } = useSettingsStore.getState();
  try {
    setBillingEmail(address);
    const { url } = await createCheckoutSession(address, { planId });
    await openInBrowser(url);
    useSettingsStore.getState().noteCheckoutOpened();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || t('svc.checkout.failed') };
  }
}
