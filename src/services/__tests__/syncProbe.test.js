// Copy to src/services/__tests__/syncProbe.test.js after native GREEN.
// The native oracle and core parity suite own probe policy expectations.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  send: vi.fn(), legacyStatus: vi.fn(), legacyMeta: vi.fn(),
}));
vi.mock('../transport', () => ({ send: (...args) => bridge.send(...args) }));
vi.mock('../api', () => ({ checkMailboxStatus: (...args) => bridge.legacyStatus(...args) }));
vi.mock('../db', () => ({ getEmailHeadersMeta: (...args) => bridge.legacyMeta(...args) }));

const { mailboxIsUnchanged, markVerified, invalidate } = await import('../syncProbe.js');
const account = { id: 'ignored-by-native-source', email: 'a@mock.test' };
let serial = 0;
const nextId = () => `adapter-${++serial}`;
const settled = () => ({ unchanged: true, reason: 'modseq-match', verificationRef: 'proof-1' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  bridge.send.mockReset();
  bridge.legacyStatus.mockReset();
  bridge.legacyMeta.mockReset();
  bridge.legacyStatus.mockImplementation(() => { throw new Error('legacy IMAP status used'); });
  bridge.legacyMeta.mockImplementation(() => { throw new Error('legacy cache policy used'); });
});

