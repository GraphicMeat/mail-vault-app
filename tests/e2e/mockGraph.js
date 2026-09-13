/**
 * A Microsoft Graph stand-in for the Outlook backup specs: just the three
 * endpoints `run_graph_backup` calls (folders, a paged newest-first message
 * listing, a message's MIME), served on loopback. The app reaches it through
 * `MAILVAULT_GRAPH_BASE`, which it honours only for loopback URLs.
 *
 * The launcher starts it in onPrepare; spec workers are other processes, so
 * they drive it over HTTP: PUT /__mock/folders replaces the mailbox, and
 * GET /__mock/requests lists what the app asked for since the last DELETE.
 *
 * `list_folders` also resolves the six well-known folder ids in one `$batch` of
 * `GET /me/mailFolders/{well-known}?$select=id`, and the app reads a message's
 * body through `GET /me/messages/{id}`, so both are served here too.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from './mockImap.js';

// Outlook's English default folder names: a scenario that names its folders
// the way an English mailbox does, and sets no wellKnownName, means them.
const ENGLISH_WELL_KNOWN = {
  'inbox': 'inbox', 'sent items': 'sentitems', 'drafts': 'drafts',
  'deleted items': 'deleteditems', 'junk email': 'junkemail', 'archive': 'archive',
};
const wellKnownOf = (f) => f.wellKnownName ?? ENGLISH_WELL_KNOWN[String(f.displayName).toLowerCase()] ?? null;

const DEFAULT_FROM = { emailAddress: { name: 'Sender', address: 'sender@outlook-mock.test' } };

/** "Name <addr>", or the bare address when the scenario gave no name. */
const rfcAddress = (r) => (r?.emailAddress?.name
  ? `${r.emailAddress.name} <${r.emailAddress.address}>`
  : `${r?.emailAddress?.address || ''}`);

