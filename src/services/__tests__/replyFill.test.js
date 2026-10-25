import { beforeEach, describe, expect, it, vi } from 'vitest';
const { io } = vi.hoisted(() => ({ io: { context: null, ackGate: null, rpcGate: null, ackCalls: 0, calls: [], failure: null } }));
vi.mock('../../stores/safeStorage', async original => ({ ...(await original()), flushSafeStorage: async () => {
  io.ackCalls++; if (io.ackGate) await io.ackGate; return io.context.version;
} }));
vi.mock('../transport', () => ({ send: async (_method, params) => {
  io.calls.push(params); if (io.rpcGate) await io.rpcGate;
  if (io.failure) throw io.failure;
  const { prepareDemoCompose } = await import('../../demo/composePrep');
  return prepareDemoCompose(params, { accounts: io.context.mail.accounts, values: { 'mailvault-settings': { state: io.context.settings } }, version: io.context.version });
} }));
vi.mock('../../utils/dateFormat', () => ({ formatDateTime: value => `date:${value}` }));
import { createReplyFillController } from '../replyFill';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const one = { id: 'one', email: 'me@example.test' };
const two = { id: 'two', email: 'second@example.test' };
const header = { uid: 7, _accountId: 'one', _mailbox: 'INBOX', subject: 'Original', from: { address: 'writer@example.test' }, to: [{ address: one.email }, { address: 'own-alias@example.test' }], text: '' };
const make = (minimized = true, large = false) => {
  const issued = { revision: 9, accountId: 'one', payload: { html: '<p>immutable issued bytes</p>' } };
  const data = { to: 'original@example.test', cc: '', bcc: 'authored-bcc@example.test', subject: 'Before', body: '<p>Before edit</p>', _accountId: 'one', _fromAddress: one.email,
    _draftId: 'stable', _draftRevision: 9, _draftContent: issued, _baseline: { body: '<p>baseline</p>' } };
  let windows = [{ id: 7, mode: 'reply', replyTo: header, minimized, snapshot: data, initialData: data }];
  const full = { ...header, html: large ? '<p>' + '界'.repeat(750000) + 'FINAL_ORIGINAL</p>' : '<p>full body</p>',
    _threadContext: Array.from({ length: large ? 70 : 2 }, (_, i) => ({ ...header, date: `stamp-${i}`, html: `<p>START-${i}:` + (large ? 'x'.repeat(35000) : '') + `:END-${i}</p>` })) };
  const onError = vi.fn();
  const controller = createReplyFillController({ getWindows: () => windows, setWindows: updater => { windows = updater(windows); }, getContext: () => io.context, onError });
  return { controller, onError, full, issued, data, get windows() { return windows; }, set windows(value) { windows = value; },
    fill: () => controller.fill({ mode: 'reply', _fillFrom: header, replyTo: full }) };
};
beforeEach(() => {
  io.context = { version: 1, mail: { accounts: [one, two], activeAccountId: 'one', lastSelectedAccountId: 'one' }, settings: { aliases: {}, sendAsAddresses: {}, getOrderedAccounts: accounts => accounts } };
  io.ackGate = null; io.rpcGate = null; io.ackCalls = 0; io.calls = []; io.failure = null;
});
describe('App-owned asynchronous reply fills', () => {
  it.each([['ACK', true], ['RPC', true], ['ACK', false], ['RPC', false]])('retains the complete large intent after identity changes during %s (minimized=%s)', async (phase, minimized) => {
    const gate = deferred(); if (phase === 'ACK') io.ackGate = gate.promise; else io.rpcGate = gate.promise;
    const h = make(minimized, true); const filling = h.fill();
    await vi.waitFor(() => expect(phase === 'ACK' ? io.ackCalls : io.calls.length).toBe(1));
    const latest = { ...h.data, to: 'latest@example.test', subject: 'Latest subject', body: '<p>Latest template edit</p>', _accountId: 'two', _fromAddress: 'picked@example.test' };
    h.windows = h.windows.map(w => ({ ...w, snapshot: latest, initialData: latest }));
    io.context.settings.aliases = { two: [{ address: 'own-alias@example.test' }, { address: 'picked@example.test' }] };
    io.context.settings.sendAsAddresses = { two: 'default@example.test' }; io.context.version = 2;
    gate.resolve(); await filling;
    const window = h.windows[0];
    expect(window.replyTo === h.full).toBe(true);
    const prepared = minimized ? window.snapshot : window.preparedQuote.result;
    expect((minimized ? prepared._quotedHtml : prepared.quotedHtml).endsWith(h.full.html)).toBe(true);
    expect(minimized ? prepared._contextHtml : prepared.contextHtml).toContain(':END-69</p>');
    expect(window.snapshot).toMatchObject({ to: latest.to, bcc: latest.bcc, subject: latest.subject, body: latest.body, _accountId: 'two', _fromAddress: 'picked@example.test', _draftRevision: 9 });
    expect(window.snapshot._draftContent).toBe(h.issued); expect(window.snapshot._baseline).toBe(latest._baseline);
    expect(io.calls.at(-1).accountId).toBe('two'); expect(io.calls.at(-1).pickedFrom).toBe('picked@example.test');
    expect(io.calls.at(-1).threadContext).toHaveLength(70); expect(io.calls.at(-1).original.html).toBe(h.full.html);
    expect(h.onError).not.toHaveBeenCalled(); expect(io.ackCalls).toBe(2); expect(io.calls.length).toBe(phase === 'ACK' ? 1 : 2);
  });
  it.each(['ACK', 'RPC'].flatMap(phase => ['closed', 'terminal', 'detached', 'replaced'].map(state => [phase, state])))('refuses a %s completion for a %s window', async (phase, state) => {
    const gate = deferred(); if (phase === 'ACK') io.ackGate = gate.promise; else io.rpcGate = gate.promise;
    const h = make(); const filling = h.fill();
    await vi.waitFor(() => expect(phase === 'ACK' ? io.ackCalls : io.calls.length).toBe(1));
    h.windows = state === 'closed' ? [] : h.windows.map(w => state === 'terminal' ? { ...w, snapshot: { ...w.snapshot, _draftTerminal: 'sent' } }
      : state === 'detached' ? { ...w, detached: true } : { ...w, id: 99 });
    const refused = h.windows; gate.resolve(); await filling;
    expect(h.windows).toBe(refused); expect(h.onError).not.toHaveBeenCalled(); expect(io.ackCalls).toBe(1);
  });
  it('reports an ordinary timeout once without an automatic retry loop', async () => {
    io.failure = new Error('compose.preparationUnavailable');
    const h = make(); await h.fill();
    expect(io.ackCalls).toBe(1); expect(io.calls).toHaveLength(1); expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.windows[0].replyTo).toBe(header); expect(h.windows[0].snapshot._draftContent).toBe(h.issued);
  });
  it('coalesces a newer resolved body while the first native request is pending', async () => {
    const gate = deferred(); io.rpcGate = gate.promise;
    const h = make(); const filling = h.fill(); await vi.waitFor(() => expect(io.calls).toHaveLength(1));
    const newest = { ...h.full, html: '<p>newest resolved body</p>' };
    const second = h.controller.fill({ mode: 'reply', _fillFrom: header, replyTo: newest });
    gate.resolve(); await Promise.all([filling, second]);
    expect(h.windows[0].replyTo).toBe(newest); expect(h.windows[0].snapshot._quotedHtml).toContain('newest resolved body'); expect(io.calls).toHaveLength(2);
  });
});
