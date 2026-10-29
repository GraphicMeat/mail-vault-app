/** S4 connected proof: a real IMAP delivery reaches native cache, feed and UI. */
import { ImapFlow } from 'imapflow';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';
import { startMockImap, scenario, mockAccount, MOCK_PASSWORD, appDataDir } from './mockImap.js';

const A = { id: '57575757-5757-4575-8575-575757575757', email: 'native-arrival@mock.test' };
const SUBJECT = 'Your verification code is 364758';
const MESSAGE_ID = '<native-arrival-364758@mock.test>';
const daemonLogTail = () => {
  const dir = join(appDataDir(browser.testDataDir), 'logs');
  if (!existsSync(dir)) return `(no log dir ${dir})`;
  return readdirSync(dir).filter(name => name.startsWith('daemon.log'))
    .flatMap(name => readFileSync(join(dir, name), 'utf-8').split('\n'))
    .filter(line => /native-arrival@|57575757|\[idle\]|arrival|publication|source/i.test(line))
    .slice(-45).join('\n');
};
const wait = (test, message, timeout = 45_000) => browser.waitUntil(test,
  { timeout, interval: 250, timeoutMsg: message });

async function rpc(method, params = {}) {
  const result = await browser.executeAsync((name, values, done) => {
    window.__TAURI__.core.invoke('daemon_rpc', { method: name, params: values }).then(
      value => done({ ok: true, value }),
      error => done({ ok: false, reason: String(error?.message || error) }),
    );
  }, method, params);
  if (!result.ok) throw Error(`${method}: ${result.reason}`);
  return result.value;
}

async function store(action, args = []) {
  await browser.execute((name, values) => {
    window.__S4_STORE__ = null;
    Promise.resolve().then(() => window.__MAIL_STORE__.getState()[name](...values)).then(
      value => { window.__S4_STORE__ = { done: true, ok: true, id: value?.id || null }; },
      error => { window.__S4_STORE__ = { done: true, ok: false,
        reason: String(error?.message || error) }; },
    );
  }, action, args);
  const result = await wait(() => browser.execute(() => window.__S4_STORE__?.done && window.__S4_STORE__),
    `${action} did not settle`, 90_000);
  if (!result.ok) throw Error(`${action}: ${result.reason}`);
  return result.id;
}