export function startMockGraph() {
  let folders = [];      // [{ id, displayName, wellKnownName, messages: [{ id, internetMessageId, receivedDateTime, subject, mime }] }]
  let requests = [];     // [{ method, path }]

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const notFound = { status: 404, body: { error: { code: 'ErrorItemNotFound' } } };

  /** The folder JSON both the listing and a single-folder lookup emit. */
  const folderJson = (f) => ({
    id: f.id,
    displayName: f.displayName,
    totalItemCount: f.messages.length,
    unreadItemCount: 0,
    childFolderCount: 0,
  });

  /** The header fields a listing carries; a scenario may override three. */
  const headerJson = (msg) => ({
    id: msg.id,
    subject: msg.subject,
    from: msg.from ?? DEFAULT_FROM,
    toRecipients: msg.toRecipients ?? [],
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: msg.receivedDateTime,
    sentDateTime: msg.receivedDateTime,
    isRead: msg.isRead ?? true,
    hasAttachments: false,
    internetMessageId: msg.internetMessageId,
  });

  /** The scenario's own MIME, or one built from its header fields and body. */
  const mimeOf = (msg) => msg.mime ?? [
    `From: ${rfcAddress(msg.from ?? DEFAULT_FROM)}`,
    `To: ${(msg.toRecipients ?? []).map(rfcAddress).join(', ')}`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date(msg.receivedDateTime).toUTCString()}`,
    `Message-ID: ${msg.internetMessageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    msg.body ?? msg.subject,
    '',
  ].join('\r\n');

  /**
   * One Graph route. `$batch` dispatches to it too, which is why it answers with
   * a value rather than writing to the response.
   */
  function route(method, path, searchParams) {
    if (path === '/v1.0/me/mailFolders') {
      return { status: 200, body: { value: folders.map(folderJson) } };
    }

    let m = path.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)\/messages$/);
    if (m) {
      // A well-known name stands in for the id, as it does everywhere in Graph.
      const folder = folders.find((f) => f.id === m[1] || wellKnownOf(f) === m[1]);
      if (!folder) return notFound;
      const top = Number(searchParams.get('$top') || 10);
      const skip = Number(searchParams.get('$skip') || 0);
      const sorted = [...folder.messages].sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
      const page = sorted.slice(skip, skip + top).map(headerJson);
      const more = skip + top < sorted.length;
      return {
        status: 200,
        body: {
          value: page,
          ...(more ? { '@odata.nextLink': `http://127.0.0.1/v1.0/me/mailFolders/${folder.id}/messages?$top=${top}&$skip=${skip + top}` } : {}),
        },
      };
    }

    // The `$batch` sub-request `list_folders` sends for each well-known name.
    m = path.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)$/);
    if (m) {
      const folder = folders.find((f) => f.id === m[1] || wellKnownOf(f) === m[1]);
      return folder ? { status: 200, body: folderJson(folder) } : notFound;
    }

    m = path.match(/^\/v1\.0\/me\/messages\/([^/]+)\/\$value$/);
    if (m) {
      const msg = folders.flatMap((f) => f.messages).find((x) => x.id === m[1]);
      if (!msg) return notFound;
      return { status: 200, raw: mimeOf(msg), contentType: 'message/rfc822' };
    }

    m = path.match(/^\/v1\.0\/me\/messages\/([^/]+)$/);
    if (m) {
      const msg = folders.flatMap((f) => f.messages).find((x) => x.id === m[1]);
      if (!msg) return notFound;
      return {
        status: 200,
        body: {
          ...headerJson(msg),
          body: { contentType: 'text', content: msg.body ?? msg.subject },
          internetMessageHeaders: [{ name: 'Date', value: new Date(msg.receivedDateTime).toUTCString() }],
        },
      };
    }

    return { status: 404, body: { error: { code: 'NotMocked', path } } };
  }

  const send = (res, out) => {
    if (out.raw !== undefined) {
      res.writeHead(out.status, { 'Content-Type': out.contentType });
      return res.end(out.raw);
    }
    return json(res, out.status, out.body);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = decodeURIComponent(url.pathname);

    if (path === '/__mock/folders' && req.method === 'PUT') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { folders = JSON.parse(body); json(res, 200, { ok: true }); });
      return;
    }
    if (path === '/__mock/requests') {
      if (req.method === 'DELETE') requests = [];
      return json(res, 200, requests);
    }

    requests.push({ method: req.method, path });
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) return json(res, 401, { error: { code: 'InvalidAuthenticationToken' } });

    if (path === '/v1.0/$batch' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        // Graph answers the batch 200 and each sub-request with its own status.
        const subs = JSON.parse(body || '{}').requests || [];
        json(res, 200, {
          responses: subs.map((r) => {
            const sub = new URL(r.url, 'http://127.0.0.1');
            const out = route(r.method || 'GET', `/v1.0${decodeURIComponent(sub.pathname)}`, sub.searchParams);
            return { id: r.id, status: out.status, body: out.body ?? null };
          }),
        });
      });
      return;
    }

    send(res, route(req.method, path, url.searchParams));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({ base: `${origin}/v1.0`, origin, stop: () => server.close() });
    });
  });
}

// ── The Graph folder-keys specs' account and mailbox ─────────────────────────

// 36-char UUID, as the app's own ids are (db/emails.js parses a 36-char prefix).
export const GRAPH_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
export const GRAPH_EMAIL = 'leia@mock.test';

