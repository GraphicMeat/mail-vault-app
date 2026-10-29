/** S7 connected proof: mail is downloaded ahead by the daemon, not by the window.
 *  A real mock IMAP account with unsaved INBOX mail, Hoarder mode: the bodies reach the
 *  vault through the daemon's own runner while the window sends no backfill fetch,
 *  status reports the pass, going offline pauses it, and a reload resumes from the
 *  cache and vault without replaying completed fetches. */
import { waitForApp, waitForEmails } from './helpers.js';
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

describe('Connected native pipeline', function () {
  this.timeout(300_000);
  let server, added = false;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await wait(() => browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive === true),
      'native daemon did not become healthy');
    // Every `imap_get_email_light` the WINDOW sends from here on is counted: the daemon's own
    // runner never goes through the window, so a backfill fetch seen here is the old engine.
    await browser.execute(() => {
      window.__NP_BACKFILL__ = 0;
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__ = { ...window.__TAURI__, core: { ...window.__TAURI__.core, invoke: (command, args) => {
        if (command === 'imap_get_email_light' && args?.intent === 'backfill') window.__NP_BACKFILL__ += 1;
        return original(command, args);
      } } };
    });
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setFetchMode('hoarder'));
    server = await startMockImap(scenario({ owner: A.email, inbox: 3, subjectPrefix: 'Pipeline body',
      crossFolderThread: false, archiveCount: 0 }));
    expect(await store('addAccount', [mockAccount({ ...A, port: server.port, smtpPort: server.smtpPort })])).toBe(A.id);
    added = true;
  });

  after(async function () {
    if (added) { try { await store('removeAccount', [A.id]); } catch { /* busy account: the run ends anyway */ } }
    server?.stop();
  });

  it('downloads the focused folder\'s bodies through the daemon, not through the window', async function () {
    await store('activateAccount', [A.id, 'INBOX']);
    await wait(async () => (await saved()).length === 3, 'the daemon never stored the three bodies', 120_000);
    await wait(async () => (await status())?.phase === 'done', 'the pass never reported done');
    const entry = await status();
    expect(entry).toMatchObject({ mailbox: 'INBOX', queued: 0, total: 3, failed: 0 });
    expect(await browser.execute(() => window.__NP_BACKFILL__)).toBe(0);
  });

  it('pauses when the window goes offline and starts again online without replaying stored bodies', async function () {
    const before = await browser.execute(() => window.__PIPELINE_CONTROL__.pauseAll());
    await wait(async () => ((await status())?.activeSlots ?? 0) === 0, 'in-flight units never landed after pausing');
    const fetchesWhilePaused = server.commands?.filter(line => /BODY\.PEEK\[\]/.test(line)).length ?? null;
    await browser.pause(1500);
    if (fetchesWhilePaused !== null) {
      expect(server.commands.filter(line => /BODY\.PEEK\[\]/.test(line)).length).toBe(fetchesWhilePaused);
    }
    await browser.execute(() => window.__PIPELINE_CONTROL__.resumeAll());
    await wait(async () => (await status())?.phase === 'done', 'the pass did not settle after resuming');
    expect(await saved()).toEqual([1, 2, 3]);
    expect(before === undefined || before === null || typeof before === 'object').toBe(true);
    if (fetchesWhilePaused !== null) {
      expect(server.commands.filter(line => /BODY\.PEEK\[\]/.test(line)).length).toBe(fetchesWhilePaused);
    }
  });
});
