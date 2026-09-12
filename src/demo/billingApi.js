import { DemoUnsupportedError } from './backend.js';

const unsupported = action => { throw new DemoUnsupportedError(`billing:${action}`); };

export class BillingRateLimitError extends Error {
  constructor() { super('Billing is unavailable in the browser demo.'); this.name = 'BillingRateLimitError'; }
}

export function getBillingRateLimitedUntil() { return 0; }
export function isBillingRateLimited() { return false; }

// Premium is pre-unlocked for exploration. These functions deliberately do
// not call the hosted billing API, even though the desktop component imports
// the same service module.
export async function fetchPricing() { return null; }
export async function fetchSubscriptionStatus() {
  return { customerId: 'demo-customer', hasSubscription: true, premiumAccess: true, status: 'active', interval: 'year', demo: true };
}
export async function getClientInfo() { return { clientId: 'browser-demo', appVersion: '2.13.1-demo', platform: 'browser', osVersion: '', clientName: 'MailVault browser demo', simulated: true }; }
export async function createCheckoutSession() { return unsupported('checkout'); }
export async function createPortalSession() { return unsupported('portal'); }
export async function unregisterBillingClient() { return unsupported('unregister'); }
export async function openInBrowser() { return unsupported('external-browser'); }
