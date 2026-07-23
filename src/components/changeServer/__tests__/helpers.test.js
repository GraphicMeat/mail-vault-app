import { describe, it, expect } from 'vitest';
import { deriveSuggestion, classifyVerifyError, nextStepAfterVerify } from '../helpers.js';

describe('deriveSuggestion', () => {
  it('applies the suggestion when detected hosts differ from current', () => {
    expect(deriveSuggestion(
      { imapHost: 'old.imap.com', smtpHost: 'old.smtp.com' },
      { imapHost: 'new.imap.com', smtpHost: 'new.smtp.com' },
    )).toEqual({ apply: true, unchanged: false });
  });

  it('flags unchanged (no apply) when detected hosts equal current, case/whitespace-insensitive', () => {
    expect(deriveSuggestion(
      { imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' },
      { imapHost: ' IMAP.example.com ', smtpHost: 'SMTP.example.com' },
    )).toEqual({ apply: false, unchanged: true });
  });

  it('neither applies nor flags unchanged when detection failed (null)', () => {
    expect(deriveSuggestion(
      { imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' },
      null,
    )).toEqual({ apply: false, unchanged: false });
  });
});

describe('classifyVerifyError', () => {
  it('classifies IMAP: prefixed messages', () => {
    expect(classifyVerifyError('IMAP: connection refused')).toEqual({ leg: 'imap', text: 'connection refused' });
  });

  it('classifies SMTP: prefixed messages', () => {
    expect(classifyVerifyError('SMTP: auth failed')).toEqual({ leg: 'smtp', text: 'auth failed' });
  });

  it('classifies anything else as general', () => {
    expect(classifyVerifyError('This email on this server is already added')).toEqual({
      leg: 'general',
      text: 'This email on this server is already added',
    });
  });
});

describe('nextStepAfterVerify', () => {
  it('goes to step 3 when there are no local folders', () => {
    expect(nextStepAfterVerify([])).toBe(3);
  });

  it('goes to step 3 when folders exist but total count is 0', () => {
    expect(nextStepAfterVerify([{ mailbox: 'INBOX', localCount: 0 }])).toBe(3);
  });

  it('goes to step 2 when there is local mail to restore', () => {
    expect(nextStepAfterVerify([{ mailbox: 'INBOX', localCount: 42 }])).toBe(2);
  });
});
