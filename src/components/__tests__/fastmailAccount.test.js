// @vitest-environment jsdom
//
// AccountModal reaches mailStore through accountStore, and mailStore registers
// window listeners at module scope — the file cannot even be imported under the
// default node environment. Every sibling here carries the same docblock;
// vitest.config.js's environmentMatchGlobs does not cover it on its own.

import { describe, it, expect } from 'vitest';
import { isFastmailAccount } from '../AccountModal.jsx';

// Which accounts get "Login Address" instead of "Email Address" in the two
// account forms. The reporter's own account is the third case: a custom domain
// signed in against Fastmail's IMAP host, where the address says nothing.
describe('isFastmailAccount', () => {
  it('matches a fastmail.com login', () => {
    expect(isFastmailAccount({ email: 'butcher@fastmail.com' })).toBe(true);
  });

  it('matches the fastmail.fm domain the provider config also claims', () => {
    expect(isFastmailAccount({ email: 'butcher@fastmail.fm' })).toBe(true);
  });

  it('matches a custom-domain login on the Fastmail IMAP host', () => {
    expect(isFastmailAccount({ email: 'hello@graphicmeat.com', imapHost: 'imap.fastmail.com' }))
      .toBe(true);
  });

  it('matches the apex host as well as a subdomain of it', () => {
    expect(isFastmailAccount({ email: 'a@b.test', imapHost: 'fastmail.com' })).toBe(true);
  });

  it('does not match a host that merely ends in the same letters', () => {
    // `notfastmail.com` is a different company; an unanchored match would rename
    // its login field on the strength of a substring.
    expect(isFastmailAccount({ email: 'a@b.test', imapHost: 'imap.notfastmail.com' })).toBe(false);
  });

  it('leaves other providers alone', () => {
    expect(isFastmailAccount({ email: 'someone@gmail.com', imapHost: 'imap.gmail.com' })).toBe(false);
    expect(isFastmailAccount({ email: 'someone@mock.test', imapHost: '127.0.0.1' })).toBe(false);
  });

  it('says no rather than throwing on a missing or empty account', () => {
    expect(isFastmailAccount()).toBe(false);
    expect(isFastmailAccount({})).toBe(false);
    expect(isFastmailAccount({ email: '', imapHost: '' })).toBe(false);
  });
});
