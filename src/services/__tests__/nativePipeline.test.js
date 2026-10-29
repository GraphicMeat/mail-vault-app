import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let focusReplies = [];
const daemonCall = vi.fn(async (method, params) => {
  calls.push({ method, params });
  if (method === 'pipeline.status') return { instanceId: 'i', revision: 9, accounts: { a: { phase: 'content', queued: 3, activeSlots: 2 } } };
  const next = focusReplies.shift();
  return next ?? { revision: params.revision, accepted: true };
});
vi.mock('../daemonClient.js', () => ({ daemonCall: (...args) => daemonCall(...args) }));

const native = await import('../nativePipeline.js');

beforeEach(() => { calls.length = 0; focusReplies = []; native.resetForTests(); });

describe('nativePipeline', () => {
  it('turns the list on screen into raw facts: unified rows keep their own stamp, others belong to the active folder', () => {
    const base = { activeAccountId: 'a', activeMailbox: 'INBOX', mailboxScope: null };
    expect(native.viewFacts({ ...base, emails: [{ uid: 1, date: 'd', internalDate: 5 }, { uid: 0 }, {}] })).toEqual({
      accountId: 'a', mailbox: 'INBOX', scope: 'folder', rows: [{ accountId: 'a', mailbox: 'INBOX', uid: 1, date: 'd', internalDate: 5 }] });
    expect(native.viewFacts({ ...base, activeMailbox: 'UNIFIED', emails: [{ uid: 2, _accountId: 'b', _mailbox: 'Sent' }, { uid: 3 }] }).rows)
      .toEqual([{ accountId: 'b', mailbox: 'Sent', uid: 2, date: null, internalDate: null }]);
    expect(native.viewFacts({ ...base, activeAccountId: null, emails: [] })).toBeNull();
    const many = Array.from({ length: 6000 }, (_, i) => ({ uid: i + 1 }));
    expect(native.viewFacts({ ...base, emails: many }).rows).toHaveLength(5000);
  });

  it('never sends a date it cannot trust and carries no policy, credential or cutoff field', () => {
    const facts = native.viewFacts({ activeAccountId: 'a', activeMailbox: 'INBOX', mailboxScope: null,
      emails: [{ uid: 1, date: { toString() { return 'x'; } }, internalDate: NaN, token: 't', keepSince: 1 }] });
    expect(facts.rows[0]).toEqual({ accountId: 'a', mailbox: 'INBOX', uid: 1, date: null, internalDate: null });
  });

  it('adopts the daemon revision once and then only grows; a refused revision is retried above the daemon\'s', async () => {
    focusReplies = [{ revision: 20, accepted: false }];
    await native.focusNative({ accountId: 'a', mailbox: 'INBOX', scope: 'folder', rows: [] });
    const focus = calls.filter(c => c.method === 'pipeline.focus').map(c => c.params.revision);
    expect(focus).toEqual([10, 21]);
    await native.resendNative();
    expect(calls.filter(c => c.method === 'pipeline.focus').at(-1).params.revision).toBe(22);
    expect(calls.filter(c => c.method === 'pipeline.status')).toHaveLength(1);
  });

  it('a refused revision is retried with the view that is latest now, not the one this call began with', async () => {
    const view = mailbox => ({ accountId: 'a', mailbox, scope: 'folder', rows: [] });
    await native.focusNative(view('INBOX'));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    daemonCall.mockImplementationOnce(async (method, params) => { calls.push({ method, params }); await gate; return { revision: 50, accepted: false }; });
    const first = native.focusNative(view('INBOX'));
    await native.focusNative(view('Archive'));
    release();
    await first;
    const sent = calls.filter(c => c.method === 'pipeline.focus');
    expect(sent.at(-1).params.focus.mailbox, 'the screen shows Archive now').toBe('Archive');
    expect(sent.at(-1).params.revision).toBeGreaterThan(50);
  });

  it('a refused revision is not retried once the window retired its observation', async () => {
    const view = { accountId: 'a', mailbox: 'INBOX', scope: 'folder', rows: [] };
    await native.focusNative(view);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    daemonCall.mockImplementationOnce(async (method, params) => { calls.push({ method, params }); await gate; return { revision: 50, accepted: false }; });
    const first = native.focusNative(view);
    const before = calls.filter(c => c.method === 'pipeline.focus').length;
    native.retireObservation();
    release();
    await first;
    expect(calls.filter(c => c.method === 'pipeline.focus')).toHaveLength(before);
  });

  it('retiring the observation sends nothing, but an explicit stop clears the daemon\'s focus', async () => {
    await native.focusNative({ accountId: 'a', mailbox: 'INBOX', scope: 'folder', rows: [] });
    calls.length = 0;
    native.retireObservation();
    expect(await native.resendNative()).toBeNull();
    expect(calls).toEqual([]);
    await native.stopNative();
    expect(calls.at(-1)).toMatchObject({ method: 'pipeline.focus', params: { focus: null } });
  });

  it('keeps a synchronous snapshot of the daemon\'s progress for the debug hooks', async () => {
    await native.readNativeStatus();
    native.noteProgress({ accountId: 'b', phase: 'done', queued: 0, activeSlots: 0 });
    expect(native.snapshot()).toEqual([
      { id: 'a', phase: 'content', queued: 3, held: 0, activeSlots: 2 },
      { id: 'b', phase: 'done', queued: 0, held: 0, activeSlots: 0 }]);
  });
});