async function cached() {
  const value = await rpc('load_email_cache', { accountId: A.id, mailbox: 'INBOX' });
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function withClient(server, task) {
  const client = new ImapFlow({ host: server.host, port: server.port, secure: false,
    auth: { user: A.email, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try { return await task(client); }
  finally { await client.logout(); }
}

async function watchReady() {
  await wait(async () => (await rpc('sync.watch_status')).some(row =>
    row.accountId === A.id && row.idling === true && !row.reason),
  'the native A watcher did not become idle');
}

// This observes only the shell boundary. Both IPC transports still call the
// original bridge and deliver the real native response to the app.
async function observeShell() {
  expect(await browser.execute(() => {
    const original = window.__TAURI__;
    const originalFetch = window.fetch;
    const originalStringify = JSON.stringify;
    const originalWarn = console.warn;
    const osURL = window.__TAURI_INTERNALS__.convertFileSrc('send_notification', 'ipc');
    const feed = [], os = [], routes = [], warnings = [];
    const invoke = (command, args) => {
      const poll = command === 'daemon_rpc' && args?.method === 'sync.events'
        ? { since: args?.params?.since ?? null } : null;
      if (poll) feed.push(poll);
      let route = null;
      if (command === 'daemon_rpc' && ['sync.refresh_status', 'sync.context', 'counts.unread'].includes(args?.method)) {
        route = { method: args.method, at: Date.now() };
      } else if (command === 'daemon_channel_notify' && args?.method === 'sync.owner') {
        route = { method: 'sync.owner', at: Date.now() };
      }
      if (route) routes.push(route);
      const answer = original.core.invoke(command, args);
      if (poll) Promise.resolve(answer).then(value => {
        poll.gen = value?.gen;
        poll.instanceId = value?.instanceId;
        poll.resyncRequired = value?.resyncRequired;
        poll.changes = value?.changes || [];
        poll.notifications = value?.notifications || [];
      }, error => { poll.error = String(error?.message || error); });
      if (route) Promise.resolve(answer).then(value => {
        route.result = { settled: true, instanceId: value?.instanceId,
          accepted: value?.accepted, revision: value?.revision,
          contextRevision: value?.contextRevision };
      }, error => { route.error = String(error?.message || error); });
      return answer;
    };
    window.fetch = function (resource, options) {
      const answer = originalFetch.call(this, resource, options);
      if (String(resource) !== osURL) return answer;
      const args = JSON.parse(options.body);
      return answer.then(response => {
        os.push({ args, ok: response.headers.get('Tauri-Response') === 'ok' });
        return response;
      });
    };
    JSON.stringify = function (value, ...rest) {
      if (value?.cmd === 'send_notification'
        && Number.isInteger(value.callback) && Number.isInteger(value.error)) {
        const callbacks = window.__TAURI_INTERNALS__.callbacks;
        for (const [id, ok] of [[value.callback, true], [value.error, false]]) {
          const callback = callbacks.get(id);
          if (callback) callbacks.set(id, answer => {
            os.push({ args: value.payload, ok, error: ok ? undefined : String(answer) });
            return callback(answer);
          });
        }
      }
      return originalStringify.call(this, value, ...rest);
    };
    console.warn = function (...parts) {
      if (String(parts[0]).startsWith('[scheduler] Native')) {
        warnings.push(parts.map(part => String(part)).join(' '));
      }
      return originalWarn.apply(this, parts);
    };
    window.__S4_ARRIVAL_OBSERVER__ = { original, originalFetch,
      originalStringify, originalWarn, feed, os, routes, warnings };
    window.__TAURI__ = { ...original, core: { ...original.core, invoke } };
    return window.__TAURI__.core.invoke === invoke;
  })).toBe(true);
}

const observed = () => browser.execute(id => {
  const trace = window.__S4_ARRIVAL_OBSERVER__;
  const state = window.__MAIL_STORE__.getState();
  const settings = window.__SETTINGS_STORE__.getState();
  const aRow = [...document.querySelectorAll('.sidebar-account-row')]
    .find(row => row.querySelector('.sidebar-account-open')?.title.includes('native-arrival@mock.test'));
  return { feed: trace.feed, os: trace.os, routes: trace.routes,
    warnings: trace.warnings, activeAccountId: state.activeAccountId,
    activeMailbox: state.activeMailbox, count: settings.unreadPerAccount[id],
    counts: { ...settings.unreadPerAccount },
    aBadge: aRow?.querySelector('.sidebar-unread-count')?.textContent || null,
    bubbleCode: document.querySelector('[data-testid="code-bubble-code"]')?.textContent || null };
}, A.id);

describe('Connected native arrival owner', function () {
  this.timeout(240_000);
  let server, account, B, uid, added = false, bCount;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await wait(() => browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive === true),
      'native daemon did not become healthy', 60_000);
    B = browser.mockAccounts[0];
    expect(B?.id).toBeTruthy();
    server = await startMockImap(scenario({ owner: A.email, inbox: 2,
      subjectPrefix: 'Arrival baseline', crossFolderThread: false, archiveCount: 0 }));
    account = mockAccount({ ...A, port: server.port, smtpPort: server.smtpPort });
    expect(await store('addAccount', [account])).toBe(A.id);
    added = true;
    await store('activateAccount', [A.id, 'INBOX']);
    await wait(async () => (await cached())?.emails?.length === 2,
      'native complete A baseline did not reach cache', 90_000);
    await wait(() => browser.execute(id =>
      window.__SETTINGS_STORE__.getState().unreadPerAccount[id] === 1, A.id),
      'A native unread baseline was not published', 90_000);
    await switchToFolder(B.email, 'INBOX');
    bCount = await browser.execute(id =>
      window.__SETTINGS_STORE__.getState().unreadPerAccount[id], B.id);
    expect(Number.isSafeInteger(bCount)).toBe(true);
    await watchReady();
    await observeShell();
  });

  after(async function () {
    try {
      await browser.execute(() => {
        const trace = window.__S4_ARRIVAL_OBSERVER__;
        if (trace) {
          window.__TAURI__ = trace.original;
          window.fetch = trace.originalFetch;
          JSON.stringify = trace.originalStringify;
          console.warn = trace.originalWarn;
        }
        delete window.__S4_ARRIVAL_OBSERVER__;
        delete window.__S4_STORE__;
      });
    } catch { /* app may already be closed */ }
    let removalFailure = null;
    if (added) {
      try {
        // A watcher round or arrival body child that is still finishing holds
        // the account for a moment; removal answers busy until it drains.
        for (let attempt = 0; ; attempt++) {
          try { await store('removeAccount', [A.id]); break; }
          catch (error) {
            if (attempt >= 4 || !String(error.message).includes('errors.accountRemovalBusy')) throw error;
            await browser.pause(2_000);
          }
        }
      }
      catch (error) {
        removalFailure = error;
        const [watchers, refresh] = await Promise.allSettled([
          rpc('sync.watch_status'), rpc('sync.refresh_status'),
        ]);
        console.warn('[native-arrival] account removal refused:', error.message,
          JSON.stringify({
            watchers: watchers.status === 'fulfilled'
              ? watchers.value.map(row => ({ accountId: row.accountId,
                idling: row.idling, reason: row.reason })) : String(watchers.reason),
            refresh: refresh.status === 'fulfilled'
              ? { automaticEnabled: refresh.value.automaticEnabled,
                receipts: refresh.value.receipts?.map(row => ({ requestId: row.requestId,
                  accountId: row.accountId, status: row.status })) }
              : String(refresh.reason),
          }));
      }
    }
    server?.stop();
    if (removalFailure) throw removalFailure;
  });

  it('delivers a real off-screen unique code once through native cache, feed and OS', async function () {
    expect((await visibleRowSubjects()).some(subject => subject.includes(SUBJECT))).toBe(false);
    const baselineGen = (await rpc('sync.events', { timeoutMs: 0 })).gen;
    uid = await withClient(server, async client => {
      const box = await client.mailboxOpen('INBOX');
      const next = box.uidNext;
      await client.append('INBOX', Buffer.from([
        'From: Acme <codes@acme.test>', `To: ${A.email}`, `Subject: ${SUBJECT}`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: ${MESSAGE_ID}`,
        'Content-Type: text/plain; charset=UTF-8', '', 'Your code is 364758.', '',
      ].join('\r\n')));
      return next;
    });
    expect(uid).toBeGreaterThan(0);
    // The watcher is the live producer; this is a real daemon reply and OS
    // boundary, not a canned sync answer or a hand-rendered bubble.
    await wait(async () => (await cached())?.emails?.some(row => row.uid === uid),
      'the actual arrival UID never entered native cache', 45_000);
    try {
      await wait(async () => (await observed()).os.some(call => call.ok &&
        call.args?.target?.accountId === A.id && call.args?.target?.uid === uid),
      'the native-prepared arrival never reached the real shell notification command');
    } catch (error) {
      const [feed, status] = await Promise.allSettled([
        rpc('sync.events', { since: baselineGen, timeoutMs: 0 }),
        rpc('sync.refresh_status'),
      ]);
      const nativeFeed = feed.status === 'fulfilled' ? {
        gen: feed.value.gen, instanceId: feed.value.instanceId,
        resyncRequired: feed.value.resyncRequired,
        changes: feed.value.changes?.map(row => ({ accountId: row.accountId,
          mailbox: row.mailbox, arrivalUids: row.arrivalUids,
          newEmails: row.newEmails, sourceRef: row.sourceRef })),
        notifications: feed.value.notifications?.map(row => ({ id: row.id,
          accountId: row.accountId, target: row.target, reason: row.reason })),
      } : String(feed.reason);
      const nativeStatus = status.status === 'fulfilled' ? {
        instanceId: status.value.instanceId,
        contextRevision: status.value.contextRevision,
        automaticEnabled: status.value.automaticEnabled,
      } : String(status.reason);
      throw Error(`${error.message}; observed=${JSON.stringify(await observed())}; nativeFeed=${JSON.stringify(nativeFeed)}; nativeStatus=${JSON.stringify(nativeStatus)}`);
    }
    const feedReply = await rpc('sync.events', { since: baselineGen, timeoutMs: 0 });
    expect(feedReply.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: A.id, mailbox: 'INBOX',
        arrivalUids: [uid], sourceRef: expect.any(String) }),
    ]));
    expect(feedReply.resyncRequired).toBe(false);
    await wait(async () => (await observed()).bubbleCode?.includes('364758'),
      'the code from the real arrival never reached the visible bubble');
    try {
      await wait(() => browser.executeAsync((id, u, done) =>
        window.__DB_PROBE__.isEmailSaved(id, 'INBOX', u).then(done, () => done(false)), A.id, uid),
      'the real arrival body never reached native vault');
    } catch (error) {
      throw Error(`${error.message}\n--- daemon.log (arrival account) ---\n${daemonLogTail()}`);
    }
    const first = await observed();
    expect(first).toMatchObject({ activeAccountId: B.id, activeMailbox: 'INBOX', count: 2 });
    expect(first.counts[B.id]).toBe(bCount);
    expect(first.aBadge).toBe('2');
    expect(first.os.filter(call => call.args?.target?.accountId === A.id
      && call.args?.target?.uid === uid)).toHaveLength(1);
    expect(first.os.find(call => call.args?.target?.uid === uid)?.args).toMatchObject({
      target: { accountId: A.id, mailbox: 'INBOX', uid, code: '364758' },
    });
    expect((await visibleRowSubjects()).some(subject => subject.includes(SUBJECT))).toBe(false);
    await store('refreshAllAccounts', [{ accountId: A.id, mailbox: 'INBOX' }]);
    const duplicate = await observed();
    expect(duplicate.os.filter(call => call.args?.target?.accountId === A.id
      && call.args?.target?.uid === uid)).toHaveLength(1);
    expect(duplicate.count).toBe(2);
    expect(duplicate.counts[B.id]).toBe(bCount);
    expect((await cached()).emails.some(row => row.uid === uid)).toBe(true);
  });

  it('repaints an off-screen real flags-only change without a second banner', async function () {
    const before = await observed();
    expect(before.count).toBe(2);
    await watchReady();
    const baselineGen = (await rpc('sync.events', { timeoutMs: 0 })).gen;
    await withClient(server, async client => {
      const lock = await client.getMailboxLock('INBOX');
      try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); }
      finally { lock.release(); }
    });
    await wait(async () => (await observed()).count === 1,
      'the off-screen native count did not reflect the flag');
    const feedReply = await rpc('sync.events', { since: baselineGen, timeoutMs: 0 });
    expect(feedReply.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: A.id, mailbox: 'INBOX',
        newEmails: 0, updatedFlags: expect.any(Number), sourceRef: expect.any(String) }),
    ]));
    expect(feedReply.changes.some(change => change.accountId === A.id
      && change.updatedFlags > 0 && change.newEmails === 0)).toBe(true);
    const after = await observed();
    expect(after.activeAccountId).toBe(B.id);
    expect(after.os.filter(call => call.args?.target?.accountId === A.id
      && call.args?.target?.uid === uid)).toHaveLength(1);
  });
  it('recovers a real lag signal without replaying a settled arrival banner', async function () {
    const before = await observed();
    const contextsBefore = before.routes.filter(route => route.method === 'sync.context').length;
    expect(before.count).toBe(1);
    expect(before.os.filter(call => call.args?.target?.accountId === A.id
      && call.args?.target?.uid === uid)).toHaveLength(1);
    const emitted = await browser.executeAsync(done =>
      window.__TAURI__.event.emit('daemon-events-lagged', {}).then(
        () => done(true), error => done(String(error?.message || error))));
    expect(emitted).toBe(true);
    await wait(async () => (await observed()).routes.filter(route =>
      route.method === 'sync.context').length > contextsBefore,
    'the live main-window channel did not resume context after lag', 60_000);
    const after = await observed();
    expect(after.count).toBe(1);
    expect(after.counts[B.id]).toBe(bCount);
    expect(after.activeAccountId).toBe(B.id);
    expect(after.os.filter(call => call.args?.target?.accountId === A.id
      && call.args?.target?.uid === uid)).toHaveLength(1);
    expect((await cached()).emails.some(row => row.uid === uid)).toBe(true);
  });

});
