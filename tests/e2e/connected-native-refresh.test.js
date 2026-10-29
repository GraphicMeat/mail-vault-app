/** S2 connected proof: real shell bridge, daemon receipt, and mock IMAP cache. */
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails } from './helpers.js';
import { startMockImap, scenario, mockAccount, MOCK_PASSWORD, slowCommand } from './mockImap.js';

const OWNER = 'native-refresh@mock.test';
const ID = '52525252-5252-4525-8525-525252525252';
const SUBJECT = 'Native refresh actual appended delivery';
let base = 0;

async function rpc(method, params = {}) {
  const reply = await browser.executeAsync((name, values, done) => {
    window.__TAURI__.core.invoke('daemon_rpc', { method: name, params: values }).then(
      value => done({ ok: true, value }),
      failure => done({ ok: false, reason: String(failure?.message || failure) }),
    );
  }, method, params);
  if (!reply?.ok) throw new Error(`${method} failed: ${JSON.stringify(reply)}`);
  return reply.value;
}

async function store(action, args = []) {
  await browser.execute((name, values) => {
    window.__NATIVE_REFRESH_STORE__ = null;
    Promise.resolve().then(() => window.__MAIL_STORE__.getState()[name](...values)).then(
      value => { window.__NATIVE_REFRESH_STORE__ = { done: true, ok: true, id: value?.id || null }; },
      failure => { window.__NATIVE_REFRESH_STORE__ = { done: true, ok: false,
        reason: String(failure?.message || failure) }; },
    );
  }, action, args);
  const result = await browser.waitUntil(
    () => browser.execute(() => window.__NATIVE_REFRESH_STORE__?.done && window.__NATIVE_REFRESH_STORE__),
    { timeout: 90_000, interval: 250, timeoutMsg: `${action} did not settle` },
  );
  if (!result.ok) throw new Error(`${action} failed: ${result.reason}`);
  return result.id;
}

function endpoint(home) {
  const ipc = join(home, '.mailvault');
  if (process.platform !== 'win32') return join(ipc, 'mv.sock');
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(ipc.toLowerCase())) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `\\\\.\\pipe\\mailvault-${hash.toString(16).padStart(16, '0')}`;
}

async function openOwner(launchId, revision) {
  const home = browser.testDataDir;
  const token = readFileSync(join(home, '.mailvault', 'mv.token'), 'utf8').trim();
  const socket = createConnection(endpoint(home));
  let buffer = '';
  const queued = [];
  const waiters = [];
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const row = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(row); else queued.push(row);
    }
  });
  const next = () => queued.length ? Promise.resolve(queued.shift())
    : Promise.race([
      new Promise(resolve => waiters.push(resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('owner socket timed out')), 5000)),
    ]);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(`${JSON.stringify({ token })}\n`);
  expect((await next()).result?.authenticated).toBe(true);
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'channel.open', id: 1,
    params: { syncOwner: { launchId, revision } } })}\n`);
  expect((await next()).result?.channel).toBe(true);
  return { close: () => socket.destroy() };
}

async function cached(mailbox) {
  const raw = await rpc('load_email_cache', { accountId: ID, mailbox });
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function terminal(requestId) {
  let receipt;
  await browser.waitUntil(async () => {
    const status = await rpc('sync.refresh_status', { requestId });
    receipt = status.receipts?.[0];
    return status.found === true && ['complete', 'failed'].includes(receipt?.status);
  }, { timeout: 90_000, interval: 250, timeoutMsg: `${requestId} did not settle` });
  return receipt;
}

async function appendDelivery(server) {
  const client = new ImapFlow({ host: server.host, port: server.port, secure: false,
    auth: { user: OWNER, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try {
    const { uidNext } = await client.mailboxOpen('INBOX');
    const raw = [
      'From: Native Sender <sender@mock.test>', `To: ${OWNER}`, `Subject: ${SUBJECT}`,
      'Date: Tue, 20 Oct 2026 10:00:00 +0000',
      `Message-ID: <native-refresh-${uidNext}@mock.test>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', 'Real appended body', '',
    ].join('\r\n');
    await client.append('INBOX', raw);
    return uidNext;
  } finally { await client.logout(); }
}

