// Turns a backend connection failure into something a person can act on.
//
// The Rust side returns strings like "Connection test failed: AUTHENTICATIONFAILED
// Invalid credentials (Failure)" or "Connection test timed out for me@x.com",
// and the account form used to render whichever one arrived, verbatim, as the
// whole message. That is the first thing a new user sees when setup fails, and
// it names neither the problem in their words nor anything they can do next.
//
// The SMTP path already does this in Rust (`friendly_smtp_error` in
// src-tauri/src/smtp.rs). This is the same idea for everything that reaches
// the account form, done where it can ship without a rebuild.
//
// Order matters: auth is checked before the generic network branches because
// an IMAP refusal often carries both a status word and a socket error.

const RULES = [
  {
    match: (s) => s.includes('authenticationfailed') || s.includes('invalid credentials')
      || s.includes('login failed') || (s.includes('auth') && s.includes('fail')),
    problem: 'The server rejected that email address and password.',
    recovery: 'Check both for typos. If your provider requires an app password, a normal account password will be refused here.',
  },
  {
    match: (s) => s.includes('oauth') || (s.includes('token') && (s.includes('expired') || s.includes('invalid'))),
    problem: 'The sign-in with your provider expired.',
    recovery: 'Sign in again to reconnect this account.',
  },
  {
    match: (s) => s.includes('timed out') || s.includes('timeout'),
    problem: 'The server did not answer in time.',
    recovery: 'Check the host and port, then try again. A firewall or VPN can also hold the connection open until it expires.',
  },
  {
    match: (s) => s.includes('dns') || s.includes('resolve') || s.includes('lookup')
      || s.includes('not known') || s.includes('nodename'),
    problem: 'That server name could not be found.',
    recovery: 'Check the spelling of the IMAP host, or use Auto-detect to fill it in.',
  },
  {
    match: (s) => s.includes('refused') || s.includes('unreachable') || s.includes('reset by peer'),
    problem: 'The server refused the connection on that port.',
    recovery: 'Most servers use 993 for SSL/TLS and 143 for STARTTLS. Check the port and the encryption setting.',
  },
  {
    match: (s) => s.includes('certificate') || s.includes('tls') || s.includes('ssl')
      || s.includes('handshake'),
    problem: "The server's security certificate could not be verified.",
    recovery: 'Check that the encryption setting matches the port. Self-signed certificates are only accepted for local bridges.',
  },
  {
    match: (s) => s.includes('offline') || s.includes('network is down')
      || s.includes('no route to host'),
    problem: 'This computer is not online.',
    recovery: 'Reconnect to the internet and try again.',
  },
];

/**
 * @param {unknown} err  whatever the Tauri command or store rejected with
 * @returns {{ message: string, detail: string|null }}
 *   `message` is what to show. `detail` is the raw backend string, worth
 *   showing underneath when it adds anything the message does not — it is
 *   what someone pastes into a bug report.
 */
export function describeConnectionError(err) {
  const raw = (typeof err === 'string' ? err : err?.message || String(err ?? '')).trim();
  if (!raw) {
    return { message: 'Could not reach the mail server. Check the settings above and try again.', detail: null };
  }

  const lower = raw.toLowerCase();
  const rule = RULES.find(r => r.match(lower));
  if (rule) {
    return { message: `${rule.problem} ${rule.recovery}`, detail: raw };
  }

  // Nothing matched. Still lead with what the user can do, and keep the raw
  // text as the detail rather than dropping information we cannot classify.
  return {
    message: 'Could not connect to the mail server. Check the host, port and encryption above, then try again.',
    detail: raw,
  };
}
