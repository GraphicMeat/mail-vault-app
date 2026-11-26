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
// release had the code sign-in screen: 2.25.0 signs in by address alone. Address sign-in
// stays open for apps at or below this version through the end of spring 2027 (31 May,
// UTC); from 2.25.1 the app signs in with the code. Delete this and its call in the
// subscription-status route after LEGACY_EMAIL_SIGNIN_UNTIL (the REMINDER test goes red
// then); keep legacyEmailSignInExpired and APP_UPDATE_REQUIRED.
const LAST_EMAIL_SIGNIN_VERSION = '2.25.0';
const LEGACY_EMAIL_SIGNIN_UNTIL = Date.UTC(2027, 5, 1);

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
function legacyEmailSignInOpen({ appVersion, register, now }) {
  if (register !== '1' || !(now < LEGACY_EMAIL_SIGNIN_UNTIL)) return false;
  const app = parseVersion(appVersion);
  return !!(app && atOrBelowLast(app));
}

/**
 * A computer signed in by address on 2.25.0 keeps a device seat but has no Stripe id. Once it
 * updates (newer than LAST_EMAIL_SIGNIN_VERSION) it stays signed in through that seat: the
 * status call names the address and this device's id, and is answered (legacyView) only when
 * the device already holds a live seat. It never takes a new seat, so it reaches no more than
 * the address path did. Ends with the address path.
 */
function seatRefreshOpen({ appVersion, now }) {
  if (!(now < LEGACY_EMAIL_SIGNIN_UNTIL)) return false;
  const app = parseVersion(appVersion);
  return !!(app && !atOrBelowLast(app));
}

const SEAT_SQL = 'SELECT c.* FROM billing_customers c JOIN billing_clients k ON k.billing_customer_id = c.id '
  + 'WHERE c.email = ? AND k.client_id = ? AND k.revoked_at IS NULL LIMIT 1';

/** The customer whose live seat this device holds, found by address + device id, or undefined. */
async function findSeatHolder(db, email, clientId) {
  if (typeof email !== 'string' || !email.trim() || typeof clientId !== 'string' || !clientId) return undefined;
  const [rows] = await db.execute(SEAT_SQL, [email.trim().toLowerCase(), clientId]);
  return rows[0];
}

/**
 * From LEGACY_EMAIL_SIGNIN_UNTIL an old app's address sign-in is shut by the clock alone,
 * and the app is told to update (it has no screen for the code). Stays after the address
 * path itself is deleted; the REMINDER test in billing-identity.test.js says when.
 */
function legacyEmailSignInExpired({ appVersion, now }) {
  const app = parseVersion(appVersion);
  return !!(app && atOrBelowLast(app) && !(now < LEGACY_EMAIL_SIGNIN_UNTIL));
}

const APP_UPDATE_REQUIRED = {
  error: 'app_update_required',
  message: `This version of MailVault can no longer sign in to Premium. Update MailVault to a version newer than ${LAST_EMAIL_SIGNIN_VERSION}, then sign in with the code we email you.`,
};

/** The customer row for an address, only behind legacyEmailSignInOpen. */
async function findCustomerByLegacyEmail(db, email) {
  if (typeof email !== 'string' || !email.trim()) return undefined;
  const [rows] = await db.execute('SELECT * FROM billing_customers WHERE email = ?', [email.trim().toLowerCase()]);
  return rows[0];
}

/**
 * A status answer for an address sign-in: no Stripe id (it opens the billing portal and
 * removes devices) and nobody's device list. 2.25.0 keeps Premium on clientAccessGranted.
 */
function legacyView(body) {
  const { replacedClient: _replaced, ...rest } = body;
  return { ...rest, customerId: null, activeClients: [] };
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
  findCustomer, findCustomerByLegacyEmail, findSeatHolder, seatRefreshOpen, legacyEmailSignInOpen, legacyEmailSignInExpired, legacyView, LAST_EMAIL_SIGNIN_VERSION, LEGACY_EMAIL_SIGNIN_UNTIL,
  adminAuthorized, CUSTOMER_ID_REQUIRED, APP_UPDATE_REQUIRED,
};