describe('Connected native refresh foundation', function () {
  this.timeout(240_000);
  let server;
  let owner;
  let added = false;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(async () => (await browser.execute(() =>
      window.__DB_PROBE__?.daemonHealth?.().alive)) === true,
    { timeout: 60_000, interval: 250, timeoutMsg: 'daemon did not become healthy' });
    const fixture = scenario({ owner: OWNER, inbox: 2, subjectPrefix: 'Native refresh seed',
      faults: [slowCommand('FETCH', 2500)],
      nestedMailboxes: ['Projects', 'Projects/Child'] });
    fixture.state.capabilities = ['IMAP4rev1', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'SPECIAL-USE'];
    server = await startMockImap(fixture);
    expect(await store('addAccount', [mockAccount({
      id: ID, email: OWNER, port: server.port, smtpPort: server.smtpPort,
    })])).toBe(ID);
    added = true;
    await store('activateAccount', [ID, 'INBOX']);
    await browser.waitUntil(async () => (await cached('INBOX'))?.emails?.length >= 2,
      { timeout: 90_000, interval: 250, timeoutMsg: 'real initial INBOX cache never appeared' });
  });

  after(async function () {
    owner?.close();
    if (added) {
      try { await store('removeAccount', [ID]); }
      catch (failure) { console.warn('[native-refresh] account removal:', failure.message); }
    }
    try { await browser.execute(() => { delete window.__NATIVE_REFRESH_STORE__; }); } catch { /* closed */ }
    server?.stop();
  });

  it('completes a real delivery after an external owner detaches from the app-owned context', async function () {
    // Since S4 the app attaches its own sync context at boot, so ordinary boot
    // is no longer dormant. The external owner below takes over above the app's
    // live revision, then the same detach and delivery checks run unchanged.
    const boot = await rpc('sync.refresh_status');
    expect(Number.isSafeInteger(boot.contextRevision)).toBe(true);
    base = boot.contextRevision + 100;
    owner = await openOwner('native-mini-launch', base + 1);
    expect((await rpc('sync.context', { launchId: 'native-mini-launch', revision: base + 1,
      phase: 'resume', view: { accountId: ID, mailbox: 'INBOX' } })).accepted).toBe(true);
    const uid = await appendDelivery(server);
    const requestId = 'native-mini-actual-delivery';
    const ack = await rpc('sync.refresh', { requestId, accountId: ID, mailbox: 'INBOX', reason: 'manual' });
    expect(['queued', 'running']).toContain(ack.receipt.status);
    expect((await rpc('sync.refresh_status', { requestId })).receipts[0].status)
      .toMatch(/^(queued|running)$/);
    owner.close();
    owner = null;
    const settled = await terminal(requestId);
    expect(settled).toMatchObject({ requestId, status: 'complete' });
    expect(settled.accountResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: ID, mailbox: 'INBOX', success: true }),
    ]));
    const headers = await cached('INBOX');
    expect(headers.emails).toEqual(expect.arrayContaining([
      expect.objectContaining({ uid, subject: SUBJECT }),
    ]));
    expect((await rpc('sync.refresh', { requestId, accountId: ID, mailbox: 'INBOX', reason: 'manual' })).receipt)
      .toEqual(settled);
    expect((await cached('INBOX')).emails).toEqual(headers.emails);
  });

  it('resolves unified Sent and subtree paths from a new channel generation', async function () {
    owner = await openOwner('native-mini-launch', base + 2);
    expect((await rpc('sync.refresh_status', { requestId: 'native-mini-actual-delivery' }))
      .receipts[0].status).toBe('complete');
    expect((await rpc('sync.context', { launchId: 'native-mini-launch', revision: base + 2,
      phase: 'resume', view: { accountId: null, mailbox: 'UNIFIED', unifiedFolder: 'Sent' } })).accepted)
      .toBe(true);
    const unified = await rpc('sync.refresh', { requestId: 'native-mini-unified', accountId: ID, mailbox: 'UNIFIED',
      reason: 'manual' });
    expect(unified.receipt.accountResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: ID, mailbox: 'Sent' }),
    ]));
    expect((await terminal('native-mini-unified')).status).toBe('complete');
    expect((await cached('Sent'))?.emails?.length).toBeGreaterThan(0);
    expect(await cached('UNIFIED')).toBeNull();
    expect((await rpc('sync.context', { launchId: 'native-mini-launch', revision: base + 3,
      phase: 'resume', view: { accountId: ID, mailbox: 'Projects',
        scopePaths: ['Projects', 'Projects/Child'] } })).accepted).toBe(true);
    const subtree = await rpc('sync.refresh', { requestId: 'native-mini-subtree', accountId: ID,
      reason: 'manual' });
    expect(subtree.receipt.accountResults.map(row => row.mailbox))
      .toEqual(['Projects', 'Projects/Child']);
    expect((await terminal('native-mini-subtree')).status).toBe('complete');
    expect((await cached('Projects'))?.emails?.length).toBeGreaterThan(0);
    expect((await cached('Projects/Child'))?.emails?.length).toBeGreaterThan(0);
  });
});
