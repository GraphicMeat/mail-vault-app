/**
 * The e2e harness's SMTP contract, asserted where it is cheap to assert.
 *
 * Two properties, both of which were silently wrong before the mock grew an
 * SMTP listener:
 *   - the seeded account's `smtpPort` pointed at the IMAP mock, so every send
 *     in every e2e died on the wire and a successful send was unreachable; and
 *   - nothing said which address a spec should use when it wants a send to
 *     FAIL, because failure was the only thing the harness could do.
 *
 * An e2e cycle on the runner is ~15 minutes. These run in milliseconds and fail
 * for the same reason.
 */

import { describe, it, expect } from 'vitest';
import {
  mockAccount,
  scenario,
  SEND_REFUSED_TO,
  SMTP_REFUSED_DOMAIN,
} from '../e2e/mockImap.js';

describe('the mock account fixture', () => {
  it('points smtpPort at the SMTP listener, not at the IMAP one', () => {
    const account = mockAccount({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'luke@mock.test',
      port: 51001,
      smtpPort: 51002,
    });

    expect(account.imapPort).toBe(51001);
    expect(account.smtpPort).toBe(51002);
    // The bug this replaces: one port for both, so `smtpHost:smtpPort` spoke
    // IMAP and the SMTP handshake could only ever fail.
    expect(account.smtpPort).not.toBe(account.imapPort);
  });

  it('leaves both halves plaintext on loopback', () => {
    const account = mockAccount({ id: 'x', email: 'luke@mock.test', port: 1, smtpPort: 2 });
    expect(account.imapHost).toBe('127.0.0.1');
    expect(account.smtpHost).toBe('127.0.0.1');
    expect(account.imapSecure).toBe(false);
    expect(account.smtpSecure).toBe(false);
  });
});

describe('asking the harness for a failing send', () => {
  it('gives every account a server that refuses the documented address', () => {
    const built = scenario({ owner: 'luke@mock.test', inbox: 3 });

    expect(built.smtp).toEqual({ refuse_recipient: `@${SMTP_REFUSED_DOMAIN}` });
    // The needle is a domain suffix, so any local part works — a spec can name
    // the failure after itself.
    expect(SEND_REFUSED_TO.endsWith(`@${SMTP_REFUSED_DOMAIN}`)).toBe(true);
  });

  it('refuses nothing else — a send to any other address is meant to succeed', () => {
    const { smtp } = scenario({ owner: 'luke@mock.test', inbox: 3 });
    const needle = smtp.refuse_recipient.toLowerCase();

    for (const address of ['partner@example.com', 'luke@mock.test', 'someone@example.com']) {
      expect(address.toLowerCase().includes(needle)).toBe(false);
    }
  });
});
