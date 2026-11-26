// @vitest-environment jsdom
/**
 * The Premium sign-in code is read out of the user's own mail and filled in for them. The mail
 * lands in Inbox or in Spam (a new sender often goes to Spam), so both are searched on the
 * server, for MailVault's own sign-in mail only, sent after the code was asked for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = {
  searchEmails: vi.fn(),
  fetchEmailLight: vi.fn(),
  messageCode: vi.fn(),
  graphListMessages: vi.fn(),
  graphGetMessage: vi.fn(),
};
vi.mock('../../api', () => api);

const { useMailStore } = await import('../../../stores/mailStore');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { findSigninCode, watchSigninCode, SIGNIN_SUBJECTS } = await import('../signinCodeWatch');

const SINCE = Date.parse('2026-11-26T09:46:00Z');
const at = (min) => new Date(SINCE + min * 60_000).toISOString();
const ACCOUNT = { id: 'a1', email: 'payer@mock.test' };
const TREE = [
  { path: 'INBOX', name: 'INBOX' },
  { path: '[Gmail]/Spam', name: 'Spam', specialUse: '\\Junk' },
];

function mailIn(byMailbox) {
  api.searchEmails.mockImplementation(async (_account, mailbox) => ({ emails: byMailbox[mailbox] || [], total: 0 }));
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  useMailStore.setState({ accounts: [ACCOUNT], activeAccountId: 'a1', mailboxes: TREE });
  useSettingsStore.setState({ aliases: {}, sendAsAddresses: {} });
  api.fetchEmailLight.mockImplementation(async (_a, uid) => ({ text: `Your sign-in code\n\n${uid === 7 ? '806375' : '111111'}\n` }));
  api.messageCode.mockImplementation(async (_subject, text) => {
    const m = /\b(\d{6})\b/.exec(text || '');
    return { code: m ? m[1] : null, needsBody: !m };
  });
});

describe('findSigninCode', () => {
  it('knows the sign-in subject in every language the mail is sent in', () => {
    expect(SIGNIN_SUBJECTS).toContain('Your MailVault sign-in code');
    expect(SIGNIN_SUBJECTS).toHaveLength(9);
  });

  it('reads the code from a mail that went to Spam', async () => {
    mailIn({ '[Gmail]/Spam': [{ uid: 7, subject: 'Your MailVault sign-in code', date: at(1) }] });
    expect(await findSigninCode({ email: 'payer@mock.test', since: SINCE })).toBe('806375');
    expect(api.searchEmails.mock.calls.map(c => c[1])).toEqual(['INBOX', '[Gmail]/Spam']);
    expect(api.fetchEmailLight).toHaveBeenCalledWith(ACCOUNT, 7, '[Gmail]/Spam', 'a1', expect.objectContaining({ background: true }));
  });

  it('finds Spam by name when the server marks no folder as junk', async () => {
    useMailStore.setState({ mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'INBOX.Junk', name: 'Junk' }] });
    mailIn({ 'INBOX.Junk': [{ uid: 7, subject: 'Your MailVault sign-in code', date: at(1) }] });
    expect(await findSigninCode({ email: 'payer@mock.test', since: SINCE })).toBe('806375');
  });

  it('takes the newest sign-in mail, and none sent before the code was asked for', async () => {
    mailIn({ INBOX: [
      { uid: 3, subject: 'Your MailVault sign-in code', date: at(-30) },
      { uid: 7, subject: 'Your MailVault sign-in code', date: at(2) },
      { uid: 5, subject: 'Your MailVault sign-in code', date: at(1) },
    ] });
    expect(await findSigninCode({ email: 'payer@mock.test', since: SINCE })).toBe('806375');
    expect(api.fetchEmailLight).toHaveBeenCalledTimes(1);
  });

  it('never fills a code from some other mail', async () => {
    mailIn({ INBOX: [{ uid: 7, subject: 'Your Acme verification code', date: at(1) }] });
    expect(await findSigninCode({ email: 'payer@mock.test', since: SINCE })).toBeNull();
    expect(api.fetchEmailLight).not.toHaveBeenCalled();
  });

  it('looks in the account an alias belongs to', async () => {
    useSettingsStore.setState({ aliases: { a1: [{ address: 'shop@mock.test' }] } });
    mailIn({ INBOX: [{ uid: 7, subject: 'Dein MailVault-Anmeldecode', date: at(1) }] });
    expect(await findSigninCode({ email: 'Shop@mock.test', since: SINCE })).toBe('806375');
  });

  it('answers null for an address no account here owns, and for a server error', async () => {
    expect(await findSigninCode({ email: 'nobody@mock.test', since: SINCE })).toBeNull();
    api.searchEmails.mockRejectedValue(new Error('offline'));
    expect(await findSigninCode({ email: 'payer@mock.test', since: SINCE })).toBeNull();
  });

  it('reads Inbox and Junk Email of an Outlook account signed in with Microsoft', async () => {
    const graph = { id: 'g1', email: 'payer@mock.test', authType: 'oauth2', oauth2Transport: 'graph' };
    useMailStore.setState({ accounts: [graph], activeAccountId: 'g1', mailboxes: [] });
    api.graphListMessages.mockImplementation(async (_a, folder) => (folder === 'junkemail'
      ? { headers: [{ subject: 'Your MailVault sign-in code', date: at(1) }], graphMessageIds: ['m-1'] }
      : { headers: [], graphMessageIds: [] }));
    api.graphGetMessage.mockResolvedValue({ id: 'm-1', subject: 'Your MailVault sign-in code', body: { contentType: 'text', content: 'code 806375' } });
    expect(await findSigninCode({ email: 'payer@mock.test', since: SINCE })).toBe('806375');
    expect(api.searchEmails).not.toHaveBeenCalled();
    expect(api.graphGetMessage).toHaveBeenCalledWith(graph, 'm-1');
  });
});

describe('watchSigninCode', () => {
  it('keeps looking until the code arrives, then hands it over once', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      api.searchEmails.mockImplementation(async (_a, mailbox) => ({
        emails: mailbox === 'INBOX' && ++n > 2 ? [{ uid: 7, subject: 'Your MailVault sign-in code', date: at(1) }] : [],
      }));
      const onCode = vi.fn();
      const stop = watchSigninCode({ email: 'payer@mock.test', since: SINCE, onCode, now: () => SINCE });
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect(onCode).toHaveBeenCalledTimes(1);
      expect(onCode).toHaveBeenCalledWith('806375');
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when told to, and gives up when the code has expired', async () => {
    vi.useFakeTimers();
    try {
      mailIn({});
      let clock = SINCE;
      const stop = watchSigninCode({ email: 'payer@mock.test', since: SINCE, onCode: vi.fn(), now: () => clock });
      await vi.advanceTimersByTimeAsync(10_000);
      const asked = api.searchEmails.mock.calls.length;
      expect(asked).toBeGreaterThan(0);
      clock = SINCE + 11 * 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      const atExpiry = api.searchEmails.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.searchEmails.mock.calls.length).toBe(atExpiry);
      stop();

      const stop2 = watchSigninCode({ email: 'payer@mock.test', since: SINCE, onCode: vi.fn(), now: () => SINCE });
      stop2();
      const before = api.searchEmails.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.searchEmails.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
