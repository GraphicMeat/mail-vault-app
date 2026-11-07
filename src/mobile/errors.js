// The accounts error codes the engine answers with (`mobile.accounts.add` / `.test` replies and
// `mobile.sync.state` events, `mobile.oauth.finish` replies), each to its translated message.
// `HTTPS_REQUIRED`, `JMAP_NOT_FOUND` and `CONFIRM_HOST` come from the JMAP form only; the form
// shows `CONFIRM_HOST` as a question naming the host, the message is its fallback.
// `NO_BROWSER` and `SIGNIN_BUSY` are the page's own: the sign-in sheet could not open (the shell's
// `NO_APP`), or another sign-in is already running (oauth.js, or the shell's `BUSY` for the sheet). Literal keys, so the catalog tests
// can see every one; an unknown code reads as the generic failure.
export const ERROR_KEYS = Object.freeze({
  AUTH_FAILED: 'mobile.error.AUTH_FAILED',
  HOST_UNREACHABLE: 'mobile.error.HOST_UNREACHABLE',
  TLS_FAILED: 'mobile.error.TLS_FAILED',
  TIMEOUT: 'mobile.error.TIMEOUT',
  DUPLICATE: 'mobile.error.DUPLICATE',
  INVALID: 'mobile.error.INVALID',
  SMTP_FAILED: 'mobile.error.SMTP_FAILED',
  INTERNAL: 'mobile.error.INTERNAL',
  NEEDS_AUTH: 'mobile.error.NEEDS_AUTH',
  CANCELLED: 'mobile.error.CANCELLED',
  NO_BROWSER: 'mobile.error.NO_BROWSER',
  SIGNIN_BUSY: 'mobile.error.SIGNIN_BUSY',
  HTTPS_REQUIRED: 'mobile.error.HTTPS_REQUIRED',
  JMAP_NOT_FOUND: 'mobile.error.JMAP_NOT_FOUND',
  CONFIRM_HOST: 'mobile.error.CONFIRM_HOST',
});

/** A code the UI knows, or `INTERNAL` for anything else (a transport failure, a new code). */
export function errorCodeOf(code) {
  return Object.hasOwn(ERROR_KEYS, code) ? code : 'INTERNAL';
}

export function errorKey(code) {
  return ERROR_KEYS[errorCodeOf(code)];
}
