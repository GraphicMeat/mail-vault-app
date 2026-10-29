/** Fresh shell, real daemon/cache and a second IMAP client: off-screen unread. */
import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, pressKey } from './helpers.js';
import { startMockImap, mailbox, mockAccount, MOCK_PASSWORD } from './mockImap.js';

const A = { id: '53535353-5353-4535-8535-535353535353', email: 'unread-a@mock.test' };
const B = { id: '54545454-5454-4545-8545-545454545454', email: 'unread-b@mock.test' };
const C = { id: '56565656-5656-4565-8565-565656565656', email: 'unread-partial@mock.test' };

async function store(action, args = []) {
  await browser.execute((name, values) => {
    window.__S3_STORE_RESULT__ = null;
    window.__S3_ACTION__ = true;
    Promise.resolve().then(() => window.__MAIL_STORE__.getState()[name](...values)).then(
      value => { window.__S3_ACTION__ = false; window.__S3_STORE_RESULT__ = { done: true, ok: true, id: value?.id || null }; },
      failure => { window.__S3_ACTION__ = false; window.__S3_STORE_RESULT__ = { done: true, ok: false, reason: String(failure?.message || failure) }; },
    );
  }, action, args);
  const result = await browser.waitUntil(
    () => browser.execute(() => window.__S3_STORE_RESULT__?.done && window.__S3_STORE_RESULT__),
    { timeout: 90_000, interval: 300, timeoutMsg: `${action} did not settle` },
  );
  if (!result.ok) throw new Error(`${action} failed: ${result.reason}`);
  return result.id;
}

async function rpc(method, params) {
  const result = await browser.executeAsync((name, values, done) => {
    window.__TAURI__.core.invoke('daemon_rpc', { method: name, params: values }).then(
      value => done({ ok: true, value }),
      error => done({ ok: false, reason: String(error?.message || error) }),
    );
  }, method, params);
  if (!result.ok) throw new Error(`${method} failed: ${result.reason}`);
  return result.value;
}

// Match syncService.toSyncAccount's credential-free daemon shape using the
// account row the app actually saved. The daemon resolves the secret itself.
async function syncAccountFor(accountId) {
  const account = await browser.execute(id => {
    const row = window.__MAIL_STORE__.getState().accounts.find(item => item.id === id);
    if (!row) return null;
    return { id, email: row.email, imapConfig: {
      email: row.email,
      imapHost: row.imapHost, imapPort: row.imapPort,
      imapSecure: row.imapSecure, imapSecurity: row.imapSecurity,
      authType: row.authType,
      smtpHost: row.smtpHost, smtpPort: row.smtpPort,
      smtpSecure: row.smtpSecure, name: row.name,
      oauth2Transport: row.oauth2Transport,
      jmapSessionUrl: row.jmapSessionUrl, jmapAuth: row.jmapAuth,
      jmapUsername: row.jmapUsername,
    } };
  }, accountId);
  expect(account).toMatchObject({ id: accountId });
  expect(JSON.stringify(account)).not.toContain(MOCK_PASSWORD);
  return account;
}

async function syncNowAndWait(accountId) {
  const account = await syncAccountFor(accountId);
  const started = await rpc('sync.now', { account, mailbox: 'INBOX', autoClassify: false });
  const settled = await rpc('sync.wait', { ticket: started.ticket, timeoutMs: 30_000 });
  expect(settled.success).toBe(true);
  return settled;
}

async function runtimeDiagnostic(accountId) {
  const current = await snapshot();
  const watcher = (await rpc('sync.watch_status', {})).find(row => row.accountId === accountId) || null;
  const sync = (await rpc('sync.status', {})).find(row => row.account_id === accountId) || null;
  return { watcher, sync, counts: current.counts, countCalls: current.countCalls
    .filter(call => call.accountId === accountId), feedCalls: current.feedCalls };
}

async function waitForWatcherReady(accountId) {
  let watcher;
  await browser.waitUntil(async () => {
    const watchers = await rpc('sync.watch_status', {});
    const syncing = await rpc('sync.status', {});
    watcher = watchers.find(row => row.accountId === accountId);
    return watcher?.idling === true && !watcher.reason
      && syncing.every(row => row.status !== 'Syncing');
  }, { timeout: 45_000, interval: 300,
    timeoutMsg: `${accountId} watcher did not idle after active syncs settled` });
  return watcher;
}

