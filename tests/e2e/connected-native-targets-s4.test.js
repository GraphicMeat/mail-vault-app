/** S4 connected target proof: the real renderer context and native worker choose per-account folders. */
import { waitForApp, waitForEmails } from './helpers.js';
import { startMockImap, scenario, mockAccount } from './mockImap.js';

const A = { id: '58585858-5858-4585-8585-585858585858', email: 'native-targets@mock.test' };
const wait = (test, message, timeout = 60_000) => browser.waitUntil(test,
  { timeout, interval: 250, timeoutMsg: message });

async function rpc(method, params = {}) {
  const answer = await browser.executeAsync((name, values, done) => {
    window.__TAURI__.core.invoke('daemon_rpc', { method: name, params: values }).then(
      value => done({ ok: true, value }),
      error => done({ ok: false, reason: String(error?.message || error) }),
    );
  }, method, params);
  if (!answer?.ok) throw Error(`${method}: ${answer?.reason}`);
  return answer.value;
}

async function store(action, args = []) {
  await browser.execute((name, values) => {
    window.__S4_TARGET_RESULT__ = null;
    Promise.resolve().then(() => window.__MAIL_STORE__.getState()[name](...values)).then(
      value => { window.__S4_TARGET_RESULT__ = { done: true, ok: true, value }; },
      error => { window.__S4_TARGET_RESULT__ = { done: true, ok: false,
        reason: String(error?.message || error) }; },
    );
  }, action, args);
  const result = await wait(() => browser.execute(() => window.__S4_TARGET_RESULT__?.done
    && window.__S4_TARGET_RESULT__), `${action} did not settle`, 90_000);
  if (!result.ok) throw Error(`${action}: ${result.reason}`);
  return result.value;
}

