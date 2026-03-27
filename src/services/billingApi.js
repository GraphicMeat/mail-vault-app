/**
 * Billing API client — communicates with the hosted website API (not Tauri IPC).
 * All Stripe interactions happen server-side; this client handles checkout/portal
 * URLs and subscription status reads.
 */

const BASE = import.meta.env.VITE_BILLING_API_URL || 'https://mailvaultapp.com';

async function billingFetch(endpoint, options = {}) {
  const url = `${BASE}${endpoint}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // Network/timeout/CORS failures
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('Billing service timed out. Please try again.');
    }
    throw new Error('Could not reach billing service. Check your internet connection.');
  }

  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`Billing service error (${res.status}) on ${endpoint}.`);
    }
    throw new Error(body.message || body.error || `Billing request failed (${res.status}).`);
  }
  return res.json();
}

/** Create a Stripe Checkout Session and return the URL to open in browser. */
export async function createCheckoutSession(email, priceType) {
  return billingFetch('/api/billing/checkout-session', {
    method: 'POST',
    body: JSON.stringify({ email, priceType }),
  });
}

/** Create a Stripe Customer Portal session and return the URL. */
export async function createPortalSession(customerId, email) {
  return billingFetch('/api/billing/portal-session', {
    method: 'POST',
    body: JSON.stringify({ customerId, email }),
  });
}

/** Fetch the current subscription status for a customer/email. */
export async function fetchSubscriptionStatus({ customerId, email }) {
  const params = new URLSearchParams();
  if (customerId) params.set('customerId', customerId);
  else if (email) params.set('email', email);
  return billingFetch(`/api/billing/subscription-status?${params.toString()}`);
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
