'use strict';
// Who a billing request is about, and whether an admin request may proceed.
//
// A billing customer is named only by the Stripe customer id, which the app gets from a
// mailed sign-in code (POST /api/billing/signin/verify), a checkout activation token, or a
// phone store purchase. An email address alone is never enough: anyone can type one, and it
// would hand them the owner's Premium, device list and billing portal.

const crypto = require('crypto');

const CUSTOMER_ID_REQUIRED = {
  error: 'customer_id_required',
  message: 'Sign in with the code we email you. If this keeps happening, update MailVault.',
};

/** The customer row for `customerId`, or undefined. Never looks a customer up by email. */
async function findCustomer(db, customerId) {
  if (typeof customerId !== 'string' || !customerId) return undefined;
  const [rows] = await db.execute('SELECT * FROM billing_customers WHERE stripe_customer_id = ?', [customerId]);
  return rows[0];
}

// Temporary exception. The server required the customer id (11-24) before any desktop
// release had the code sign-in screen: 2.25.0 signs in by address alone and has nothing to
// update to, so a new payer could never turn Premium on. Address sign-in stays open for
// apps at or below this version while the latest PUBLISHED release is still at or below
// it; publishing the next release closes it with no deploy. Delete this and its call in
// the subscription-status route once that release is out.
const LAST_EMAIL_SIGNIN_VERSION = '2.25.0';

function parseVersion(v) {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atOrBelowLast(v) {
  const last = parseVersion(LAST_EMAIL_SIGNIN_VERSION);
  for (let i = 0; i < 3; i++) if (v[i] !== last[i]) return v[i] < last[i];
  return true;
}

/** Whether a status call may name its customer by address (see LAST_EMAIL_SIGNIN_VERSION). */
function legacyEmailSignInOpen({ appVersion, latestVersion, register }) {
  if (register !== '1') return false;
  const app = parseVersion(appVersion);
  const latest = parseVersion(latestVersion);
  return !!(app && latest && atOrBelowLast(app) && atOrBelowLast(latest));
}

/** The customer row for an address, only behind legacyEmailSignInOpen. */
async function findCustomerByLegacyEmail(db, email) {
  if (typeof email !== 'string' || !email.trim()) return undefined;
  const [rows] = await db.execute('SELECT * FROM billing_customers WHERE email = ?', [email.trim().toLowerCase()]);
  return rows[0];
}

/** Admin routes: closed while ADMIN_KEY is unset or short; a constant-time compare otherwise. */
function adminAuthorized(provided, expected) {
  if (typeof expected !== 'string' || expected.length < 16) return false;
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  findCustomer, findCustomerByLegacyEmail, legacyEmailSignInOpen, LAST_EMAIL_SIGNIN_VERSION,
  adminAuthorized, CUSTOMER_ID_REQUIRED,
};