async function refreshComplete(requestId) {
  const ack = await rpc('sync.refresh', { requestId, mailbox: 'INBOX', reason: 'manual' });
  expect(['queued', 'running']).toContain(ack.receipt.status);
  let receipt;
  await browser.waitUntil(async () => {
    receipt = (await rpc('sync.refresh_status', { requestId })).receipts?.[0];
    return receipt?.status === 'complete' || receipt?.status === 'failed';
  }, { timeout: 120_000, interval: 500, timeoutMsg: `${requestId} did not settle` });
  expect(receipt).toMatchObject({ requestId, status: 'complete' });
  return receipt;
}

async function expectPartialWindow(loaded, total) {
  const view = await browser.execute(() => {
    const mail = window.__MAIL_STORE__.getState();
    return { accountId: mail.activeAccountId, mailbox: mail.activeMailbox,
      loaded: mail.emails.length, total: mail.totalEmails };
  });
  expect(view).toMatchObject({ accountId: C.id, mailbox: 'INBOX', loaded, total });
  expect(view.loaded).toBeLessThan(view.total);
}

const snapshot = () => browser.execute((a, b) => {
  const mail = window.__MAIL_STORE__.getState();
  const settings = window.__SETTINGS_STORE__?.getState?.();
  const accountRow = email => [...document.querySelectorAll('.sidebar-account-row')]
    .find(row => row.querySelector('.sidebar-account-open')?.getAttribute('title')?.includes(email));
  return {
    activeAccountId: mail.activeAccountId,
    activeMailbox: mail.activeMailbox,
    complete: mail.serverUids?.complete === true,
    counts: { ...(settings?.unreadPerAccount || {}) },
    aBadge: accountRow(a.email)?.querySelector('.sidebar-unread-count')?.textContent || null,
    bBadge: accountRow(b.email)?.querySelector('.sidebar-unread-count')?.textContent || null,
    countCalls: (window.__S3_NATIVE_UNREAD__?.counts || []).map(call => ({ ...call })),
    feedCalls: (window.__S3_NATIVE_UNREAD__?.feed || []).slice(-16).map(call => ({ ...call })),
    osCalls: (window.__S3_NATIVE_UNREAD__?.os || []).map(call => ({ ...call })),
  };
}, A, B);

