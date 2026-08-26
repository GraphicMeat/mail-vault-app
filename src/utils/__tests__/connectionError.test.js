import { describe, it, expect } from 'vitest';
import { describeConnectionError } from '../connectionError';

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
});
