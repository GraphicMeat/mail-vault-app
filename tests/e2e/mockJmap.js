/**
 * Mock JMAP harness for the jmap-* specs (wdio.jmap.conf.js).
 *
 * Same server the Rust tests use (`src-mock-jmap`), driven through its bin:
 * `mock-jmap-server` reads a `Scenario` as JSON on stdin, prints
 * `{"port":N,"downloadPort":M}` on its first stdout line, then serves until
 * it is killed. Plain http on loopback, like mock-imap-server.
 *
 * The app reaches it at `http://127.0.0.1:<port>/jmap/session`, which is the
 * account's own session URL: `MAILVAULT_JMAP_BASE` rewrites nothing. It only
 * lets a debug build send credentials over plain http to loopback
 * (src-core/src/jmap/base.rs `url_allowed`), so the shared conf passes the
 * mock's origin there.
 *
 * A spec drives the mock over HTTP:
 *   - the JMAP API itself (`jmapCall`, Basic auth), to read what the server
 *     holds: keywords, mailboxIds, the Sent mailbox;
 *   - `POST /_mock/deliver/{accountId}/{mailboxId}` (no auth) makes mail arrive
 *     and pushes a StateChange down every open EventSource;
 *   - `GET /_mock/submitted` lists every raw message EmailSubmission accepted;
 *   - `GET /_mock/requests` lists every request the mock received.
 *
 * One mock serves the whole run, so a spec that changes it leaves the change
 * for the next spec file. jmap-account reads only what jmap-mail never touches.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appDataDir } from './mockImap.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SERVER_BIN = join(
  REPO_ROOT,
  process.platform === 'win32' ? 'target/debug/mock-jmap-server.exe' : 'target/debug/mock-jmap-server'
);

// ── The account ─────────────────────────────────────────────────────────────

// 36-char UUID, as the app's own ids are (db/emails.js parses a 36-char prefix).
export const JMAP_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
export const JMAP_EMAIL = 'han@jmap.test';
export const JMAP_NAME = 'Han Solo';
export const JMAP_PASSWORD = 'jmap-mock-password';
// The mock numbers its accounts acc1, acc2, ... in scenario order.
export const JMAP_SERVER_ACCOUNT = 'acc1';

export const MB = {
  inbox: 'mb-inbox',
  work: 'mb-work',
  sub: 'mb-sub',
  sent: 'mb-sent',
  drafts: 'mb-drafts',
  trash: 'mb-trash',
};

// Subjects and bodies the specs look for. Dates are September 2026, newer than
// every mock IMAP message (January to March 2026), so the JMAP rows head the
// unified list without scrolling.
export const SUBJECT = {
  e1: 'JMAP message 1',
  e2: 'JMAP message 2',
  e3: 'JMAP message 3',
  e4: 'JMAP message 4',
  sub: 'JMAP sub message',
};
export const E1_BODY = 'The body of JMAP message 1 renders.';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 `Date:` for an ISO instant, so the header and receivedAt agree. */
function rfcDate(iso) {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${dd} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${hh}:${mi}:00 +0000`;
}

/** A plain-text RFC 5322 message, CRLF line ends. */
export function rawMessage({ subject, body, date, messageId, from = 'Leia Organa <leia@rebels.test>', to = `${JMAP_NAME} <${JMAP_EMAIL}>` }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
    '',
  ].join('\r\n');
}

function email(id, subject, body, receivedAt, keywords = []) {
  return {
    id,
    raw: rawMessage({ subject, body, date: rfcDate(receivedAt), messageId: `${id}@jmap.test` }),
    keywords,
    received_at: receivedAt,
  };
}

/**
 * The mock's mailbox, the `Scenario` the bin reads (serde snake_case).
 * Folder paths the app derives (src-core jmap/mailbox_map.rs): INBOX, Work,
 * Work/Sub, Sent, Drafts, Trash.
 */
export function jmapScenario() {
  return {
    accounts: [{
      username: JMAP_EMAIL,
      password: JMAP_PASSWORD,
      // Without an identity a send stops at E_JMAP_NO_IDENTITY.
      identities: [[JMAP_EMAIL, JMAP_NAME]],
      mailboxes: [
        {
          id: MB.inbox, name: 'Inbox', role: 'inbox',
          emails: [
            email('e1', SUBJECT.e1, E1_BODY, '2026-09-04T10:00:00Z'),
            email('e2', SUBJECT.e2, 'The body of JMAP message 2.', '2026-09-03T10:00:00Z', ['$seen']),
            email('e3', SUBJECT.e3, 'The body of JMAP message 3.', '2026-09-02T10:00:00Z', ['$seen']),
            email('e4', SUBJECT.e4, 'The body of JMAP message 4.', '2026-09-01T10:00:00Z', ['$seen']),
          ],
        },
        { id: MB.work, name: 'Work' },
        {
          id: MB.sub, name: 'Sub', parent_id: MB.work,
          emails: [email('e5', SUBJECT.sub, 'The body of the sub message.', '2026-08-30T10:00:00Z', ['$seen'])],
        },
        { id: MB.sent, name: 'Sent', role: 'sent' },
        { id: MB.drafts, name: 'Drafts', role: 'drafts' },
        { id: MB.trash, name: 'Trash', role: 'trash' },
      ],
    }],
  };
}

/**
 * The account as the add-account flow saves it (AccountModal `jmapAccountData`):
 * the whole object is the credentials-file entry. `imapHost` is the session
 * host, which keys the account; there are no IMAP or SMTP ports.
 */
export function jmapAccount(origin) {
  return {
    id: JMAP_ACCOUNT_ID,
    name: JMAP_NAME,
    email: JMAP_EMAIL,
    password: JMAP_PASSWORD,
    authType: 'password',
    jmapSessionUrl: `${origin}/jmap/session`,
    jmapAuth: 'basic',
    imapHost: '127.0.0.1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Add `account` to what `seedAccounts` wrote (mockImap.js): the credentials
 * file and the secrets-stripped accounts.json. Runs in beforeSession, after
 * resetAppState re-seeded the IMAP accounts, before the app launches.
 */
export function seedJmapAccount(home, account) {
  const dataDir = appDataDir(home);
  const credentialsPath = join(dataDir, 'test-credentials.json');
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
  credentials[account.id] = JSON.stringify(account);
  writeFileSync(credentialsPath, JSON.stringify(credentials));
  const metadataPath = join(dataDir, 'accounts.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
  const { password, ...rest } = account;
  writeFileSync(metadataPath, JSON.stringify([...metadata, rest], null, 2));
}

// ── The server process ──────────────────────────────────────────────────────

/** Build the mock server binary. Cargo no-ops when it is current. */
export function buildMockJmap() {
  execFileSync('cargo', ['build', '-p', 'mock-jmap', '--bin', 'mock-jmap-server'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`mock-jmap-server missing after build: ${SERVER_BIN}`);
  }
  return SERVER_BIN;
}

/**
 * Build and start the mock with `scenario` on random loopback ports.
 * @returns {Promise<{origin: string, port: number, downloadPort: number, stop: () => void}>}
 */
export function startMockJmap(scenario) {
  buildMockJmap();
  return new Promise((res, rej) => {
    const proc = spawn(SERVER_BIN, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      rej(new Error('mock-jmap-server did not report a port within 10s'));
    }, 10_000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split('\n')[0];
      if (settled || !line.includes('}')) return;
      settled = true;
      clearTimeout(timer);
      const { port, downloadPort } = JSON.parse(line);
      res({
        origin: `http://127.0.0.1:${port}`,
        port,
        downloadPort,
        stop() {
          proc.kill('SIGTERM');
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 1000);
        },
      });
    });

    proc.stderr.on('data', (d) => console.log('[mock-jmap]', d.toString().trim()));
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
    proc.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); rej(new Error(`mock-jmap-server exited: ${code}`)); }
    });

    proc.stdin.end(JSON.stringify(scenario));
  });
}

