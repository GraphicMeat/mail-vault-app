/** S7 connected proof: mail is downloaded ahead by the daemon, not by the window.
 *  A real mock IMAP account with unsaved INBOX mail: while the window reports offline the
 *  daemon derives the candidates and fetches nothing; online, the bodies reach the vault
 *  through the daemon's own runner while the window sends no backfill fetch, status reports
 *  the pass, and a reload resumes from the cache and vault without replaying a fetch.
 *  What reached the server is counted from the mock's own command log; what the window
 *  sent is counted at its invoke bridge, with a positive control that proves the counter
 *  can see a backfill call at all. */
import { waitForApp, waitForEmails, reloadApp } from './helpers.js';
import { startMockImap, scenario, mockAccount } from './mockImap.js';

const A = { id: '60606060-6060-4606-8606-606060606060', email: 'native-pipeline@mock.test' };
const wait = (test, message, timeout = 60_000) => browser.waitUntil(test,
  { timeout, interval: 300, timeoutMsg: message });

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
    window.__NP_STORE__ = null;
    Promise.resolve().then(() => window.__MAIL_STORE__.getState()[name](...values)).then(
      value => { window.__NP_STORE__ = { done: true, ok: true, id: value?.id || null }; },
      error => { window.__NP_STORE__ = { done: true, ok: false, reason: String(error?.message || error) }; },
    );
  }, action, args);
  const result = await wait(() => browser.execute(() => window.__NP_STORE__?.done && window.__NP_STORE__),
    `${action} did not settle`, 90_000);
  if (!result.ok) throw Error(`${action}: ${result.reason}`);
  return result.id;
}

const saved = () => browser.executeAsync((id, done) => {
  const probe = window.__DB_PROBE__;
  Promise.all([1, 2, 3].map(uid => probe.isEmailSaved(id, 'INBOX', uid).catch(() => false)))
    .then(flags => done(flags.map((flag, index) => (flag ? index + 1 : 0)).filter(Boolean)));
}, A.id);

const status = async () => (await rpc('pipeline.status')).accounts?.[A.id] || null;

/** Body downloads the SERVER received: `UID FETCH n (... BODY.PEEK[])`. Header reads name a section. */
const bodyFetches = server => server.commands.filter(line => /BODY\.PEEK\[\]/.test(line)).length;

/** A window call that asks for a backfill fetch goes out as `daemon_rpc` with the method and intent in its arguments. */
const installBackfillCounter = () => browser.execute(() => {
  window.__NP_BACKFILL__ = 0;
  const original = window.__TAURI__.core.invoke;
  window.__TAURI__ = { ...window.__TAURI__, core: { ...window.__TAURI__.core, invoke: (command, args) => {
    if (command === 'daemon_rpc' && args?.method === 'imap_get_email_light' && args?.params?.intent === 'backfill') {
      window.__NP_BACKFILL__ += 1;
    }
    return original(command, args);
  } } };
});
const backfillsSent = () => browser.execute(() => window.__NP_BACKFILL__);
const healthy = () => wait(() => browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive === true),
  'native daemon did not become healthy');

describe('Connected native pipeline', function () {
  this.timeout(300_000);
  let server, added = false;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await healthy();
    await installBackfillCounter();
    // Positive control: a backfill call IS counted. Without it, "zero" below could mean "blind".
    await browser.executeAsync(done => {
      window.__TAURI__.core.invoke('daemon_rpc', { method: 'imap_get_email_light',
        params: { accountId: '00000000-0000-4000-8000-000000000000', mailbox: 'INBOX', uid: 1, intent: 'backfill' } })
        .then(() => done(true), () => done(false));
    });
    expect(await backfillsSent()).toBe(1);
    await browser.execute(() => { window.__NP_BACKFILL__ = 0; });
    // Keep every message: the fixture's mail is dated January, outside the default three-month window.
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setLocalCacheDurationMonths(0));
    server = await startMockImap(scenario({ owner: A.email, inbox: 3, subjectPrefix: 'Pipeline body',
      crossFolderThread: false, archiveCount: 0 }), { logCommands: true });
    expect(await store('addAccount', [mockAccount({ ...A, port: server.port, smtpPort: server.smtpPort })])).toBe(A.id);
    added = true;
  });

  after(async function () {
    if (added) { try { await store('removeAccount', [A.id]); } catch { /* busy account: the run ends anyway */ } }
    server?.stop();
  });

  it('derives the focused folder while the window is offline and fetches nothing until it is online', async function () {
    await browser.execute(() => window.__PIPELINE_CONTROL__.pauseAll());
    await store('activateAccount', [A.id, 'INBOX']);
    await wait(async () => { const entry = await status(); return entry?.pausedReason === 'offline' && entry.queued === 3; },
      'the daemon never derived the three candidates while the window was offline');
    await browser.pause(2000);
    expect(await status()).toMatchObject({ phase: 'content', queued: 3, total: 3, completed: 0, pausedReason: 'offline', activeSlots: 0 });
    // the server received a body fetch while offline
    expect(bodyFetches(server)).toBe(0);
    expect(await saved()).toEqual([]);

    await browser.execute(() => window.__PIPELINE_CONTROL__.resumeAll());
    await wait(async () => (await saved()).length === 3, 'the daemon never stored the three bodies', 120_000);
    await wait(async () => (await status())?.phase === 'done', 'the pass never reported done');
    expect(await status()).toMatchObject({ mailbox: 'INBOX', queued: 0, total: 3, failed: 0 });
    // each body was downloaded exactly once
    expect(bodyFetches(server)).toBe(3);
    // the window sent no backfill fetch
    expect(await backfillsSent()).toBe(0);
  });

  it('a reload resumes from the cache and vault without replaying a completed fetch', async function () {
    const revision = (await rpc('pipeline.status')).revision;
    const fetched = bodyFetches(server);
    await reloadApp();
    await healthy();
    await installBackfillCounter();
    await store('activateAccount', [A.id, 'INBOX']);
    await wait(async () => (await rpc('pipeline.status')).revision > revision && (await status())?.phase === 'done',
      'the reloaded window never reported its view to the daemon');
    await browser.pause(2000);
    // nothing is left to download: the vault already holds all three
    expect(await status()).toMatchObject({ queued: 0, total: 0, failed: 0 });
    expect(await saved()).toEqual([1, 2, 3]);
    // the reload replayed a completed fetch
    expect(bodyFetches(server)).toBe(fetched);
    expect(await backfillsSent()).toBe(0);
  });
});
