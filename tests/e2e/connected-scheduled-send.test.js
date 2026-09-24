/**
 * E2E: Scheduled Send — schedule from Compose, list it, send it now, cancel it.
 *
 * The contract (src-daemon/src/handlers/scheduled.rs,
 * src-daemon/src/scheduled_send_worker.rs, src/stores/scheduledStore.js,
 * src/components/scheduled/): scheduling freezes the composed MIME into the
 * account's local vault `Scheduled` mailbox (a Maildir directory, never an
 * IMAP-server mailbox — nothing here is synced to the mock server), writes a
 * row into `app.db`, and either the daemon's own timer or "Send now" fires it
 * through `scheduled_send_worker::attempt_row` — the one send path both share.
 *
 * ── Proving a send actually left the wire ─────────────────────────────────
 * The mock SMTP responder (`src-mock-imap/src/smtp.rs`) keeps its accepted
 * count in the Rust process's own memory — the JS harness only ever speaks
 * IMAP/SMTP wire protocol to it (spawned as a subprocess, no debug channel),
 * so that count is not reachable from here. What IS reachable, and is what
 * `smtp::send_raw` returning Ok triggers next: `scheduled_send_worker`'s
 * `append_to_sent` writes the app's own copy over real IMAP APPEND into the
 * account's Sent mailbox. That is the same proof-of-delivery seam
 * composeHelpers.js's `readStagedEml`/Sent-folder checks use for a normal
 * send, and `trackMailbox` (mockImap.js) exists for exactly this shape: read
 * the count before, let the send land, restore after. Luke's Sent mailbox
 * already carries 5 fixture messages (mockImap.js `scenario()`); this reads a
 * uid list rather than a bare count so cleanup can name exactly what to
 * remove.
 *
 * ── Why luke ───────────────────────────────────────────────────────────────
 * The default active account on a fresh boot (MOCK_ACCOUNTS order: luke,
 * vader, yoda) — compose has no reason to select another one. Nothing here
 * touches luke's INBOX, so the HTML-newest and quoted-subject fixtures other
 * specs key on on that folder are untouched.
 *
 * ── The clock, not driven ───────────────────────────────────────────────────
 * There is no seam here to move the daemon's own clock forward and watch the
 * periodic worker fire a `queued` row on its own — the worker sleeps on a real
 * `tokio::time::sleep` in a separate process, and the harness has no fake-timer
 * hook into it (unlike `sinon`-style JS specs). So every send below goes
 * through "Send now" (`scheduled_send_worker::attempt_row` directly, the exact
 * path the periodic pass also calls), and the timed/catch-up-at-daemon-start
 * path is asserted only at the unit level (scheduled.rs's own
 * `create_then_send_now_delivers_and_cleans_up`), not here.
 *
 * ── "Leaves the Scheduled list" ─────────────────────────────────────────────
 * `scheduledStore.test.js` (`sendNow replaces the row with whatever the daemon
 * answers`) proves the row is deliberately KEPT after a send, status `sent` —
 * and `ScheduledFolderModal.jsx`'s own `visible` filter only excludes
 * `status === 'cancelled'`, not `sent`. So a delivered row does not disappear
 * from the DOM; what actually happens is it drops out of the *actionable*
 * set: `RowActions` renders no buttons for `sent`, and the sidebar's
 * `scheduledPendingCount` (queued + failed only) stops counting it. That is
 * what this spec asserts for "send now" — see the case below for the exact
 * wording. A cancelled row IS filtered out of `visible`, so that half of the
 * claim holds literally.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails } from './helpers.js';
import { setPremium } from './mockBilling.js';
import {
  openComposeFresh,
  closeComposeHard,
  setField,
  typeInBody,
  modalCount,
  invoke,
} from './composeHelpers.js';

const LUKE = 'luke@mock.test';
const LUKE_SERVER = 0; // MOCK_ACCOUNTS order: luke, vader, yoda

const SCHEDULED_MODAL = '[data-testid="scheduled-folder-modal"]';

/**
 * The row's own wall-clock text, computed the exact way
 * `ScheduledFolderModal.jsx` computes it — `formatWallClock(row.localTime,
 * getLocale())` followed by ` (${row.tz})` — and run through
 * `browser.execute` so it goes through the WEBVIEW's own Intl/ICU, not
 * Node's. The first version of this spec reimplemented `formatWallClock` in
 * plain Node and compared its output to the rendered row; that failed for a
 * real reason — Node's ICU renders `dateStyle:'medium', timeStyle:'short'`
 * as "Sep 28, 2026, 8:00 AM" (comma) where WebKit renders the same options
 * as "Sep 28, 2026 at 8:00 AM" ("at") — a plain engine difference with
 * nothing to do with the feature. Formatting in the same engine that renders
 * the row removes the question entirely.
 */