// ── Reading the server from a spec ──────────────────────────────────────────

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

/** One JMAP request as the account's own user; resolves to `methodResponses`. */
export async function jmapCall(origin, methodCalls) {
  const auth = Buffer.from(`${JMAP_EMAIL}:${JMAP_PASSWORD}`).toString('base64');
  const r = await fetch(`${origin}/jmap/api`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: USING, methodCalls }),
  });
  if (!r.ok) throw new Error(`mock JMAP /jmap/api answered ${r.status}: ${await r.text()}`);
  return (await r.json()).methodResponses;
}

/** `{ keywords, mailboxIds }` of one email on the server, or null once it is gone. */
export async function serverEmail(origin, id) {
  const [[, out]] = await jmapCall(origin, [
    ['Email/get', { accountId: JMAP_SERVER_ACCOUNT, ids: [id], properties: ['keywords', 'mailboxIds', 'subject'] }, '0'],
  ]);
  return out.list?.[0] ?? null;
}

/** Subjects of every email in `mailboxId` on the server. */
export async function serverSubjects(origin, mailboxId) {
  const [[, query]] = await jmapCall(origin, [
    ['Email/query', { accountId: JMAP_SERVER_ACCOUNT, filter: { inMailbox: mailboxId } }, '0'],
  ]);
  if (!query.ids?.length) return [];
  const [[, got]] = await jmapCall(origin, [
    ['Email/get', { accountId: JMAP_SERVER_ACCOUNT, ids: query.ids, properties: ['subject'] }, '0'],
  ]);
  return (got.list || []).map((e) => e.subject);
}

