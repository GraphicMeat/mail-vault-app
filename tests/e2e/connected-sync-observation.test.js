/**
 * Focused connected proof for native mailbox observation and closed-folder STATUS.
 * The strict held-provider concurrency boundary is exercised by the daemon
 * pause_command regression; this JS mock server has no command release gate.
 */

import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails } from './helpers.js';
import { startMockImap, mailbox, mockAccount, MOCK_PASSWORD } from './mockImap.js';

const OWNER = 's1-observation@mock.test';
const ACCOUNT_ID = '51515151-5151-4515-8515-515151515151';
const CLOSED = 'Closed';
const BRANCH = 'Projects';
const CHILD = 'Projects/Child';
const STATE = {
  mailboxes: [
    mailbox('INBOX', 3, { owner: OWNER, subjectPrefix: 'S1 inbox' }),
    mailbox(CLOSED, 2, { owner: OWNER, uidStart: 101, subjectPrefix: 'S1 closed' }),
    mailbox(BRANCH, 1, { owner: OWNER, uidStart: 201, attrs: ['\\HasChildren'], subjectPrefix: 'S1 project' }),
    mailbox(CHILD, 1, { owner: OWNER, uidStart: 301, subjectPrefix: 'S1 child' }),
  ],
};

async function runInStore(action, args = []) {
  await browser.execute((name, values) => {
    window.__S1_STORE_RESULT__ = null;
    Promise.resolve().then(() => window.__MAIL_STORE__.getState()[name](...values)).then(
      value => { window.__S1_STORE_RESULT__ = { done: true, ok: true, id: value?.id || null }; },
      failure => { window.__S1_STORE_RESULT__ = { done: true, ok: false, reason: String(failure?.message || failure) }; },
    );
  }, action, args);
  const result = await browser.waitUntil(
    () => browser.execute(() => window.__S1_STORE_RESULT__?.done && window.__S1_STORE_RESULT__),
    { timeout: 90_000, interval: 300, timeoutMsg: `${action} did not settle` },
  );
  if (!result.ok) throw new Error(`${action} failed: ${result.reason}`);
  return result.id;
}

const snapshot = (accountId, otherId) => browser.execute((id, other) => {
  const state = window.__MAIL_STORE__.getState();
  const row = [...document.querySelectorAll('[data-testid="folder-row"]')]
    .find(element => element.getAttribute('data-path') === 'Closed');
  return {
    activeAccountId: state.activeAccountId,
    activeMailbox: state.activeMailbox,
    unifiedInbox: state.unifiedInbox,
    scope: state.mailboxScope?.root || null,
    complete: state.serverUids?.complete === true,
    connectionStatus: state.connectionStatus,
    connectionError: state.connectionError,
    closed: state.folderStatus?.[id]?.Closed || null,
    closedBadge: row?.querySelector('[data-testid="folder-unseen"]')?.textContent || null,
    other: state.folderStatus?.[other] || null,
    calls: (window.__S1_NATIVE__?.calls || []).map(call => ({ ...call })),
    unhandled: [...(window.__S1_NATIVE__?.unhandled || [])],
  };
}, accountId, otherId);

const nativeCalls = () => browser.execute(() => (window.__S1_NATIVE__?.calls || []).map(call => ({ ...call })));

