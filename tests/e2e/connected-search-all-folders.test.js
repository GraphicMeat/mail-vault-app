/**
 * E2E: "All folders" searches all folders on the server, not just INBOX.
 *
 * Reported by bson73 (discussion #1): 59 nested folders, and a backup that
 * looked smaller than his server. One search had two meanings of "all" — the
 * vault half walked every folder, the server half SELECTed INBOX and stopped —
 * under a results header that said "in all folders". A message that lives in a
 * nested folder and was never backed up therefore read as a message that isn't
 * there.
 *
 * The fixture is luke: INBOX holds "Luke message N", Archive holds
 * "Luke archive N". The spec searches from INBOX for an Archive subject with
 * location 'server', so neither the in-memory INBOX headers nor the local vault
 * can answer — only a server search that leaves INBOX can. Before the fix this
 * returns nothing at all.
 */

import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, switchToFolder, sidebarHasFolder } from './helpers.js';
import { MOCK_PASSWORD } from './mockImap.js';

const ACCOUNT = 'luke@mock.test';
const YODA = 'yoda@mock.test';
const MISSING_FOLDER = 'Search Missing';
const ARCHIVE_SUBJECT = 'Luke archive 2';
const RETRY_SUBJECT = 'Yoda search retry fixture';

/** Search with an explicit scope, the way the filter dropdown sets it. */
const searchScoped = (query, filters) => browser.execute((q, f) => {
  const store = window.__SEARCH_STORE__;
  if (!store) return false;
  store.setState({ searchQuery: q });
  store.getState().setSearchFilters(f);
  store.getState().performSearch();
  return true;
}, query, filters);

const resultRow = (subject) => browser.execute((want) => {
  const rows = window.__SEARCH_STORE__?.getState?.().searchResults || [];
  const hit = rows.find((r) => r.subject === want);
  return hit ? { uid: hit.uid, mailbox: hit._mailbox || null, source: hit.source || null } : null;
}, subject);

const viewerState = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  const e = s?.selectedEmail;
  return {
    loading: !!s?.loadingEmail,
    subject: e?.subject || null,
    body: e ? (e.text || e.textBody || e.html || e.htmlBody || '') : '',
    page: document.body.innerText || '',
  };
});

const searchState = () => browser.execute(() => {
  const s = window.__SEARCH_STORE__?.getState?.();
  const m = window.__MAIL_STORE__?.getState?.();
  return s ? {
    isSearching: s.isSearching,
    searchActive: s.searchActive,
    activeSearchId: s.activeSearchId,
    searchQuery: s.searchQuery,
    searchFilters: s.searchFilters,
    searchError: s.searchError,
    searchProgress: s.searchProgress,
    activeAccountId: m?.activeAccountId,
    activeMailbox: m?.activeMailbox,
    unifiedInbox: m?.unifiedInbox,
    rows: (s.searchResults || []).map((row) => ({
      subject: row.subject, accountId: row._accountId, mailbox: row._mailbox, source: row.source,
    })),
  } : null;
});

