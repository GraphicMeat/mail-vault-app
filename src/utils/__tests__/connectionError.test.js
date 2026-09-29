import { describe, it, expect } from 'vitest';
import { describeConnectionError, connectionFailureStatus } from '../connectionError';
import { t } from '../../i18n';

// The rule this file protects: the raw backend string is never the whole
// message. It may ride along as `detail`, but `message` always names a
// problem in the user's words and something they can do about it.

const RAW = {
  auth: 'Connection test failed: AUTHENTICATIONFAILED Invalid credentials (Failure)',
  timeout: 'Connection test timed out for me@example.com',
  dns: 'Connection test failed: failed to lookup address information: nodename nor servname provided',
  refused: 'Connection test failed: Connection refused (os error 61)',
  tls: 'Connection test failed: invalid peer certificate: UnknownIssuer',
  oauth: 'OAuth2 token expired for this account',
  weird: 'Connection test failed: EPROTO 0A000102',
};

describe('describeConnectionError', () => {
  it('never returns the raw backend string as the message', () => {
    for (const raw of Object.values(RAW)) {
      const { message } = describeConnectionError(raw);
      expect(message).not.toBe(raw);
      expect(message).not.toMatch(/AUTHENTICATIONFAILED|os error|EPROTO|UnknownIssuer/);
    }
  });

  it('keeps the raw string as a detail so it can still be reported', () => {
    expect(describeConnectionError(RAW.auth).detail).toBe(RAW.auth);
    expect(describeConnectionError(RAW.weird).detail).toBe(RAW.weird);
  });

  it('names a recovery in every message', () => {
    for (const raw of Object.values(RAW)) {
      const { message } = describeConnectionError(raw);
      // Every branch ends in something the user can do next.
      expect(message).toMatch(/check|try again|sign in|enter|retry|reconnect/i);
    }
  });

  it('routes an authentication failure to the app-password hint', () => {
    expect(describeConnectionError(RAW.auth).message).toMatch(/app password/i);
  });

  it('classifies a refused connection as a port problem, not a password one', () => {
    const { message } = describeConnectionError(RAW.refused);
    expect(message).toMatch(/port/i);
    expect(message).not.toMatch(/password/i);
  });

  it('reads the message off an Error as well as a string', () => {
    expect(describeConnectionError(new Error(RAW.timeout)).message).toMatch(/did not answer in time/);
  });

  it('still says something useful with nothing to go on', () => {
    for (const empty of [undefined, null, '', '   ']) {
      const { message, detail } = describeConnectionError(empty);
      expect(message).toMatch(/try again/i);
      expect(detail).toBeNull();
    }
  });

  // The TLS rule named its text `problem:` instead of `problemKey:`, so a
  // certificate failure read "undefined Check that the encryption setting...".
  it('words a certificate failure instead of printing undefined', () => {
    const { message } = describeConnectionError(RAW.tls);
    expect(message.startsWith(t('errors.conn.serverSSecurityCertificateCould'))).toBe(true);
    expect(message).not.toMatch(/undefined/);
  });
});

// The daemon classifies (mailvault_core::net::classify_connection_error) and
// the error carries its code; the app only maps the code to a message.
describe('describeConnectionError with the daemon\'s errorCode', () => {
  const failed = (errorCode, extra = {}) => Object.assign(
    new Error('TCP connect to imap.example.test:993 failed: operation timed out'),
    { errorCode, host: 'imap.example.test', port: 993, ...extra },
  );

  it('names the blocked host and port, so the user can tell IT what to open', () => {
    const { message, detail } = describeConnectionError(failed('blocked_or_timeout'));
    expect(message).toContain('imap.example.test');
    expect(message).toContain('993');
    expect(message).toMatch(/firewall|VPN/);
    expect(detail).toMatch(/TCP connect/);
  });

  it('still reads when a blocked port comes without a host', () => {
    const { message } = describeConnectionError(failed('blocked_or_timeout', { host: null, port: null }));
    expect(message).not.toMatch(/\{\{|null|undefined/);
  });

  it('tells a throttled user to wait and close other mail apps', () => {
    const { message } = describeConnectionError(failed('throttled'));
    expect(message).toBe(`${t('errors.conn.problem.providerThrottling')} ${t('errors.conn.recovery.waitCloseOtherMailApps')}`);
  });

  it('trusts the code over the text', () => {
    // The raw text says "timed out"; the daemon knew the name did not resolve.
    const { message } = describeConnectionError(failed('dns'));
    expect(message.startsWith(t('errors.conn.problem.serverNameCouldFound'))).toBe(true);
  });

  it('gives every code a message of its own', () => {
    for (const code of ['dns', 'refused', 'blocked_or_timeout', 'tls', 'auth', 'throttled', 'offline']) {
      const { message } = describeConnectionError(failed(code));
      expect(message, code).not.toBe(t('errors.conn.couldConnectMailServerCheck'));
      expect(message, code).not.toMatch(/undefined|\{\{/);
    }
  });

  it('falls back to the text rules for "other"', () => {
    const err = Object.assign(new Error(RAW.refused), { errorCode: 'other' });
    expect(describeConnectionError(err).message).toMatch(/port/i);
  });
});

describe('connectionFailureStatus (the sidebar notice)', () => {
  const account = { imapHost: 'imap.example.test', imapPort: 993 };

  it('names the host and port of a blocked connection', () => {
    const status = connectionFailureStatus('blocked_or_timeout', account);
    expect(status.key).toBe('sidebar.conn.blocked');
    expect(t(status.key, status.params)).toContain('imap.example.test');
    expect(t(status.key, status.params)).toContain('993');
  });

  it('defaults the port to 993 when the account leaves it out', () => {
    const status = connectionFailureStatus('blocked_or_timeout', { imapHost: 'imap.example.test' });
    expect(status.params.port).toBe(993);
  });

  it('has a host-less wording when the account has no IMAP host', () => {
    expect(connectionFailureStatus('blocked_or_timeout', {}).key).toBe('sidebar.conn.blockedNoHost');
  });

  it('maps every other code to its own notice', () => {
    expect(connectionFailureStatus('dns', account).key).toBe('sidebar.conn.dns');
    expect(connectionFailureStatus('refused', account).key).toBe('sidebar.conn.refused');
    expect(connectionFailureStatus('tls', account).key).toBe('sidebar.conn.tls');
    expect(connectionFailureStatus('auth', account).key).toBe('sidebar.conn.auth');
    expect(connectionFailureStatus('throttled', account).key).toBe('sidebar.conn.throttled');
  });

  it('leaves the generic notice to the caller for "other" and no code', () => {
    expect(connectionFailureStatus('other', account)).toBeNull();
    expect(connectionFailureStatus(null, account)).toBeNull();
    expect(connectionFailureStatus(undefined, account)).toBeNull();
  });
});