describe('Connected native unread projection', function () {
  this.timeout(420_000);
  let aServer;
  let bServer;
  let cServer;
  let aAccount;
  let bAccount;
  let cAccount;
  let originalSettings;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true,
    { timeout: 60_000, interval: 300, timeoutMsg: 'native daemon did not become healthy' });
    originalSettings = await browser.execute(() => {
      const state = window.__SETTINGS_STORE__.getState();
      return { hiddenAccounts: { ...state.hiddenAccounts }, displayNames: { ...state.displayNames },
        accountOrder: [...state.accountOrder] };
    });
    await browser.execute(() => {
      const original = window.__TAURI__;
      const originalCore = original.core.invoke;
      const counts = [];
      const feed = [];
      const os = [];
      const invoke = (command, args) => {
        const method = command === 'daemon_rpc' ? args?.method : null;
        const call = method === 'counts.unread' ? { op: args?.params?.op,
          accountId: args?.params?.accountId || null, done: false } : null;
        const feedCall = method === 'sync.events' ? {
          since: args?.params?.since ?? null, done: false } : null;
        if (call) counts.push(call);
        if (feedCall) feed.push(feedCall);
        const answer = originalCore(command, args);
        if (call) Promise.resolve(answer).then(value => { call.done = true;
          call.result = { counts: value?.counts, rows: value?.rows, total: value?.total, wrote: value?.wrote };
        }, error => { call.done = true; call.error = String(error?.message || error); });
        if (feedCall) Promise.resolve(answer).then(value => { feedCall.done = true;
          feedCall.gen = value?.gen ?? null;
          feedCall.changes = (value?.changes || []).map(change => ({ accountId: change.accountId,
            mailbox: change.mailbox, newEmails: change.newEmails, updatedFlags: change.updatedFlags }));
        }, error => { feedCall.done = true; feedCall.error = String(error?.message || error); });
        return answer;
      };
      window.__UNREAD_NATIVE_OBSERVER__ = (command, args) => {
        if (command === 'set_badge_count' || command === 'set_tray_accounts') os.push({ command,
          value: command === 'set_badge_count' ? args?.count : args?.accounts });
      };
      window.__TAURI__ = { ...original, core: { ...original.core, invoke } };
      if (window.__TAURI__.core.invoke !== invoke) throw new Error('native count bridge was not installed');
      window.__S3_NATIVE_UNREAD__ = { original, counts, feed, os };
    });
    aServer = await startMockImap({ state: { mailboxes: [mailbox('INBOX', 3,
      { owner: A.email, subjectPrefix: 'S3 A' })] }, faults: [] });
    bServer = await startMockImap({ state: { mailboxes: [mailbox('INBOX', 2,
      { owner: B.email, subjectPrefix: 'S3 B' })] }, faults: [] });
    aAccount = mockAccount({ ...A, port: aServer.port, smtpPort: aServer.smtpPort, name: 'Unread A' });
    bAccount = mockAccount({ ...B, port: bServer.port, smtpPort: bServer.smtpPort, name: 'Unread B' });
    expect(await store('addAccount', [aAccount])).toBe(A.id);
    expect(await store('addAccount', [bAccount])).toBe(B.id);
    await store('activateAccount', [A.id, 'INBOX']);
    await browser.waitUntil(async () => (await snapshot()).counts[A.id] === 2,
      { timeout: 90_000, interval: 300, timeoutMsg: 'A complete inbox did not publish native count 2' });
    await store('activateAccount', [B.id, 'INBOX']);
    await browser.waitUntil(async () => {
      const current = await snapshot();
      return current.activeAccountId === B.id && current.activeMailbox === 'INBOX'
        && current.complete && current.counts[B.id] === 1;
    }, { timeout: 90_000, interval: 300, timeoutMsg: 'B complete inbox did not publish native count 1' });
  });

  after(async function () {
    try { await browser.execute(() => window.__S3_PARTIAL_DRAIN__?.release()); }
    catch (error) { console.warn('[native-unread] drain release:', error.message); }
    if (originalSettings) {
      try { await browser.execute(settings => window.__SETTINGS_STORE__.setState(settings), originalSettings); }
      catch (error) { console.warn('[native-unread] settings restoration:', error.message); }
    }
    try {
      for (const row of (await rpc('snooze.list', {})).filter(row => row.accountId === A.id && row.state === 'snoozed')) {
        await rpc('snooze.cancel', { id: row.id });
      }
    } catch (error) { console.warn('[native-unread] snooze cleanup:', error.message); }
    for (const id of [C.id, A.id, B.id]) {
      try { await store('removeAccount', [id]); }
      catch (error) { console.warn('[native-unread] account removal:', error.message); }
    }
    try {
      await browser.execute(() => {
        const trace = window.__S3_NATIVE_UNREAD__;
        if (!trace) return;
        window.__TAURI__ = trace.original;
        delete window.__UNREAD_NATIVE_OBSERVER__;
        delete window.__S3_NATIVE_UNREAD__;
        delete window.__S3_STORE_RESULT__;
        delete window.__S3_PARTIAL_DRAIN__;
      });
    } catch (error) { console.warn('[native-unread] bridge restoration:', error.message); }
    aServer?.stop();
    bServer?.stop();
    cServer?.stop();
  });

  it('recounts an off-screen flag change from actual native cache and publishes sidebar and OS rows once', async function () {
    const before = await snapshot();
    expect(before.counts[A.id]).toBe(2);
    expect(before.counts[B.id]).toBe(1);
    // The IDLE watcher is the actual producer of sync.events. Require it
    // to be parked after active syncs settle before the second client writes.
    const watcherBefore = await waitForWatcherReady(A.id);
    const client = new ImapFlow({ host: aServer.host, port: aServer.port, secure: false,
      auth: { user: A.email, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try { await client.messageFlagsAdd(1, ['\\Seen'], { uid: true }); }
      finally { lock.release(); }
    } finally { await client.logout(); }

    let native;
    try {
      await browser.waitUntil(async () => {
        const current = await snapshot();
        native = current.countCalls.slice(before.countCalls.length)
          .find(call => call.op === 'recountCache' && call.accountId === A.id
            && call.done && call.result?.counts?.[A.id] === 1);
        return !!native && current.counts[A.id] === 1;
      }, { timeout: 150_000, interval: 500,
        timeoutMsg: 'off-screen A flag change did not reach counts.unread and settings' });
    } catch (error) {
      throw new Error(`${error.message}; source/feed diagnostic: ${JSON.stringify(await runtimeDiagnostic(A.id))}`);
    }
    expect((await rpc('sync.watch_status', {}))
      .find(row => row.accountId === A.id)?.wakeups).toBeGreaterThan(watcherBefore.wakeups);
    const cached = await rpc('load_email_cache_partial',
      { accountId: A.id, mailbox: 'INBOX', limit: 3 });
    const headers = typeof cached === 'string' ? JSON.parse(cached) : cached;
    expect(headers.error).toBeUndefined();
    expect(headers.emails.find(row => row.uid === 1).flags).toContain('\\Seen');
    await browser.waitUntil(async () => {
      const current = await snapshot();
      const tray = current.osCalls.filter(call => call.command === 'set_tray_accounts').at(-1)?.value;
      const badge = current.osCalls.filter(call => call.command === 'set_badge_count').at(-1)?.value;
      return current.aBadge === '1' && current.bBadge === '1'
        && tray?.find(row => row.id === A.id)?.unread === 1
        && tray?.find(row => row.id === B.id)?.unread === 1
        && badge === native.result.total;
    }, { timeout: 45_000, interval: 300,
      timeoutMsg: 'native rows and total did not reach the sidebar, tray and dock badge' });
    const current = await snapshot();
    expect(current.activeAccountId).toBe(B.id);
    expect(current.activeMailbox).toBe('INBOX');
    expect(current.counts[B.id]).toBe(1);
    expect(native.result.rows.find(row => row.id === A.id)).toMatchObject({ unread: 1 });
    expect(native.result.rows.find(row => row.id === B.id)).toMatchObject({ unread: 1 });
    expect(native.result.total).toBe(native.result.rows.reduce((sum, row) => sum + row.unread, 0));
    await syncNowAndWait(A.id);
    const unchanged = await snapshot();
    expect(unchanged.counts[A.id]).toBe(1);
    expect(unchanged.counts[B.id]).toBe(1);
  });

  it('recounts a real snooze and wake through the existing UI and daemon row', async function () {
    await store('activateAccount', [A.id, 'INBOX']);
    await browser.waitUntil(async () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"]')]
        .some(row => (row.textContent || '').includes('S3 A 3'))),
    { timeout: 30_000, interval: 300, timeoutMsg: 'A unread row did not appear for snooze' });
    await browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(row => (row.textContent || '').includes('S3 A 3'));
      row.click();
    });
    await browser.waitUntil(async () => browser.execute(() =>
      window.__MAIL_STORE__.getState().selectedEmailId === 3),
    { timeout: 10_000, interval: 200, timeoutMsg: 'A unread row was not selected' });
    await pressKey('b');
    await browser.waitUntil(async () => browser.execute(() =>
      !!document.querySelector('[data-testid="snooze-preset-nextWeek"]')),
    { timeout: 10_000, interval: 200, timeoutMsg: 'snooze picker did not open' });
    await browser.execute(() => document.querySelector('[data-testid="snooze-preset-nextWeek"]').click());
    let snooze;
    await browser.waitUntil(async () => {
      snooze = (await rpc('snooze.list', {})).find(row => row.accountId === A.id && row.state === 'snoozed');
      return !!snooze;
    }, { timeout: 30_000, interval: 300, timeoutMsg: 'real snooze row was not recorded' });
    await browser.waitUntil(async () => (await snapshot()).counts[A.id] === 0,
      { timeout: 45_000, interval: 300, timeoutMsg: 'native unread did not remove the snoozed A row' });
    expect((await snapshot()).counts[B.id]).toBe(1);
    await rpc('snooze.cancel', { id: snooze.id });
    await browser.waitUntil(async () => (await snapshot()).counts[A.id] === 1,
      { timeout: 60_000, interval: 500, timeoutMsg: 'native unread did not restore A after snooze cancel' });
  });

  it('orders local read, unread, delete and undo from a genuinely partial visible inbox', async function () {
    // Hold only background list pagination. Native sync, count replies and
    // message mutations still run normally; this keeps the actual 500-row
    // visible window open long enough to exercise all four local actions.
    await browser.execute(() => {
      const mail = window.__MAIL_STORE__;
      const original = mail.getState().loadMoreEmails;
      const originalLoad = mail.getState().loadEmails;
      let resume;
      let resumeRepaint;
      let heldRepaint;
      let passiveLoads = 0;
      let actionLoads = 0;
      let holdDeleteReload = false;
      const loadCalls = [];
      const heldCalls = [];
      const record = (kind, opts) => {
        const call = { kind, opts: opts ?? null, before: mail.getState().emails.length,
          stack: String(new Error().stack || '').split('\n').slice(1, 5) };
        loadCalls.push(call);
        if (loadCalls.length > 32) loadCalls.shift();
        return call;
      };
      const observe = (call, result) => {
        Promise.resolve(result).then(
          () => { call.done = true; call.after = mail.getState().emails.length; },
          error => { call.done = true; call.error = String(error?.message || error); },
        );
        return result;
      };
      const held = new Promise(resolve => { resume = resolve; });
      mail.setState({ loadMoreEmails: (...args) => {
        const call = record('loadMoreEmails', args);
        call.held = true;
        heldCalls.push(call);
        return observe(call, held.then(() => original(...args)));
      } });
      window.__S3_PARTIAL_DRAIN__ = {
        get passiveLoads() { return passiveLoads; },
        get actionLoads() { return actionLoads; },
        get loadCalls() { return loadCalls; },
        get replayStatus() { return { queued: heldCalls.length, done: heldCalls.filter(call => call.done).length,
          errors: heldCalls.filter(call => call.error).map(call => call.error),
          restored: mail.getState().loadMoreEmails === original && mail.getState().loadEmails === originalLoad }; },
        holdDeleteReload() { holdDeleteReload = true; },
        stopDeleteReload() { holdDeleteReload = false; },
        holdPassiveRepaint() {
          if (heldRepaint) return;
          heldRepaint = new Promise(resolve => { resumeRepaint = resolve; });
          mail.setState({ loadEmails: opts => {
            const call = record('loadEmails', opts);
            // The scheduler calls this for both flag-only and ordinary feed
            // replies. Its caller, rather than the options, identifies a
            // passive repaint; explicit action loads keep their real workflow.
            // The hook no longer sits in its own chunk (snoozeStore stopped
            // importing it lazily), so the stack cannot name it. A load made
            // while no spec-driven store action is running is a passive one.
            const schedulerCall = opts?.rereadFlags === true || window.__S3_ACTION__ !== true
              || call.stack.some(line => /useEmailScheduler(?:-|\.)/.test(line));
            call.scheduler = schedulerCall;
            // applyServerRemoval fires a list reload without awaiting it. Keep
            // that repaint queued during this one delete, while its network,
            // custody and native count work completes. Undo's awaited reload
            // path, if used, remains live.
            const deleteRepaint = !schedulerCall && holdDeleteReload && opts == null;
            call.deleteRepaint = deleteRepaint;
            if (!schedulerCall && !deleteRepaint) return observe(call, originalLoad(opts));
            if (schedulerCall) passiveLoads += 1;
            else actionLoads += 1;
            call.held = true;
            heldCalls.push(call);
            return observe(call, heldRepaint.then(() => originalLoad(opts)));
          } });
        },
        release() {
          if (!resume && !resumeRepaint) return;
          mail.setState({ loadMoreEmails: original, loadEmails: originalLoad });
          resume?.();
          resumeRepaint?.();
          resume = null;
          resumeRepaint = null;
        },
      };
    });
    let completedActions = false;
    let actionFailure;
    let replayFailure;
    try {
      cServer = await startMockImap({ state: { mailboxes: [
        mailbox('INBOX', 501, { owner: C.email, subjectPrefix: 'S3 partial' }),
        mailbox('Trash', 0, { owner: C.email, attrs: ['\\Trash'] }),
      ] }, faults: [] });
      cAccount = mockAccount({ ...C, port: cServer.port, smtpPort: cServer.smtpPort, name: 'Partial C' });
      expect(await store('addAccount', [cAccount])).toBe(C.id);
      await store('activateAccount', [C.id, 'INBOX']);
      await browser.waitUntil(async () => browser.execute(id => {
        const mail = window.__MAIL_STORE__.getState();
        return mail.activeAccountId === id && mail.activeMailbox === 'INBOX'
          && mail.totalEmails === 501 && mail.emails.length === 500
          && mail.emails.some(row => row.uid === 501);
      }, C.id), { timeout: 120_000, interval: 500,
        timeoutMsg: 'C never held a real 500-of-501 visible INBOX window' });
      const complete = await refreshComplete('native-unread-partial-c-complete');
      expect(complete.accountResults).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: C.id, mailbox: 'INBOX', success: true }),
      ]));
      await expectPartialWindow(500, 501);
      const completeCacheRaw = await rpc('load_email_cache_partial',
        { accountId: C.id, mailbox: 'INBOX', limit: 501 });
      const completeCache = typeof completeCacheRaw === 'string'
        ? JSON.parse(completeCacheRaw) : completeCacheRaw;
      expect(completeCache.totalEmails).toBe(501);
      expect(completeCache.emails).toHaveLength(501);
      expect(completeCache.emails.some(row => row.uid === 501)).toBe(true);
      // A direct native Complete fills the cache but does not itself submit a
      // renderer recount. Change a real flag without changing unread status:
      // the existing scheduler feed then recounts that complete native cache.
      const watcherBefore = await waitForWatcherReady(C.id);
      await browser.execute(() => window.__S3_PARTIAL_DRAIN__.holdPassiveRepaint());
      const client = new ImapFlow({ host: cServer.host, port: cServer.port, secure: false,
        auth: { user: C.email, pass: MOCK_PASSWORD }, logger: false });
      await client.connect();
      try {
        const lock = await client.getMailboxLock('INBOX');
        try { await client.messageFlagsAdd(501, ['\\Flagged'], { uid: true }); }
        finally { lock.release(); }
      } finally { await client.logout(); }
      let lastPartialState;
      try {
        await browser.waitUntil(async () => {
          lastPartialState = await browser.execute(id => {
            const mail = window.__MAIL_STORE__.getState();
            const counts = window.__SETTINGS_STORE__.getState().unreadPerAccount;
            const calls = (window.__S3_NATIVE_UNREAD__?.counts || [])
              .filter(call => call.accountId === id && call.op === 'recountCache');
            return { activeAccountId: mail.activeAccountId, activeMailbox: mail.activeMailbox,
              loaded: mail.emails.length, total: mail.totalEmails,
              newestVisible: mail.emails.some(row => row.uid === 501), count: counts[id] ?? null,
              recounts: calls.map(call => ({ done: call.done, result: call.result, error: call.error })) };
          }, C.id);
          return lastPartialState.activeAccountId === C.id && lastPartialState.activeMailbox === 'INBOX'
            && lastPartialState.total === 501 && lastPartialState.loaded === 500
            && lastPartialState.newestVisible && lastPartialState.count === 251
            && lastPartialState.recounts.some(call => call.done && call.result?.counts?.[C.id] === 251);
        }, { timeout: 120_000, interval: 500,
          timeoutMsg: 'C never held a real 500-of-501 visible INBOX window and native count 251' });
      } catch (error) {
        throw new Error(`${error.message}; last partial state: ${JSON.stringify(lastPartialState)}; source/feed diagnostic: ${JSON.stringify(await runtimeDiagnostic(C.id))}; list loads: ${JSON.stringify(await browser.execute(() => (window.__S3_PARTIAL_DRAIN__?.loadCalls || []).map(call => ({ kind: call.kind, opts: call.opts, scheduler: call.scheduler, held: call.held, before: call.before, after: call.after, stack: call.stack }))))}`);
      }
      expect((await rpc('sync.watch_status', {}))
        .find(row => row.accountId === C.id)?.wakeups).toBeGreaterThan(watcherBefore.wakeups);
      await browser.waitUntil(async () => browser.execute(() =>
        window.__S3_PARTIAL_DRAIN__?.passiveLoads > 0),
      { timeout: 15_000, interval: 200,
        timeoutMsg: 'real scheduler flags repaint did not reach the passive load gate' });
      // Any list load outside a spec action counts as passive, so the held
      // repaint alone proves nothing: the daemon's change feed must also have
      // reported this account's flag change, and a held load must carry
      // `rereadFlags` (only the feed and the refresh repaint pass it).
      const heldFlagsRepaint = await browser.execute(() =>
        (window.__S3_PARTIAL_DRAIN__?.loadCalls || []).some(call => call.held
          && call.kind === 'loadEmails' && call.opts?.rereadFlags === true));
      expect(heldFlagsRepaint).toBe(true);
      expect((await snapshot()).feedCalls.some(call => call.changes?.some(change =>
        change.accountId === C.id && change.updatedFlags > 0))).toBe(true);
      await expectPartialWindow(500, 501);
      await store('markEmailReadStatus', [501, true]);
      await browser.waitUntil(async () => (await snapshot()).counts[C.id] === 250,
        { timeout: 30_000, interval: 250, timeoutMsg: 'partial-list read did not shift native count to 250' });
      try { await expectPartialWindow(500, 501); }
      catch (error) {
        const calls = await browser.execute(() => window.__S3_PARTIAL_DRAIN__?.loadCalls || []);
        throw new Error(`${error.message}; real list load calls: ${JSON.stringify(calls)}`);
      }
      await store('markEmailReadStatus', [501, false]);
      await browser.waitUntil(async () => (await snapshot()).counts[C.id] === 251,
        { timeout: 30_000, interval: 250, timeoutMsg: 'partial-list unread did not shift native count to 251' });
      await expectPartialWindow(500, 501);
      await browser.execute(() => window.__S3_PARTIAL_DRAIN__.holdDeleteReload());
      await store('deleteEmailFromServer', [501]);
      await browser.waitUntil(async () => browser.execute(() =>
        window.__S3_PARTIAL_DRAIN__?.actionLoads > 0),
      { timeout: 10_000, interval: 200,
        timeoutMsg: 'the real fire-and-forget delete repaint did not reach its bounded gate' });
      await browser.execute(() => window.__S3_PARTIAL_DRAIN__.stopDeleteReload());
      await browser.waitUntil(async () => (await snapshot()).counts[C.id] === 250,
        { timeout: 45_000, interval: 300, timeoutMsg: 'partial-list delete did not shift native count to 250' });
      await expectPartialWindow(499, 500);
      await store('runUndo');
      await browser.waitUntil(async () => (await snapshot()).counts[C.id] === 251,
        { timeout: 60_000, interval: 300, timeoutMsg: 'partial-list undo did not restore native count 251' });
      await expectPartialWindow(500, 501);
      expect((await snapshot()).counts[B.id]).toBe(1);
      completedActions = true;
    } catch (error) {
      actionFailure = error;
    } finally {
      try {
        await browser.execute(() => window.__S3_PARTIAL_DRAIN__?.release());
        const queued = await browser.execute(() => window.__S3_PARTIAL_DRAIN__?.replayStatus?.queued || 0);
        if (queued > 0) await browser.waitUntil(async () => browser.execute(() => {
          const status = window.__S3_PARTIAL_DRAIN__?.replayStatus;
          return status && status.restored && status.done === status.queued && status.errors.length === 0;
        }), { timeout: 60_000, interval: 300,
          timeoutMsg: 'held real list repaints did not all replay after gate release' });
        else if (completedActions) throw new Error('partial window ran without a held real list repaint');
      } catch (error) {
        replayFailure = error;
      }
    }
    if (actionFailure && replayFailure) throw new Error(
      `action failure: ${actionFailure.stack || actionFailure}\nreplay failure: ${replayFailure.stack || replayFailure}`);
    if (actionFailure) throw actionFailure;
    if (replayFailure) throw replayFailure;
  });

  it('uses current hidden, label and order settings for native tray rows and total', async function () {
    const before = await snapshot();
    await browser.execute((a, b) => {
      const settings = window.__SETTINGS_STORE__.getState();
      settings.setDisplayName(b, 'Named B');
      settings.setAccountOrder([b, a]);
      settings.setAccountHidden(a, true);
    }, A.id, B.id);
    let answer;
    await browser.waitUntil(async () => {
      const current = await snapshot();
      answer = current.countCalls.slice(before.countCalls.length)
        .filter(call => call.op === 'rows' && call.done && call.result?.rows)
        .at(-1)?.result;
      const tray = current.osCalls.filter(call => call.command === 'set_tray_accounts').at(-1)?.value;
      const badge = current.osCalls.filter(call => call.command === 'set_badge_count').at(-1)?.value;
      return answer && !answer.rows.some(row => row.id === A.id)
        && answer.rows.find(row => row.id === B.id)?.label === 'Named B'
        && tray?.find(row => row.id === B.id)?.label === 'Named B'
        && !tray.some(row => row.id === A.id)
        && badge === answer.total;
    }, { timeout: 45_000, interval: 300,
      timeoutMsg: 'current hidden, label and order observations did not reach native tray and badge' });
    expect(answer.rows[0].id).toBe(B.id);
    expect(answer.total).toBe(answer.rows.reduce((sum, row) => sum + row.unread, 0));
    expect((await snapshot()).counts[A.id]).toBe(1,
      'hiding an account changes presentation, not the retained count projection');
  });
});
