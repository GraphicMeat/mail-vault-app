// @vitest-environment node
// The pure parts of the phone's status line and account issues (src/mobile/issues/): what the
// line under the title says, and which accounts have a problem the user can fix.
import { describe, it, expect } from 'vitest';
import { accountIssues, issueKey, dismissedFor } from '../issues/accountIssues.js';
import { statusLine, agoParts } from '../issues/statusLine.js';

const ok = { id: 'a0', email: 'ok@example.test' };
const lapsed = { id: 'a1', email: 'ada@gmail.test', needsAuth: true, oauth: true };
const lost = { id: 'a2', email: 'bo@example.test', needsAuth: true, oauth: false };
const refused = { id: 'a3', email: 'cy@example.test', authRefused: true };

describe('accountIssues', () => {
  it('lists one issue per account that needs the user: a lapsed sign-in, a lost password, a refusal', () => {
    expect(accountIssues([ok, lapsed, lost, refused])).toEqual([
      { accountId: 'a1', email: 'ada@gmail.test', kind: 'signIn' },
      { accountId: 'a2', email: 'bo@example.test', kind: 'passwordLost' },
      { accountId: 'a3', email: 'cy@example.test', kind: 'refused' },
    ]);
  });

  it('a parked account is a sign-in issue even when the server also refused it; healthy accounts are none', () => {
    expect(accountIssues([ok])).toEqual([]);
    expect(accountIssues([{ ...lapsed, authRefused: true }]).map((i) => i.kind)).toEqual(['signIn']);
    expect(accountIssues(undefined)).toEqual([]);
  });

  it('the key names the set of issues, not the order or the account objects', () => {
    const a = accountIssues([lapsed, refused]);
    const b = accountIssues([{ ...refused, extra: 1 }, lapsed]);
    expect(issueKey(a)).toBe(issueKey(b));
    expect(issueKey(a)).not.toBe(issueKey(accountIssues([lapsed])));
    expect(issueKey(accountIssues([lapsed]))).not.toBe(issueKey(accountIssues([{ ...lapsed, needsAuth: false, authRefused: true }])));
    expect(issueKey([])).toBe('');
  });

  it('a dismissal holds only while the set is the one that was dismissed', () => {
    const issues = accountIssues([lapsed, refused]);
    expect(dismissedFor(issues, issueKey(issues))).toBe(true);
    expect(dismissedFor(issues, issueKey(accountIssues([lapsed])))).toBe(false);
    expect(dismissedFor(issues, null)).toBe(false);
    expect(dismissedFor([], '')).toBe(false);
  });
});

describe('statusLine', () => {
  const NOW = 1_000_000_000;
  it('says nothing before any account has reported', () => {
    expect(statusLine(null, { now: NOW })).toBeNull();
    expect(statusLine({ state: 'idle', code: null, at: 0 }, { now: NOW })).toBeNull();
  });

  it('syncing names how many accounts are being checked, one account just "mail"', () => {
    expect(statusLine({ state: 'syncing', at: NOW }, { now: NOW, accountCount: 1 })).toEqual({ kind: 'syncing', key: 'mobile.status.checking', params: {} });
    expect(statusLine({ state: 'syncing', at: NOW }, { now: NOW, accountCount: 18 })).toEqual({ kind: 'syncing', key: 'mobile.status.checkingMany', params: { accounts: 18 } });
  });

  it('idle says when it last updated, in minutes, hours and days', () => {
    const idle = (ago) => statusLine({ state: 'idle', code: null, at: NOW - ago }, { now: NOW });
    expect(idle(10_000)).toEqual({ kind: 'idle', key: 'mobile.status.updatedNow', params: {} });
    expect(idle(5 * 60_000)).toEqual({ kind: 'idle', key: 'mobile.status.updatedMinutes', params: { minutes: 5 } });
    expect(idle(3 * 3_600_000)).toEqual({ kind: 'idle', key: 'mobile.status.updatedHours', params: { hours: 3 } });
    expect(idle(2 * 86_400_000)).toEqual({ kind: 'idle', key: 'mobile.status.updatedDays', params: { days: 2 } });
  });

  it('an error is one line with a retry, whatever the code', () => {
    expect(statusLine({ state: 'error', code: 'NETWORK', at: NOW }, { now: NOW })).toEqual({ kind: 'error', key: 'mobile.status.failed', params: {} });
  });

  it('agoParts never goes below just now or into the future', () => {
    expect(agoParts(NOW + 5_000, NOW)).toEqual({ key: 'mobile.status.updatedNow', params: {} });
    expect(agoParts(NOW - 59_000, NOW).key).toBe('mobile.status.updatedNow');
    expect(agoParts(NOW - 60_000, NOW)).toEqual({ key: 'mobile.status.updatedMinutes', params: { minutes: 1 } });
  });
});
