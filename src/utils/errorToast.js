// The error Toast's severity is derived, not stored directly: `errorType`
// only applies if `errorTypeFor` still names the current `error` message —
// set together by whoever produced it (see EmailList.jsx's delete_everywhere
// outcome toast). Any of the plain `setState({ error })` call sites elsewhere
// (messageMutations.js, loadEmails.js, activateAccount.js, selectEmail.js)
// leave `errorTypeFor` pointing at whatever message came before, so their
// new message never matches it and this falls back to the default
// error-styled, 5s toast automatically — no coordination required from
// those callers, now or in the future.
export function resolveErrorToastProps({ error, errorType, errorTypeFor }) {
  const type = errorTypeFor === error ? errorType : 'error';
  return { type, duration: type === 'warning' ? 8000 : 5000 };
}