/** The seeded account: the whole object is the credentials-file entry. */
export function graphAccount() {
  return {
    id: GRAPH_ACCOUNT_ID,
    name: 'Leia Organa',
    email: GRAPH_EMAIL,
    authType: 'oauth2',
    oauth2Provider: 'microsoft',
    oauth2Transport: 'graph',
    // Three dot-separated segments so authUtils.isJwtShaped() holds, and no
    // refresh token, so ensureFreshToken returns the account untouched.
    oauth2AccessToken: 'e2e.graph.token',
    oauth2ExpiresAt: 4102444800000, // 2100-01-01
    // ImapConfig (src-core imap/mod.rs) requires imapHost even for Graph; the
    // app fills it for a real Outlook account too. Never connected to.
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A GERMAN-named mailbox, the PUT /__mock/folders payload: Outlook names default
 *  folders in the mailbox's language, and that is what the storage keys must survive. */
export function graphScenarioFolders({ owner = GRAPH_EMAIL } = {}) {
  const spec = [
    { wellKnownName: 'inbox',        id: 'fld-inbox',    displayName: 'Posteingang',        count: 12 },
    { wellKnownName: 'sentitems',    id: 'fld-sent',     displayName: 'Gesendete Elemente', count: 5 },
    { wellKnownName: 'drafts',       id: 'fld-drafts',   displayName: 'Entwürfe',           count: 1 },
    { wellKnownName: 'deleteditems', id: 'fld-trash',    displayName: 'Gelöschte Elemente', count: 2 },
    { wellKnownName: 'junkemail',    id: 'fld-junk',     displayName: 'Junk-E-Mail',        count: 1 },
    { wellKnownName: 'archive',      id: 'fld-archive',  displayName: 'Archiv',             count: 3 },
    { wellKnownName: null,           id: 'fld-projekte', displayName: 'Projekte',           count: 4 },
  ];
  let clock = Date.UTC(2026, 8, 1, 12, 0, 0);
  return spec.map((f) => {
    const messages = [];
    for (let i = 1; i <= f.count; i++) {
      const id = `msg-${f.id}-${i}`;
      const receivedDateTime = new Date(clock - i * 3_600_000).toISOString(); // i = 1 is the newest
      const sent = f.wellKnownName === 'sentitems';
      messages.push({
        id,
        internetMessageId: `<${id}@mock.test>`,
        receivedDateTime,
        subject: `${f.displayName} message ${i}`,
        from: { emailAddress: sent ? { name: 'Leia Organa', address: owner } : { name: `Sender ${i}`, address: `sender${i}@mock.test` } },
        toRecipients: [{ emailAddress: sent ? { name: `Recipient ${i}`, address: `recipient${i}@mock.test` } : { name: 'Leia Organa', address: owner } }],
        isRead: i % 2 === 0,
        body: `Body of ${f.displayName} message ${i}`,
      });
    }
    clock -= 86_400_000;
    return { id: f.id, displayName: f.displayName, wellKnownName: f.wellKnownName, messages };
  });
}

// ── Seeds for graph-folder-keys-adopt ────────────────────────────────────────
export const LEGACY_SENT_DIR = 'Gesendet';
export const LEGACY_TRASH_DIR = 'Papierkorb';
export const LEGACY_EML = '1:2,S.eml';

/**
 * What a German UI on v2.11.0 through v2.13.1 left behind: Sent under
 * "Gesendet" with its ledger and index and no English twin (must move), and
 * Trash under "Papierkorb" beside an existing English "Trash" (must stay).
 * Runs in beforeSession, after resetAppState wiped the data dir.
 */
export function seedLegacyGraphDirs(home, accountId) {
  const data = appDataDir(home);
  const cacheBase = accountId.replace(/[^A-Za-z0-9]/g, '_');
  const sentCur = join(data, 'Maildir', accountId, LEGACY_SENT_DIR, 'cur');
  mkdirSync(sentCur, { recursive: true });
  writeFileSync(join(sentCur, LEGACY_EML), 'From: a@mock.test\r\nSubject: legacy sent\r\nMessage-ID: <legacy-sent@mock.test>\r\n\r\nx\r\n');
  const sentCache = join(data, 'email_cache', `${cacheBase}_${LEGACY_SENT_DIR}`);
  mkdirSync(sentCache, { recursive: true });
  writeFileSync(join(sentCache, 'graph_id_map.json'), JSON.stringify({ 1: 'msg-fld-sent-1' }));
  mkdirSync(join(data, 'maildir', accountId, LEGACY_SENT_DIR), { recursive: true });
  writeFileSync(join(data, 'maildir', accountId, LEGACY_SENT_DIR, 'local-index.json'), '[]');

  const trashCur = join(data, 'Maildir', accountId, LEGACY_TRASH_DIR, 'cur');
  mkdirSync(trashCur, { recursive: true });
  writeFileSync(join(trashCur, LEGACY_EML), 'From: a@mock.test\r\nSubject: legacy trash\r\nMessage-ID: <legacy-trash@mock.test>\r\n\r\nx\r\n');
  mkdirSync(join(data, 'Maildir', accountId, 'Trash', 'cur'), { recursive: true });
}
