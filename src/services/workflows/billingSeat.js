import { fetchSubscriptionStatus, getClientInfo } from '../billingApi';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';

/**
 * A computer signed in to Premium by address on 2.25.0 has a device seat but no Stripe customer
 * id. It stays signed in: the status call names the address and this device's id, and the
 * server answers it only while this device holds a live seat (website/api/billing-identity.js,
 * seatRefreshOpen). Also brings back a sign-in an earlier nightly dropped
 * (`billingCodeSignInNeeded` with the address kept).
 *
 * @returns {Promise<'signed-in'|'code-needed'|'offline'|null>} null when there is nothing to do.
 */
export async function refreshAddressSignIn() {
  const s = useSettingsStore.getState();
  const profile = s.billingProfile;
  if (profile?.customerId) return null;
  const addressOnly = !!profile?.hasSubscription;
  if (!s.billingEmail || !(addressOnly || s.billingCodeSignInNeeded)) return null;

  let result;
  try {
    const client = await getClientInfo();
    result = await fetchSubscriptionStatus({
      email: s.billingEmail, clientId: client.clientId, register: true,
      clientName: client.clientName, platform: client.platform,
      appVersion: client.appVersion, osVersion: client.osVersion,
    });
  } catch (e) {
    // A refusal is an answer; a network failure is not, and leaves everything as it was.
    if (!e?.status || e.status >= 500 || e.status === 429) return 'offline';
    result = null;
  }

  if (result && hasPremiumAccess(result)) {
    useSettingsStore.setState({ billingProfile: result, billingLastChecked: Date.now(), billingCodeSignInNeeded: false });
    return 'signed-in';
  }
  // The address stays, so Billing has it picked when it asks for the code.
  useSettingsStore.setState({ billingProfile: null, billingCodeSignInNeeded: true });
  return 'code-needed';
}