const expectedRowClock = (localTime, tz) => browser.execute((lt, zone) => {
  const [datePart, timePart] = lt.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, min] = (timePart || '00:00').split(':').map(Number);
  const asIfUtc = new Date(Date.UTC(y, m - 1, d, h, min));
  const locale = window.__I18N__.getLocale();
  const clock = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(asIfUtc);
  return `${clock} (${zone})`;
}, localTime, tz);

describe('Scheduled Send', function () {
  this.timeout(180_000);

  let lukeId;
  // uids this file appended to luke's Sent mailbox — a real mutation of the
  // shared mock server (§ "Proving a send actually left the wire" above),
  // recorded here (not just deleted inline at the end of the `it`) so an
  // earlier assertion throwing in that same `it` still leaves `after` able
  // to find and remove it.
  const sentCleanupUids = [];

  // ── The server, behind the app's back ────────────────────────────────────

  async function withLuke(fn) {
    const { host, port } = browser.mockImap[LUKE_SERVER];
    const client = new ImapFlow({ host, port, secure: false, auth: { user: LUKE, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  const sentUids = () => withLuke(async (client) => {
    const lock = await client.getMailboxLock('Sent');
    try {
      return await client.search({ all: true }, { uid: true });
    } finally {
      lock.release();
    }
  });

  const fetchSentSource = (uid) => withLuke(async (client) => {
    const lock = await client.getMailboxLock('Sent');
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return msg?.source?.toString('utf8') || '';
    } finally {
      lock.release();
    }
  });

  // ── The app ───────────────────────────────────────────────────────────────

  const t = (key) => browser.execute((k) => window.__I18N__.t(k), key);

  // No `accountId` filter: if Compose ever schedules under the wrong account,
  // filtering here would just time out later on "no new row appeared" — an
  // unrelated-looking failure for what is really a wrong-account bug.
  // `scheduleViaCompose` below asserts `accountId` explicitly instead.
  const scheduledRows = () => invoke('daemon_rpc', { method: 'scheduled.list', params: {} })
    .then((r) => { if (!r.ok) throw new Error(r.error); return r.value || []; });

  const cancelRow = (id) => invoke('daemon_rpc', { method: 'scheduled.cancel', params: { id } });

  async function openScheduledFolder() {
    await browser.execute(() => document.querySelector('[data-testid="sidebar-scheduled-btn"]')?.click());
    await browser.waitUntil(() => browser.execute((sel) => !!document.querySelector(sel), SCHEDULED_MODAL), {
      timeout: 15_000, interval: 300, timeoutMsg: 'The Scheduled folder modal never opened',
    });
  }

  /**
   * The Dialog's own X (`Dialog.jsx`: `aria-label={closeLabel || t('common.close')}`
   * — no `title`, so this can't reuse `clickButtonTitle`). Not Escape: this
   * spec never confirmed `useDialogA11y` listens where a synthetic keydown on
   * `document.activeElement` would reach it, and a dialog left open with focus
   * trapped would silently swallow the next test's `pressKey('c')` and fail it
   * somewhere that looks unrelated.
   */
  const closeScheduledFolder = () => browser.execute((sel) => {
    const label = window.__I18N__.t('common.close');
    document.querySelector(`${sel} button[aria-label="${label}"]`)?.click();
  }, SCHEDULED_MODAL);

  /** Row li's text, or null if the row is not in the DOM. */
  const rowText = (id) => browser.execute((rid) =>
    document.querySelector(`[data-testid="scheduled-row-${rid}"]`)?.innerText || null, id);

  /** Click a button by title inside a specific row. */
  async function clickRowButton(id, title) {
    const ok = await browser.execute((rid, ttl) => {
      const btn = document.querySelector(`[data-testid="scheduled-row-${rid}"] button[title="${ttl}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    }, id, title);
    await browser.pause(300);
    return ok;
  }

  /**
   * Schedule a message from a fresh Compose window using the "next Monday"
   * preset — always at least a day out, so a row this spec means to cancel or
   * inspect (rather than send) can never race the daemon's own timer during
   * the run. Returns the new row's id and its `localTime`.
   */
  async function scheduleViaCompose({ to = 'partner@example.com', subject, body = 'Scheduled body text' }) {
    await openComposeFresh();
    await setField('compose-to', to);
    await setField('compose-subject', subject);
    await typeInBody(body);

    const before = new Set((await scheduledRows()).map((r) => r.id));

    await browser.execute(() => document.querySelector('[data-testid="compose-schedule-toggle"]')?.click());
    // The Send later panel opens on its Send in tab; the set time is the other.
    await browser.execute(() => document.querySelector('[data-testid="compose-later-tab-at"]')?.click());
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="compose-schedule-preset-monday"]')), {
      timeout: 10_000, interval: 200, timeoutMsg: 'The schedule picker never opened from the toggle',
    });
    await browser.execute(() => document.querySelector('[data-testid="compose-schedule-preset-monday"]')?.click());
    // Both fields are buttons now (date-time picker, zone combobox); the value lives on data-value.
    const localTime = await browser.execute(() => document.querySelector('[data-testid="compose-schedule-time"]')?.dataset.value);
    const tz = await browser.execute(() => document.querySelector('[data-testid="compose-schedule-tz"]')?.dataset.value);
    expect(localTime).toBeTruthy();

    // Schedule in the panel only arms Send; Send (now "Schedule send") schedules.
    await browser.execute(() => document.querySelector('[data-testid="compose-schedule-submit"]')?.click());
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="compose-send"]')?.dataset.plan === 'at'), {
      timeout: 5_000, interval: 200, timeoutMsg: 'Schedule in the panel never armed Send',
    });
    await browser.execute(() => document.querySelector('[data-testid="compose-send"]')?.click());
    await browser.waitUntil(async () => (await modalCount()) === 0, {
      timeout: 15_000, interval: 200, timeoutMsg: 'Compose stayed open after scheduling — handleSchedule never reached onClose',
    });

    let row = null;
    await browser.waitUntil(async () => {
      row = (await scheduledRows()).find((r) => !before.has(r.id)) || null;
      return !!row;
    }, {
      timeout: 20_000, interval: 500,
      timeoutMsg: 'scheduled.create never produced a new row — the Compose "Schedule send" submit did not reach the daemon',
    });
    expect(row.accountId).toBe(lukeId);
    return { id: row.id, localTime, tz, to };
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();
    // Scheduling at a set time is Premium: without this Compose shows its
    // locked panel and the picker this file drives never opens.
    await setPremium(true);
  });

  afterEach(async function () {
    await closeComposeHard();
    await closeScheduledFolder().catch(() => {});
  });

  after(async function () {
    await setPremium(false).catch(() => {});
    // Anything still queued/failed under luke when the file ends is this
    // file's own mess (a row it meant to cancel or send, not a fixture
    // another spec expects) — scoped to lukeId since nothing here touches
    // any other account's queue.
    const remaining = await scheduledRows().catch(() => []);
    for (const row of remaining) {
      if (row.accountId === lukeId && (row.status === 'queued' || row.status === 'failed')) {
        await cancelRow(row.id).catch(() => {});
      }
    }
    // Any Sent-copy this file's "Send now" case appended and did not manage
    // to clean up itself (an earlier assertion in that `it` threw first).
    for (const uid of sentCleanupUids) {
      await withLuke(async (client) => {
        const lock = await client.getMailboxLock('Sent');
        try {
          await client.messageDelete([uid], { uid: true });
        } finally {
          lock.release();
        }
      }).catch(() => {});
    }
  });

  it('schedules from Compose and lists it with the chosen wall clock', async function () {
    const { id, localTime, tz, to } = await scheduleViaCompose({ subject: 'Scheduled send lists correctly' });

    await openScheduledFolder();
    const text = await rowText(id);
    expect(text).not.toBe(null);
    expect(text).toContain(to);
    const expectedClock = await expectedRowClock(localTime, tz);
    expect(text).toContain(expectedClock);

    // Tidy: this row would otherwise sit `queued` for a day out, real but
    // pointless to leave alive for the rest of the file.
    await cancelRow(id);
  });

  it('Send now actually delivers: Sent gains exactly one message carrying the composed subject', async function () {
    const subject = `Scheduled send now ${Date.now()}`;
    const { id } = await scheduleViaCompose({ subject });

    const before = await sentUids();

    await openScheduledFolder();
    const sendNowLabel = await t('scheduled.row.sendNow');
    expect(await clickRowButton(id, sendNowLabel)).toBe(true);

    let addedUid = null;
    await browser.waitUntil(async () => {
      const after = await sentUids();
      const added = after.filter((u) => !before.includes(u));
      if (added.length) { addedUid = added[added.length - 1]; return true; }
      return false;
    }, {
      timeout: 60_000, interval: 1000,
      timeoutMsg: `"Send now" never appended a Sent copy for "${subject}" — before=${JSON.stringify(before)}`,
    });
    // Recorded immediately, not after the assertions below: `after` has to
    // find this uid even if one of those throws first.
    sentCleanupUids.push(addedUid);

    const raw = await fetchSentSource(addedUid);
    expect(raw).toContain(subject);

    // A sent message belongs in Sent, not in a list of things still waiting
    // to happen. The store keeps the row (the daemon's answer is the truth of
    // what happened); the list stops showing it.
    await browser.waitUntil(async () => {
      const row = (await scheduledRows()).find((r) => r.id === id);
      return row?.status === 'sent';
    }, { timeout: 30_000, interval: 500, timeoutMsg: `row ${id} never reached status "sent"` });

    await browser.waitUntil(async () => (await rowText(id)) === null, {
      timeout: 15_000, interval: 300,
      timeoutMsg: `row ${id} is still listed in Scheduled after it was sent`,
    });
  });

  it('cancelling a queued row removes it from the list and it never sends', async function () {
    const subject = `Scheduled send cancel ${Date.now()}`;
    const { id } = await scheduleViaCompose({ subject });
    const before = await sentUids();

    await openScheduledFolder();
    const cancelLabel = await t('common.cancel');
    expect(await clickRowButton(id, cancelLabel)).toBe(true);

    await browser.waitUntil(async () => (await rowText(id)) === null, {
      timeout: 15_000, interval: 300, timeoutMsg: `Cancelling row ${id} did not remove it from the visible Scheduled list`,
    });

    const row = (await scheduledRows()).find((r) => r.id === id);
    expect(row?.status).toBe('cancelled');

    // Nothing to send any more (the frozen .eml was removed by cancel), so
    // there is no worker tick to race — the count settling immediately and
    // staying put across a short wait is the proof.
    await browser.pause(3000);
    expect(await sentUids()).toEqual(before);
  });
});