async function changeClosedMessageFlag(server) {
  const client = new ImapFlow({
    host: server.host, port: server.port, secure: false,
    auth: { user: OWNER, pass: MOCK_PASSWORD }, logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(CLOSED);
    try { await client.messageFlagsAdd(101, ['\\Seen'], { uid: true }); }
    finally { lock.release(); }
  } finally {
    await client.logout();
  }
}

describe('Connected native sync observation', function () {
  this.timeout(240_000);
  let server;
  let accountId;
  let otherId;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true,
    { timeout: 60_000, interval: 300, timeoutMsg: 'native daemon did not become healthy' });
    otherId = browser.mockAccounts[0].id;
    await runInStore('activateAccount', [otherId, 'INBOX']);
    try {
      await browser.waitUntil(async () => {
        const state = await snapshot(ACCOUNT_ID, otherId);
        return state.other && Object.keys(state.other).length > 0;
      }, { timeout: 60_000, interval: 300, timeoutMsg: 'seeded account has no real closed-folder STATUS rows' });
    } finally {
      try {
        const diagnostic = await browser.execute(id => {
          const state = window.__MAIL_STORE__.getState();
          const paths = [];
          const visit = nodes => {
            for (const node of nodes || []) { paths.push(node.path); visit(node.children); }
          };
          visit(state.mailboxes);
          return {
            activeAccountId: state.activeAccountId,
            activeMailbox: state.activeMailbox,
            accountPresent: Boolean(state.accounts?.find(account => account.id === id)),
            mailboxPaths: paths,
            statusPaths: Object.keys(state.folderStatus?.[id] || {}),
          };
        }, otherId);
        console.log('[s1-observation] seeded STATUS state:', JSON.stringify(diagnostic));
      } catch (failure) {
        console.warn('[s1-observation] seeded STATUS state unavailable:', failure.message);
      }
    }

    await browser.execute(() => {
      const original = window.__TAURI__;
      const calls = [];
      const unhandled = [];
      const rejected = event => unhandled.push(String(event.reason?.message || event.reason));
      window.addEventListener('unhandledrejection', rejected);
      window.__S1_NATIVE__ = { original, calls, unhandled, rejected };
      const invoke = (command, args) => {
        const method = command === 'daemon_rpc' ? args?.method : null;
        const watched = ['sync.probe', 'folders.status', 'sync.now', 'sync.wait'].includes(method);
        const params = args?.params || {};
        const call = watched ? {
          seq: calls.length + 1, method, op: params.op || null,
          accountId: params.accountId || params.account?.id || null,
          mailbox: params.mailbox || null, ticket: params.ticket ?? null,
          verificationRef: params.verificationRef ?? null,
          done: false,
        } : null;
        if (call) calls.push(call);
        let task;
        try { task = original.core.invoke(command, args); }
        catch (failure) {
          if (call) { call.done = true; call.ok = false; call.reason = String(failure?.message || failure); }
          throw failure;
        }
        if (call) Promise.resolve(task).then(value => {
          call.done = true;
          call.ok = true;
          if (method === 'sync.probe') call.result = {
            unchanged: value?.unchanged ?? null, reason: value?.reason ?? null,
            verificationRef: value?.verificationRef ?? null,
            marked: value?.marked ?? null, invalidated: value?.invalidated ?? null,
          };
          if (method === 'folders.status') call.result = value === null ? null : {
            invalidated: value?.invalidated ?? null,
            rows: Array.isArray(value?.rows) ? value.rows.map(row => ({
              path: row.path, messages: row.messages, unseen: row.unseen,
            })) : null,
          };
          if (method === 'sync.now') call.result = { started: value?.started ?? null, ticket: value?.ticket ?? null };
          if (method === 'sync.wait') call.result = { success: value?.success ?? null };
        }, failure => {
          call.done = true;
          call.ok = false;
          call.reason = String(failure?.message || failure);
        });
        return task;
      };
      window.__TAURI__ = { ...original, core: { ...original.core, invoke } };
      if (window.__TAURI__.core.invoke !== invoke) throw new Error('native observation bridge not installed');
    });

    server = await startMockImap({ state: STATE, faults: [] });
    const account = mockAccount({ id: ACCOUNT_ID, email: OWNER, port: server.port, smtpPort: server.smtpPort });
    accountId = await runInStore('addAccount', [account]);
    expect(accountId).toBe(ACCOUNT_ID);
    await runInStore('activateAccount', [accountId, 'INBOX']);
    await browser.waitUntil(async () => {
      const state = await snapshot(accountId, otherId);
      return state.activeAccountId === accountId && state.activeMailbox === 'INBOX'
        && state.complete && state.closed?.unseen === 1 && state.closedBadge === '1';
    }, { timeout: 90_000, interval: 300,
      timeoutMsg: 'complete dedicated INBOX and native closed-folder unread badge never appeared' });
  });

  after(async function () {
    if (accountId) {
      try { await runInStore('removeAccount', [accountId]); }
      catch (failure) { console.warn('[s1-observation] account removal:', failure.message); }
    }
    try {
      await browser.execute(() => {
        if (!window.__S1_NATIVE__) return;
        window.__TAURI__ = window.__S1_NATIVE__.original;
        window.removeEventListener('unhandledrejection', window.__S1_NATIVE__.rejected);
        delete window.__S1_NATIVE__;
        delete window.__S1_STORE_RESULT__;
      });
    } catch (failure) { console.warn('[s1-observation] observer removal:', failure.message); }
    server?.stop();
  });

  it('uses a completed ticket mark then a native probe to skip a redundant INBOX sync', async function () {
    const initial = await nativeCalls();
    const marked = initial.filter(call => call.method === 'sync.probe' && call.op === 'mark'
      && call.accountId === accountId && call.done && call.ok && call.result?.marked).at(-1);
    expect(marked?.ticket).toBeGreaterThan(0);
    const started = initial.find(call => call.method === 'sync.now' && call.accountId === accountId
      && call.done && call.ok && call.result?.ticket === marked.ticket);
    expect(started?.result?.ticket).toBe(marked.ticket);
    const completed = initial.find(call => call.method === 'sync.wait'
      && call.ticket === marked.ticket && call.done && call.ok);
    expect(completed?.result?.success).toBe(true);

    const baseline = initial.length;
    await runInStore('activateAccount', [accountId, 'INBOX']);
    await browser.waitUntil(async () => {
      const calls = await nativeCalls();
      return calls.slice(baseline).some(call => call.method === 'sync.probe'
        && call.op === 'check' && call.accountId === accountId && call.done);
    }, { timeout: 45_000, interval: 250, timeoutMsg: 'second activation never checked native sync.probe' });
    const latest = await snapshot(accountId, otherId);
    const newCalls = latest.calls.slice(baseline);
    const probe = newCalls.find(call => call.method === 'sync.probe'
      && call.op === 'check' && call.accountId === accountId && call.done && call.ok);
    expect(probe?.result?.unchanged).toBe(true);
    expect(['probed-recently', 'modseq-match', 'uidnext-exists-match'])
      .toContain(probe?.result?.reason);
    if (probe.result.reason !== 'probed-recently') {
      expect(typeof probe.result.verificationRef).toBe('string');
      expect(probe.result.verificationRef.length).toBeGreaterThan(0);
      const proofMark = newCalls.find(call => call.method === 'sync.probe'
        && call.op === 'mark' && call.accountId === accountId
        && call.verificationRef === probe.result.verificationRef && call.done && call.ok);
      expect(proofMark?.result?.marked).toBe(true);
    }
    expect(newCalls.filter(call => call.method === 'sync.now' && call.accountId === accountId)).toHaveLength(0);
    expect(latest.activeAccountId).toBe(accountId);
    expect(latest.activeMailbox).toBe('INBOX');
    expect(latest.complete).toBe(true);
    expect(latest.connectionError).toBeFalsy();
  });

  it('publishes native STATUS after a provider flag change in a closed folder', async function () {
    await browser.waitUntil(async () => {
      const calls = await nativeCalls();
      return calls.filter(call => call.method === 'folders.status' && call.accountId === accountId)
        .every(call => call.done);
    }, { timeout: 30_000, interval: 250, timeoutMsg: 'earlier STATUS call did not settle' });
    const before = await snapshot(accountId, otherId);
    expect(before.closed?.unseen).toBe(1);
    expect(before.closedBadge).toBe('1');
    expect(before.other && Object.keys(before.other).length).toBeGreaterThan(0);
    await changeClosedMessageFlag(server);

    const baseline = before.calls.length;
    await browser.execute(() => {
      window.__S1_STORE_RESULT__ = null;
      Promise.resolve().then(() => window.__MAIL_STORE__.getState().refreshCurrentView()).then(
        () => { window.__S1_STORE_RESULT__ = { done: true, ok: true }; },
        failure => { window.__S1_STORE_RESULT__ = { done: true, ok: false, reason: String(failure?.message || failure) }; },
      );
    });
    await browser.waitUntil(async () => (await nativeCalls()).slice(baseline)
      .some(call => call.method === 'folders.status' && call.op === 'refresh'
        && call.accountId === accountId),
    { timeout: 90_000, interval: 100, timeoutMsg: 'Refresh never started native folders.status' });
    const sweepPendingAtRead = (await nativeCalls()).slice(baseline)
      .some(call => call.method === 'folders.status' && call.op === 'refresh'
        && call.accountId === accountId && !call.done);
    console.log('[s1-observation] STATUS pending at foreground read:', sweepPendingAtRead);
    const foreground = await browser.executeAsync((id, done) => {
      window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'sync.status', params: { accountId: id } })
        .then(value => done({ ok: true, hasStatus: typeof value?.status === 'string' }),
          failure => done({ ok: false, reason: String(failure?.message || failure) }));
    }, accountId);
    expect(foreground.ok).toBe(true);
    expect(foreground.hasStatus).toBe(true);
    const refresh = await browser.waitUntil(
      () => browser.execute(() => window.__S1_STORE_RESULT__?.done && window.__S1_STORE_RESULT__),
      { timeout: 90_000, interval: 300, timeoutMsg: 'Refresh did not settle' },
    );
    if (!refresh.ok) throw new Error(`Refresh failed: ${refresh.reason}`);
    await browser.waitUntil(async () => {
      const state = await snapshot(accountId, otherId);
      return state.closed?.unseen === 0 && state.closedBadge === null;
    }, { timeout: 90_000, interval: 300, timeoutMsg: 'closed-folder native STATUS did not clear unread badge' });

    const after = await snapshot(accountId, otherId);
    const calls = after.calls.slice(baseline);
    const sweeps = calls.filter(call => call.method === 'folders.status'
      && call.op === 'refresh' && call.accountId === accountId);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].done && sweeps[0].ok).toBe(true);
    expect(sweeps[0].result?.rows?.find(row => row.path === CLOSED)?.unseen).toBe(0);
    expect(calls.filter(call => call.method === 'folders.status'
      && call.op === 'invalidate' && call.accountId === accountId).length).toBe(1);
    expect(after.other).toEqual(before.other);
    expect(after.activeAccountId).toBe(accountId);
    expect(after.activeMailbox).toBe('INBOX');
    expect(after.unifiedInbox).toBe(false);
    expect(after.scope).toBe(null);
  });

  it('preserves the branch listing through Refresh and leaks no adapter rejection', async function () {
    await browser.waitUntil(async () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="folder-row"]')]
        .some(row => row.getAttribute('data-path') === 'Projects')),
    { timeout: 45_000, interval: 300, timeoutMsg: 'Projects branch never appeared' });
    const clicked = await browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="folder-row"]')]
        .find(element => element.getAttribute('data-path') === 'Projects');
      row?.click();
      return Boolean(row);
    });
    expect(clicked).toBe(true);
    await browser.waitUntil(async () => {
      const state = await snapshot(accountId, otherId);
      const childVisible = await browser.execute(() =>
        [...document.querySelectorAll('[data-testid="email-row"]')]
          .some(row => (row.textContent || '').includes('S1 child 301')));
      return state.scope === BRANCH && state.activeMailbox === BRANCH && childVisible;
    }, { timeout: 60_000, interval: 300, timeoutMsg: 'branch scope never opened' });
    await browser.execute(() => {
      window.__S1_SCOPE_BEFORE__ = window.__MAIL_STORE__.getState().mailboxScope;
    });
    // The store action schedules Refresh and returns before its subtree load.
    // A new scope is published before STATUS and either folder's rows arrive.
    await runInStore('refreshCurrentView');
    await browser.waitUntil(() => browser.execute(() => {
      const state = window.__MAIL_STORE__.getState();
      const childInStore = (state.emails || []).some(row =>
        row._mailbox === 'Projects/Child' && row.subject?.includes('S1 child 301'));
      const childVisible = [...document.querySelectorAll('[data-testid="email-row"]')]
        .some(row => (row.textContent || '').includes('S1 child 301'));
      return state.mailboxScope?.root === 'Projects'
        && state.mailboxScope !== window.__S1_SCOPE_BEFORE__
        && !state.loading && !state.subtreeProgress && childInStore && childVisible;
    }), { timeout: 60_000, interval: 300,
      timeoutMsg: 'Refresh did not re-list and paint the child in the branch' });
    const state = await snapshot(accountId, otherId);
    expect(state.activeAccountId).toBe(accountId);
    expect(state.scope).toBe(BRANCH);
    expect(state.unifiedInbox).toBe(false);
    expect(await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"]')]
        .some(row => (row.textContent || '').includes('S1 child 301')))).toBe(true);
    expect(state.unhandled).toEqual([]);
  });
});