async function cached(mailbox) {
  const value = await rpc('load_email_cache', { accountId: A.id, mailbox });
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function observed() {
  return browser.execute(() => ({
    view: {
      activeAccountId: window.__MAIL_STORE__.getState().activeAccountId,
      activeMailbox: window.__MAIL_STORE__.getState().activeMailbox,
      unifiedInbox: window.__MAIL_STORE__.getState().unifiedInbox,
      unifiedFolder: window.__MAIL_STORE__.getState().unifiedFolder,
      mailboxScope: window.__MAIL_STORE__.getState().mailboxScope,
    },
    calls: window.__S4_TARGET_OBSERVER__?.calls || [],
  }));
}

describe('Connected S4 native context targets', function () {
  this.timeout(240_000);
  let server, added = false, B, bCount, expectedInbox;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await wait(() => browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive === true),
      'native daemon did not become healthy');
    B = browser.mockAccounts[0];
    await wait(() => browser.execute(id => Number.isSafeInteger(
      window.__SETTINGS_STORE__.getState().unreadPerAccount[id]), B.id),
    'B native unread baseline was not published');
    bCount = await browser.execute(id =>
      window.__SETTINGS_STORE__.getState().unreadPerAccount[id], B.id);
    const fixture = scenario({ owner: A.email, inbox: 2,
      subjectPrefix: 'S4 native target', archiveCount: 0,
      nestedMailboxes: ['Projects', 'Projects/Child'] });
    expectedInbox = fixture.state.mailboxes.find(box => box.name === 'INBOX')?.messages.length;
    expect(expectedInbox).toBeGreaterThan(2);
    server = await startMockImap(fixture);
    const account = mockAccount({ ...A, port: server.port, smtpPort: server.smtpPort });
    expect((await store('addAccount', [account]))?.id).toBe(A.id);
    added = true;
    await store('activateAccount', [A.id, 'INBOX']);
    await wait(async () => {
      const snapshot = await cached('INBOX');
      return snapshot?.emails?.length === expectedInbox
        && snapshot.totalCached === expectedInbox
        && snapshot.totalEmails === expectedInbox
        && snapshot.nativeIdentity?.accountId === A.id;
    }, 'A native INBOX cache did not reach complete initial state');
    expect(await browser.execute(() => {
      const original = window.__TAURI__;
      const calls = [];
      const invoke = (command, args) => {
        if (command === 'daemon_rpc' && ['sync.context', 'sync.refresh'].includes(args?.method)) {
          calls.push({ method: args.method, params: args.params });
        }
        return original.core.invoke(command, args);
      };
      window.__S4_TARGET_OBSERVER__ = { original, calls };
      window.__TAURI__ = { ...original, core: { ...original.core, invoke } };
      return window.__TAURI__.core.invoke === invoke;
    })).toBe(true);
  });

  after(async function () {
    try { await browser.execute(() => {
      const trace = window.__S4_TARGET_OBSERVER__;
      if (trace) window.__TAURI__ = trace.original;
      delete window.__S4_TARGET_OBSERVER__;
      delete window.__S4_TARGET_RESULT__;
    }); } catch { /* app may be closed */ }
    if (added) {
      try { await store('removeAccount', [A.id]); }
      catch (error) { console.warn('[S4 targets] account removal:', error.message); }
    }
    server?.stop();
  });

  it('resolves real unified Sent from an omitted mailbox under the adopted owner', async function () {
    await store('setUnifiedInbox', [true]);
    await store('switchUnifiedFolder', ['Sent']);
    await wait(async () => (await observed()).view.unifiedFolder === 'Sent',
      'the real unified Sent view did not settle');
    const before = (await observed()).calls.length;
    const result = await store('refreshAllAccounts', [{ accountId: A.id }]);
    const trace = await observed();
    expect(trace.view).toMatchObject({ activeMailbox: 'UNIFIED', unifiedInbox: true,
      unifiedFolder: 'Sent' });
    const intent = trace.calls.slice(before).find(call => call.method === 'sync.refresh'
      && call.params?.accountId === A.id);
    expect(intent?.params).toEqual(expect.objectContaining({ accountId: A.id, reason: 'manual' }));
    expect(Object.hasOwn(intent.params, 'mailbox')).toBe(false);
    expect(result?.receipt).toMatchObject({ status: 'complete', accountResults: expect.arrayContaining([
      expect.objectContaining({ accountId: A.id, mailbox: 'Sent', success: true }),
    ]) });
    expect((await cached('Sent'))?.emails?.length).toBeGreaterThan(0);
    expect(await cached('UNIFIED')).toBeNull();
    expect(await browser.execute(id => window.__SETTINGS_STORE__.getState().unreadPerAccount[id], B.id))
      .toBe(bCount);
  });

  it('resolves a real Projects branch from its captured subtree context', async function () {
    await store('setUnifiedInbox', [false]);
    await store('activateAccount', [A.id, 'INBOX']);
    await wait(() => browser.execute(() => {
      const paths = window.__MAIL_STORE__.getState().mailboxes?.map(row => row.path) || [];
      return paths.includes('Projects') && paths.includes('Projects/Child');
    }), 'the native account folder listing did not include the actual branch');
    await store('loadSubtree', [A.id, 'Projects']);
    await wait(async () => (await observed()).view.mailboxScope?.paths?.includes('Projects/Child'),
      'the real subtree view did not settle');
    const before = (await observed()).calls.length;
    const result = await store('refreshAllAccounts', [{ accountId: A.id }]);
    const trace = await observed();
    expect(trace.view).toMatchObject({ activeAccountId: A.id, activeMailbox: 'Projects',
      mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/Child'] } });
    const contextAt = trace.calls.findLastIndex(call => call.method === 'sync.context'
      && call.params?.view?.scopePaths?.includes('Projects/Child'));
    expect(contextAt).toBeGreaterThanOrEqual(0);
    expect(trace.calls[contextAt].params.view.scopePaths).toEqual(['Projects', 'Projects/Child']);
    const intentAt = trace.calls.findIndex((call, index) => index >= before
      && call.method === 'sync.refresh' && call.params?.accountId === A.id);
    expect(intentAt).toBeGreaterThan(contextAt);
    const intent = trace.calls[intentAt];
    expect(intent?.params).toEqual(expect.objectContaining({ accountId: A.id, reason: 'manual' }));
    expect(Object.hasOwn(intent.params, 'mailbox')).toBe(false);
    expect(result?.receipt).toMatchObject({ status: 'complete', accountResults: [
      expect.objectContaining({ accountId: A.id, mailbox: 'Projects', success: true }),
      expect.objectContaining({ accountId: A.id, mailbox: 'Projects/Child', success: true }),
    ] });
    expect((await cached('Projects'))?.emails?.length).toBeGreaterThan(0);
    expect((await cached('Projects/Child'))?.emails?.length).toBeGreaterThan(0);
    expect(await browser.execute(id => window.__SETTINGS_STORE__.getState().unreadPerAccount[id], B.id))
      .toBe(bCount);
  });
});
