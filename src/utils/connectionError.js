import { t } from '../i18n/index.js';
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

const RULES = () => ([
  {
    match: (s) => s.includes('authenticationfailed') || s.includes('invalid credentials')
      || s.includes('login failed') || (s.includes('auth') && s.includes('fail')),
    problemKey: 'errors.conn.problem.serverRejectedEmailAddressPassword',
    recoveryKey: 'errors.conn.recovery.checkBothTyposIfProvider',
  },
  {
    match: (s) => s.includes('oauth') || (s.includes('token') && (s.includes('expired') || s.includes('invalid'))),
    problemKey: 'errors.conn.problem.signProviderExpired',
    recoveryKey: 'errors.conn.recovery.signAgainReconnectAccount',
  },
  {
    match: (s) => s.includes('timed out') || s.includes('timeout'),
    problemKey: 'errors.conn.problem.serverDidAnswerTime',
    recoveryKey: 'errors.conn.recovery.checkHostPortThenTry',
  },
  {
    match: (s) => s.includes('dns') || s.includes('resolve') || s.includes('lookup')
      || s.includes('not known') || s.includes('nodename'),
    problemKey: 'errors.conn.problem.serverNameCouldFound',
    recoveryKey: 'errors.conn.recovery.checkSpellingImapHostUse',
  },
  {
    match: (s) => s.includes('refused') || s.includes('unreachable') || s.includes('reset by peer'),
    problemKey: 'errors.conn.problem.serverRefusedConnectionPort',
    recoveryKey: 'errors.conn.recovery.mostServersUse993Ssl',
  },
  {
    match: (s) => s.includes('certificate') || s.includes('tls') || s.includes('ssl')
      || s.includes('handshake'),
    problem: t('errors.conn.serverSSecurityCertificateCould'),
    recoveryKey: 'errors.conn.recovery.checkEncryptionSettingMatchesPort',
  },
  {
    match: (s) => s.includes('offline') || s.includes('network is down')
      || s.includes('no route to host'),
    problemKey: 'errors.conn.problem.computerOnline',
    recoveryKey: 'errors.conn.recovery.reconnectInternetTryAgain',
  },
]);

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
    return { message: t('errors.conn.couldReachMailServerCheck'), detail: null };
  }

  const lower = raw.toLowerCase();
  const rule = RULES().find(r => r.match(lower));
  if (rule) {
    return { message: `${t(rule.problemKey)} ${t(rule.recoveryKey)}`, detail: raw };
  }

  // Nothing matched. Still lead with what the user can do, and keep the raw
  // text as the detail rather than dropping information we cannot classify.
  return {
    message: t('errors.conn.couldConnectMailServerCheck'),
    detail: raw,
  };
}
