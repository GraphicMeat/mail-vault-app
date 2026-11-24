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

/** Admin routes: closed while ADMIN_KEY is unset or short; a constant-time compare otherwise. */
function adminAuthorized(provided, expected) {
  if (typeof expected !== 'string' || expected.length < 16) return false;
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { findCustomer, adminAuthorized, CUSTOMER_ID_REQUIRED };
