// The accounts error codes the engine answers with (`mobile.accounts.add` / `.test` replies and
// `mobile.sync.state` events), each to its translated message. Literal keys, so the catalog tests
// can see every one; an unknown code reads as the generic failure.
export const ERROR_KEYS = Object.freeze({
  AUTH_FAILED: 'mobile.error.AUTH_FAILED',
  HOST_UNREACHABLE: 'mobile.error.HOST_UNREACHABLE',
  TLS_FAILED: 'mobile.error.TLS_FAILED',
  TIMEOUT: 'mobile.error.TIMEOUT',
  DUPLICATE: 'mobile.error.DUPLICATE',
  INVALID: 'mobile.error.INVALID',
  INTERNAL: 'mobile.error.INTERNAL',
});

/** A code the UI knows, or `INTERNAL` for anything else (a transport failure, a new code). */
export function errorCodeOf(code) {
  return Object.hasOwn(ERROR_KEYS, code) ? code : 'INTERNAL';
}

export function errorKey(code) {
  return ERROR_KEYS[errorCodeOf(code)];
}