async function withMockImap(email, action) {
  const index = (browser.mockAccounts || []).findIndex((account) => account.email === email);
  if (index < 0) throw new Error(`Mock account ${email} was not seeded`);
  const { host, port } = browser.mockImap[index];
  const client = new ImapFlow({
    host, port, secure: false,
    auth: { user: 'e2e-harness', pass: MOCK_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.logout();
  }
}

const clickRow = (subject) => browser.execute((want) => {
  for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
    const lines = (row.innerText || '').split('\n').map((l) => l.trim());
    if (lines.includes(want)) { row.click(); return true; }
  }
  return false;
}, subject);

describe('Connected Search — "all folders" means all folders', function () {
  this.timeout(180_000);

  let missingFolderRemoved = false;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // INBOX, deliberately: the whole bug is that the server search never left
    // the folder it was pinned to, and INBOX is that folder.
    await switchToFolder(ACCOUNT, 'INBOX');
  });

  it('finds a message that lives outside INBOX', async function () {
    await browser.waitUntil(
      async () => await searchScoped(ARCHIVE_SUBJECT, { folder: 'all', location: 'server' }),
      { timeout: 20_000, interval: 500, timeoutMsg: 'Search store never became available' },
    );
    await browser.waitUntil(async () => (await resultRow(ARCHIVE_SUBJECT)) !== null, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: `"${ARCHIVE_SUBJECT}" never appeared — the server search never left INBOX`,
    });

    const hit = await resultRow(ARCHIVE_SUBJECT);
    expect(hit.source).toBe('server-search');
    // And it names the folder it was found in, not the selected one.
    expect(hit.mailbox).not.toBe('INBOX');
    expect((hit.mailbox || '').toLowerCase()).toContain('archive');
  });

  it('opens that hit as its own message', async function () {
    await browser.waitUntil(async () => await clickRow(ARCHIVE_SUBJECT), {
      timeout: 20_000, interval: 400,
      timeoutMsg: `Search never rendered a row titled "${ARCHIVE_SUBJECT}"`,
    });
    await browser.waitUntil(async () => {
      const v = await viewerState();
      return !v.loading && (v.body.length > 0 || v.page.includes('no longer in'));
    }, { timeout: 30_000, interval: 400, timeoutMsg: 'Viewer never settled on a body or an error' });

    const v = await viewerState();
    expect(v.subject).toBe(ARCHIVE_SUBJECT);
    expect(v.body.toLowerCase()).toContain('luke archive 2');
    expect(v.page).not.toContain('no longer in');
  });

  it('still searches only the active folder when the scope is "current"', async function () {
    // The results list replaces the folder header while a search is active, so
    // clear it before asking the sidebar to move: opening the Archive hit above
    // may have left the store holding Archive headers, and step 1 of a search
    // reads whatever is in memory.
    await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
    await switchToFolder(ACCOUNT, 'INBOX');
    await searchScoped(ARCHIVE_SUBJECT, { folder: 'current', location: 'server' });
    // A scoped search that quietly widened would be the same lie in reverse.
    await browser.pause(1_000);
    expect(await resultRow(ARCHIVE_SUBJECT)).toBe(null);

    await searchScoped('Luke message 3', { folder: 'current', location: 'server' });
    await browser.waitUntil(async () => (await resultRow('Luke message 3')) !== null, {
      timeout: 30_000, interval: 500, timeoutMsg: 'Current-folder search found nothing in INBOX',
    });
    expect((await resultRow('Luke message 3')).mailbox).toBe('INBOX');
  });

  it('retries one dropped SEARCH connection and keeps successful folders when one disappears', async function () {
    await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
    await switchToFolder(YODA, 'INBOX');
    await browser.executeAsync((done) => {
      window.__MAIL_SEARCH_TRACE__ = [];
      window.__TAURI__.event.listen('mail-search-progress', (event) => window.__MAIL_SEARCH_TRACE__.push(event.payload))
        .then((stop) => { window.__MAIL_SEARCH_TRACE_STOP__ = stop; done(true); }, (error) => done({ error: String(error) }));
    });
    const seededYodaUids = await withMockImap(YODA, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const date = new Date('2020-01-01T00:00:00Z');
        await client.append('INBOX', Buffer.from([
          `From: Search fixture <search-fixture@mock.test>`,
          `To: ${YODA}`,
          `Subject: ${RETRY_SUBJECT}`,
          `Date: ${date.toUTCString()}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          RETRY_SUBJECT,
          '',
        ].join('\r\n')), [], date);
        return client.search({ subject: RETRY_SUBJECT }, { uid: true });
      } finally {
        lock.release();
      }
    });
    expect(seededYodaUids.length).toBeGreaterThan(0);

    // The fixture drops only the first matching SEARCH on Yoda. Success proves
    // the daemon retried that dead connection once rather than surfacing an
    // empty result or turning the search into a terminal failure.
    await searchScoped(RETRY_SUBJECT, { folder: 'all', location: 'server' });
    const searchTrace = [];
    try {
      await browser.waitUntil(async () => {
        const state = await searchState();
        if (searchTrace.at(-1) !== JSON.stringify(state)) searchTrace.push(JSON.stringify(state));
        return (await resultRow(RETRY_SUBJECT)) !== null;
      }, {
        timeout: 40_000, interval: 250, timeoutMsg: 'Yoda SEARCH did not succeed after its one transient disconnect',
      });
    } catch (error) {
      const frames = await browser.execute(() => window.__MAIL_SEARCH_TRACE__ || []);
      await browser.execute(() => window.__MAIL_SEARCH_TRACE_STOP__?.());
      throw new Error(`${error.message}; state trace: ${searchTrace.join(' -> ')}; progress frames: ${JSON.stringify(frames)}`);
    }
    await browser.execute(() => window.__MAIL_SEARCH_TRACE_STOP__?.());
    await browser.waitUntil(async () => !(await searchState())?.isSearching, {
      timeout: 40_000, interval: 250, timeoutMsg: 'retried server search never reached a terminal frame',
    });
    const retried = await resultRow(RETRY_SUBJECT);
    expect(retried.source).toBe('server-search');
    expect(retried.mailbox).toBe('INBOX');

    await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
    await browser.waitUntil(() => sidebarHasFolder(MISSING_FOLDER), {
      timeout: 20_000, interval: 250, timeoutMsg: `Yoda's cached folder list never contained ${MISSING_FOLDER}`,
    });
    await withMockImap(YODA, (client) => client.mailboxDelete(MISSING_FOLDER));
    missingFolderRemoved = true;

    // Yoda's cached LIST still contributes Search Missing to the request. The
    // server now says that folder is gone; its successful INBOX result must
    // survive and the run must still terminate.
    await searchScoped(RETRY_SUBJECT, { folder: 'all', location: 'server' });
    await browser.waitUntil(async () => (await resultRow(RETRY_SUBJECT)) !== null, {
      timeout: 40_000, interval: 250, timeoutMsg: 'successful INBOX result was erased by the missing folder',
    });
    await browser.waitUntil(async () => !(await searchState())?.isSearching, {
      timeout: 40_000, interval: 250, timeoutMsg: 'partial server search never reached a terminal frame',
    });

    const partial = await searchState();
    expect(partial.rows.some((row) => row.subject === RETRY_SUBJECT
      && row.accountId === browser.mockAccounts.find((account) => account.email === YODA).id
      && row.mailbox === 'INBOX')).toBe(true);
    expect(partial.searchError).toBe(null);
  });

  it('settles server-only Graph and all-hidden searches with no rows', async function () {
    await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
    await switchToFolder(ACCOUNT, 'INBOX');
    const accountId = browser.mockAccounts.find((account) => account.email === ACCOUNT).id;
    const originalTransport = await browser.execute((id) => {
      const account = window.__MAIL_STORE__.getState().accounts.find((item) => item.id === id);
      return account?.oauth2Transport ?? null;
    }, accountId);

    await browser.execute((id) => {
      const store = window.__MAIL_STORE__;
      store.setState({ accounts: store.getState().accounts.map((account) =>
        account.id === id ? { ...account, oauth2Transport: 'graph' } : account) });
    }, accountId);
    try {
      await searchScoped('no graph remote match', { folder: 'current', location: 'server' });
      await browser.waitUntil(async () => {
        const state = await searchState();
        return state && state.isSearching === false;
      }, { timeout: 15_000, interval: 200, timeoutMsg: 'Graph server-only search left the spinner active' });
      expect((await searchState()).rows).toHaveLength(0);
    } finally {
      await browser.execute((id, transport) => {
        const store = window.__MAIL_STORE__;
        store.setState({ accounts: store.getState().accounts.map((account) => {
          if (account.id !== id) return account;
          const restored = { ...account };
          if (transport == null) delete restored.oauth2Transport;
          else restored.oauth2Transport = transport;
          return restored;
        }) });
      }, accountId, originalTransport);
    }

    const hidden = await browser.execute(() => window.__SETTINGS_STORE__.getState().hiddenAccounts || {});
    await browser.execute(() => {
      const accounts = window.__MAIL_STORE__.getState().accounts;
      window.__SETTINGS_STORE__.setState({ hiddenAccounts: Object.fromEntries(accounts.map((account) => [account.id, true])) });
    });
    try {
      await searchScoped('no visible account match', { folder: 'all', location: 'server' });
      await browser.waitUntil(async () => {
        const state = await searchState();
        return state && state.isSearching === false;
      }, { timeout: 15_000, interval: 200, timeoutMsg: 'all-hidden server-only search left the spinner active' });
      expect((await searchState()).rows).toHaveLength(0);
    } finally {
      await browser.execute((saved) => window.__SETTINGS_STORE__.setState({ hiddenAccounts: saved }), hidden);
    }
  });

  after(async function () {
    if (missingFolderRemoved) {
      await withMockImap(YODA, async (client) => {
        try { await client.mailboxCreate(MISSING_FOLDER); } catch { /* already restored */ }
      });
    }
    try {
      await withMockImap(YODA, async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const uids = await client.search({ subject: RETRY_SUBJECT }, { uid: true });
          if (uids.length) await client.messageDelete(uids, { uid: true });
        } finally {
          lock.release();
        }
      });
    } catch (error) {
      console.warn('[connected-search-all-folders] retry fixture cleanup failed:', error.message);
    }
    await browser.execute(() => {
      window.__SEARCH_STORE__?.getState?.().clearSearch?.();
      window.__SEARCH_STORE__?.setState?.({ searchActive: false, searchResults: [], searchQuery: '' });
    });
  });
});