/** Raw messages EmailSubmission accepted, oldest first. */
export async function submitted(origin) {
  return (await fetch(`${origin}/_mock/submitted`)).json();
}

/** Every request the mock recorded (control routes excluded). */
export async function mockRequests(origin) {
  return (await fetch(`${origin}/_mock/requests`)).json();
}

/** Deliver `raw` into `mailboxId` as new mail; resolves to the new email id. */
export async function deliver(origin, mailboxId, raw) {
  const r = await fetch(`${origin}/_mock/deliver/${JMAP_SERVER_ACCOUNT}/${mailboxId}`, { method: 'POST', body: raw });
  if (!r.ok) throw new Error(`mock JMAP deliver answered ${r.status}`);
  return (await r.json()).id;
}

// ── Opening a JMAP folder in the app ────────────────────────────────────────

/**
 * Open `path` of the account `accountId` and wait until its list is on screen.
 *
 * Not helpers.js `switchToFolder`: that one finds folders by their sidebar
 * text, and a JMAP inbox is drawn by its mailbox name ("Inbox") while its
 * path is "INBOX". The folder row is addressed by `data-path` instead. A
 * different account is opened through the store, as connected-delete-undo
 * does: the sidebar names this account by its display name.
 */
export async function openJmapFolder(accountId, path) {
  const how = await browser.execute((id, p) => {
    const s = window.__MAIL_STORE__.getState();
    if (s.activeAccountId === id) {
      const row = [...document.querySelectorAll('[data-testid="folder-row"]')].find((r) => r.getAttribute('data-path') === p);
      if (row) { row.click(); return 'row'; }
    }
    s.activateAccount(id, p);
    return 'store';
  }, accountId, path);
  let last = null;
  await browser.waitUntil(async () => {
    last = await browser.execute(() => {
      const s = window.__MAIL_STORE__.getState();
      return { accountId: s.activeAccountId, mailbox: s.activeMailbox, loading: !!s.loading };
    });
    return last.accountId === accountId && last.mailbox === path && !last.loading;
  }, { timeout: 30_000, interval: 300, timeoutMsg: `never opened ${path} of ${accountId} (by ${how}); store says ${JSON.stringify(last)}` });
  // The store flips before the list repaints: wait for two equal reads.
  const rows = () => browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
    .map((r) => (r.innerText || '').replace(/\s*\n\s*/g, ' | ').trim()));
  let previous = null;
  await browser.waitUntil(async () => {
    const current = JSON.stringify(await rows());
    const settled = current === previous;
    previous = current;
    return settled;
  }, { timeout: 15_000, interval: 400, timeoutMsg: `the list never settled on ${path}` });
}

// ── The daemon log ──────────────────────────────────────────────────────────

/**
 * Lines of the daemon's log (`<app data>/logs/daemon.log*`) holding `needle`.
 * resetAppState wipes the data dir before every spec file, so each spec reads
 * its own run's log before it ends. No log at all throws: an empty answer from
 * a log that was never there would pass every check against it.
 */
export function daemonLogHits(home, needle) {
  const dir = join(appDataDir(home), 'logs');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('daemon.log')) : [];
  if (!files.length) throw new Error(`no daemon.log under ${dir}`);
  return files
    .flatMap((f) => readFileSync(join(dir, f), 'utf-8').split('\n'))
    .filter((line) => line.includes(needle));
}