describe('native sync probe adapter', () => {
  it('sends a source-id check and returns its native proof without legacy reads', async () => {
    const id = nextId();
    bridge.send.mockResolvedValue(settled());
    const result = await mailboxIsUnchanged(account, id, 'INBOX');
    expect(bridge.send.mock.calls.length, 'native sync.probe check was not sent').toBe(1);
    expect(result).toEqual(settled());
    expect(bridge.send).toHaveBeenCalledWith('sync.probe', {
      op: 'check', accountId: id, mailbox: 'INBOX',
    });
    expect(bridge.legacyMeta).not.toHaveBeenCalled();
    expect(bridge.legacyStatus).not.toHaveBeenCalled();
  });

  it('checks twice without auto marking and sends proof or ticket evidence explicitly', async () => {
    const id = nextId();
    bridge.send.mockImplementation(async (_method, params) =>
      params.op === 'check' ? settled() : { marked: true });
    expect(await mailboxIsUnchanged(account, id, 'INBOX')).toEqual(settled());
    expect(await mailboxIsUnchanged(account, id, 'INBOX')).toEqual(settled());
    expect(bridge.send.mock.calls.filter(([, params]) => params.op === 'check')).toHaveLength(2);
    await expect(markVerified(id, 'INBOX', { verificationRef: 'proof-1' }))
      .resolves.toEqual({ marked: true });
    await expect(markVerified(id, 'INBOX', { ticket: 7 }))
      .resolves.toEqual({ marked: true });
    expect(bridge.send.mock.calls.slice(2)).toEqual([
      ['sync.probe', { op: 'mark', accountId: id, mailbox: 'INBOX', verificationRef: 'proof-1' }],
      ['sync.probe', { op: 'mark', accountId: id, mailbox: 'INBOX', ticket: 7 }],
    ]);
  });

  it('never constructs a mark request with two proof sources', async () => {
    const id = nextId();
    await expect(markVerified(id, 'INBOX', { verificationRef: 'proof-1', ticket: 7 }))
      .resolves.toEqual({ marked: false });
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it('orders an account mutation before its next check while another account proceeds', async () => {
    const a = nextId();
    const b = nextId();
    const held = deferred();
    bridge.send.mockImplementation((_method, params) =>
      params.op === 'invalidate' && params.accountId === a
        ? held.promise : Promise.resolve(settled()));
    const invalidating = invalidate(a, 'INBOX');
    const checkA = mailboxIsUnchanged(account, a, 'INBOX');
    expect(bridge.legacyMeta.mock.calls.length,
      'legacy metadata read started before native invalidation settled').toBe(0);
    expect(await mailboxIsUnchanged(account, b, 'INBOX')).toEqual(settled());
    expect(bridge.send.mock.calls.some(([, params]) =>
      params.op === 'check' && params.accountId === a)).toBe(false);
    held.resolve({ invalidated: true });
    await invalidating;
    expect(await checkA).toEqual(settled());
    expect(bridge.send.mock.calls.map(([, params]) => [params.accountId, params.op])).toEqual([
      [a, 'invalidate'], [b, 'check'], [a, 'check'],
    ]);
  });

  it('keeps mark and invalidate in issue order for the same account', async () => {
    const id = nextId();
    bridge.send.mockResolvedValue({ marked: true, invalidated: true });
    const mark = markVerified(id, 'INBOX', { verificationRef: 'proof-2' });
    const forget = invalidate(id, 'INBOX');
    await Promise.all([mark, forget]);
    expect(bridge.send.mock.calls.map(([, params]) => params.op)).toEqual(['mark', 'invalidate']);
  });

  it('returns a conservative check after a failed mutation and recovers the chain', async () => {
    const id = nextId();
    let failInvalidation = true;
    bridge.send.mockImplementation(async (_method, params) => {
      if (params.op === 'invalidate') {
        if (failInvalidation) throw new Error('errors.daemonUnavailable');
        return { invalidated: true };
      }
      return settled();
    });
    await expect(invalidate(id, 'INBOX')).resolves.toEqual({ invalidated: false });
    const uncertain = await mailboxIsUnchanged(account, id, 'INBOX');
    expect(uncertain).toEqual({ unchanged: false, reason: 'probe-failed' });
    expect(bridge.send.mock.calls.filter(([, params]) => params.op === 'check')).toHaveLength(0);
    failInvalidation = false;
    await invalidate(id, 'INBOX');
    expect(await mailboxIsUnchanged(account, id, 'INBOX')).toEqual(settled());
  });

  it('handles a failed mark and requires a successful invalidate before trusting checks', async () => {
    const id = nextId();
    bridge.send.mockImplementation(async (_method, params) => {
      if (params.op === 'mark') throw new Error('errors.daemonUnavailable');
      return params.op === 'invalidate' ? { invalidated: true } : settled();
    });
    await expect(markVerified(id, 'INBOX', { verificationRef: 'proof-3' }))
      .resolves.toEqual({ marked: false });
    expect(await mailboxIsUnchanged(account, id, 'INBOX'))
      .toEqual({ unchanged: false, reason: 'probe-failed' });
    expect(bridge.send.mock.calls.filter(([, params]) => params.op === 'check')).toHaveLength(0);
    await invalidate(id, 'INBOX');
    expect(await mailboxIsUnchanged(account, id, 'INBOX')).toEqual(settled());
  });

  it('failed INBOX invalidation requires whole-account recovery before Sent can restore trust', async () => {
    const id = nextId();
    let invalidations = 0;
    bridge.send.mockImplementation(async (_method, params) => {
      if (params.op === 'invalidate' && invalidations++ === 0) {
        throw new Error('errors.daemonUnavailable');
      }
      return params.op === 'invalidate' ? { invalidated: true } : settled();
    });

    await expect(invalidate(id, 'INBOX')).resolves.toEqual({ invalidated: false });
    expect(await mailboxIsUnchanged(account, id, 'INBOX'))
      .toEqual({ unchanged: false, reason: 'probe-failed' });
    await expect(invalidate(id, 'Sent')).resolves.toEqual({ invalidated: true });

    const sentRecovery = bridge.send.mock.calls
      .filter(([, params]) => params.op === 'invalidate')[1][1];
    expect(sentRecovery, 'account-wide uncertainty needs a whole-account native invalidation')
      .toEqual({ op: 'invalidate', accountId: id });
    expect(await mailboxIsUnchanged(account, id, 'INBOX')).toEqual(settled());
  });

  it('late expired invalidation cannot clear a later failure', async () => {
    vi.useFakeTimers();
    try {
      const id = nextId();
      const firstNative = deferred();
      let invalidations = 0;
      bridge.send.mockImplementation((_method, params) => {
        if (params.op === 'invalidate') {
          invalidations += 1;
          return invalidations === 1
            ? firstNative.promise : Promise.reject(new Error('errors.daemonUnavailable'));
        }
        return Promise.resolve(settled());
      });

      const first = invalidate(id, 'INBOX');
      const later = invalidate(id, 'Sent');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await first).toEqual({ invalidated: false });
      expect(await later).toEqual({ invalidated: false });
      expect(invalidations).toBe(2);

      firstNative.resolve({ invalidated: true });
      await vi.advanceTimersByTimeAsync(1);
      expect(await mailboxIsUnchanged(account, id, 'INBOX'),
        'late expired success must not clear the later failed mutation')
        .toEqual({ unchanged: false, reason: 'probe-failed' });
      expect(bridge.send.mock.calls.filter(([, params]) => params.op === 'check'))
        .toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails conservatively when the native check is unavailable, with no legacy fallback', async () => {
    const id = nextId();
    bridge.send.mockRejectedValue(new Error('errors.daemonOutdated'));
    expect(await mailboxIsUnchanged(account, id, 'INBOX'))
      .toEqual({ unchanged: false, reason: 'probe-failed' });
    expect(bridge.legacyStatus).not.toHaveBeenCalled();
    expect(bridge.legacyMeta).not.toHaveBeenCalled();
  });

  it('bounds the full check, including a native reply that never arrives', async () => {
    vi.useFakeTimers();
    try {
      const id = nextId();
      bridge.send.mockReturnValue(new Promise(() => {}));
      const check = mailboxIsUnchanged(account, id, 'INBOX');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await check).toEqual({ unchanged: false, reason: 'probe-failed' });
    } finally {
      vi.useRealTimers();
    }
  });
});
