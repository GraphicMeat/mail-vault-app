/**
 * Billing API client — communicates with the hosted website API (not Tauri IPC).
 * All Stripe interactions happen server-side; this client handles checkout/portal
 * URLs and subscription status reads.
 */

const BASE = import.meta.env.VITE_BILLING_API_URL || 'https://mailvaultapp.com';

// Rate-limit tracking — set when server returns 429
let _rateLimitedUntil = 0; // timestamp

class BillingRateLimitError extends Error {
  constructor(retryAfterSec) {
    const mins = Math.ceil(retryAfterSec / 60);
    super(`Billing checked too often. Try again in ${mins > 1 ? mins + ' minutes' : retryAfterSec + ' seconds'}.`);
    this.name = 'BillingRateLimitError';
    this.retryAfterMs = retryAfterSec * 1000;
    this.rateLimitedUntil = Date.now() + this.retryAfterMs;
  }
}

async function billingFetch(endpoint, options = {}) {
  // Block if locally rate-limited
  if (Date.now() < _rateLimitedUntil) {
    const remaining = Math.ceil((_rateLimitedUntil - Date.now()) / 1000);
    throw new BillingRateLimitError(remaining);
  }

  const url = `${BASE}${endpoint}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('Billing service timed out. Please try again.');
    }
    throw new Error('Could not reach billing service. Check your internet connection.');
  }

  // Handle 429 with Retry-After
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || res.headers.get('retry-after'), 10);
    const secs = (retryAfter > 0 && retryAfter < 3600) ? retryAfter : 60;
    _rateLimitedUntil = Date.now() + secs * 1000;
    throw new BillingRateLimitError(secs);
  }

  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch {
      throw new Error(`Billing service error (${res.status}) on ${endpoint}.`);
    }
    throw new Error(body.message || body.error || `Billing request failed (${res.status}).`);
  }
  return res.json();
}

export function getBillingRateLimitedUntil() { return _rateLimitedUntil; }
export function isBillingRateLimited() { return Date.now() < _rateLimitedUntil; }
export { BillingRateLimitError };

/** Fetch available pricing plans for the user's detected currency. */
export async function fetchPricing({ currency, country } = {}) {
  const params = new URLSearchParams();
  if (currency) params.set('currency', currency);
  if (country) params.set('country', country);
  return billingFetch(`/api/billing/pricing?${params.toString()}`);
}

/** Create a Stripe Checkout Session and return the URL to open in browser. */
export async function createCheckoutSession(email, priceType, { planId, currency } = {}) {
  return billingFetch('/api/billing/checkout-session', {
    method: 'POST',
    body: JSON.stringify({ email, priceType, planId, currency }),
  });
}

/** Create a Stripe Customer Portal session and return the URL. */
export async function createPortalSession(customerId, email) {
  return billingFetch('/api/billing/portal-session', {
    method: 'POST',
    body: JSON.stringify({ customerId, email }),
  });
}

/**
 * Fetch subscription status + optionally register the current client in one call.
 * Pass register: true to combine status check + client registration (saves a round trip).
 */
export async function fetchSubscriptionStatus({ customerId, email, clientId, register, clientName, platform, appVersion, osVersion }) {
  const params = new URLSearchParams();
  if (customerId) params.set('customerId', customerId);
  else if (email) params.set('email', email);
  if (clientId) params.set('clientId', clientId);
  if (register) {
    params.set('register', '1');
    if (clientName) params.set('clientName', clientName);
    if (platform) params.set('platform', platform);
    if (appVersion) params.set('appVersion', appVersion);
    if (osVersion) params.set('osVersion', osVersion);
  }
  return billingFetch(`/api/billing/subscription-status?${params.toString()}`);
}

/** Register this app installation as an active billing client (standalone, for explicit registration). */
export async function registerBillingClient({ customerId, email, clientId, clientName, platform, appVersion, osVersion }) {
  return billingFetch('/api/billing/register-client', {
    method: 'POST',
    body: JSON.stringify({ customerId, email, clientId, clientName, platform, appVersion, osVersion }),
  });
}

/** Unregister/disconnect a billing client. */
export async function unregisterBillingClient({ customerId, email, clientId }) {
  return billingFetch('/api/billing/unregister-client', {
    method: 'POST',
    body: JSON.stringify({ customerId, email, clientId }),
  });
}

/** Get the persistent client identity from the desktop app (Tauri IPC). */
let _cachedClientInfo = null;
const WEB_CLIENT_ID_KEY = 'mailvault_billing_client_id';

export async function getClientInfo() {
  if (_cachedClientInfo) return _cachedClientInfo;
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      _cachedClientInfo = await invoke('get_client_info');
      return _cachedClientInfo;
    }
  } catch (e) {
    console.warn('[billingApi] get_client_info failed:', e);
  }
  // Web fallback — persist ID in localStorage so the same browser reuses it
  let webId;
  try { webId = localStorage.getItem(WEB_CLIENT_ID_KEY); } catch { /* ignore */ }
  if (!webId) {
    webId = 'web-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    try { localStorage.setItem(WEB_CLIENT_ID_KEY, webId); } catch { /* ignore */ }
  }
  _cachedClientInfo = { clientId: webId, appVersion: '0.0.0', platform: 'web', osVersion: '', clientName: 'Browser' };
  return _cachedClientInfo;
}

/** Open a URL in the external browser (Tauri) or a new tab (web). */
export async function openInBrowser(url) {
  try {
    if (window.__TAURI__) {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      return true;
    }
  } catch (e) {
    console.warn('[billingApi] Tauri shell.open failed, falling back to window.open:', e);
  }
  const win = window.open(url, '_blank');
  if (!win) {
    throw new Error('Could not open browser. Please allow pop-ups for this app.');
  }
  return true;
}
