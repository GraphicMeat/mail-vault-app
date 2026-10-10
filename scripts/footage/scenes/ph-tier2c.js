/**
 * Product Hunt tour, Tier 2 batch C (docs/product-hunt-demo-script.md rows
 * 23 to 26), Dark Graphite. One app boot, one `it` (one .mov) per clip:
 *
 *   c25-reader-safety      the verified shield (SPF/DKIM/DMARC), a Reply-To
 *                          mismatch in the shield of another message, then a
 *                          link whose text is not its destination: the link
 *                          safety dialog
 *   c23-attachment-search  search a word that is only inside PDF, Word, Excel
 *                          and PowerPoint attachments; the rows' paperclip
 *                          says the hit is in an attachment; open one
 *   c24-delete-recovery    delete, Cmd+Z brings it back; delete again,
 *                          Settings > Storage > Deleted emails: keep period,
 *                          Recover to server (the message is back)
 *   c26-pgp                an encrypted message is locked; Settings > Privacy
 *                          & security > Encryption: import a key; the same
 *                          message opens decrypted
 *
 *   FOOTAGE_SPEC=ph-tier2c FOOTAGE_THEME=dark FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=0 \
 *     FOOTAGE_EXTRA_MAIL=1 FOOTAGE_TIER2C=1 FOOTAGE_EXPECT_TOTAL=2858 bash scripts/footage/run.sh
 *
 * Seeded demo mail (lib/tier2cMail.js, FOOTAGE_TIER2C=1, +6 in the work
 * INBOX): four messages with real attachment files carrying the search word,
 * and two PGP/MIME messages. The OpenPGP key (invented identity Rowan Marsh)
 * is generated at record time with node:crypto and the message is really
 * encrypted to it; the app decrypts it with no GnuPG. The GnuPG-made TEST-ONLY
 * fixture (src-core/tests/fixtures) is the fallback when the generated pair
 * does not import or does not open. The key goes to a file in the run's data
 * dir (MAILVAULT_TEST_PGP_KEYS, wdio.footage.conf.js), never the keychain, and
 * is removed again after the take.
 *
 * c23 archives only its four messages into the vault (attachment text is
 * indexed from the vault); the PGP mail never enters the vault before c26.
 * The confirm-before-delete dialog is switched off for c24 (its copy promises
 * a permanent delete) and on again after.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, clickSel, bootToInbox, resetView, beforeTake, waitPage, since, setSetting,
} from '../lib/scene.js';
import {
  SEARCH_WORD, ATTACHMENT_SUBJECTS, PGP_SUBJECT, PGP_SECRET_LINE, PGP_FIXTURE_SUBJECT, fixtureKey,
} from '../lib/tier2cMail.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = {};

const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const readerOpen = (empty) => !document.body.innerText.includes(empty);

// ── Setup helpers ────────────────────────────────────────────────────────────

/** One daemon RPC from the page (setup only), the channel daemonCall uses. */
function rpc(method, params = {}) {
  return browser.executeAsync((m, p, done) => {
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!inv) { done({ error: 'no invoke' }); return; }
    inv('daemon_rpc', { method: m, params: p }).then((v) => done({ ok: v ?? null }), (e) => done({ error: String(e?.message || e) }));
  }, method, params);
}

function uidsBySubject(needles) {
  return browser.execute((ns) => {
    const rows = window.__MAIL_STORE__?.getState?.().sortedEmails || [];
    return ns.map((n) => rows.find((e) => (e.subject || '').includes(n))?.uid ?? null);
  }, needles);
}

/** Tag the visible row whose text contains `needle` (data-footage-target=tag). */
function tagRow(needle, tag) {
  return browser.execute((n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.innerText || '').includes(n));
    if (!row) return false;
    row.setAttribute('data-footage-target', t);
    return true;
  }, needle, tag);
}

/** Tag the first visible element matching `selector` that is NOT inside a list row. */
function tagOutsideRows(selector, tag) {
  return browser.execute((s, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const el = [...document.querySelectorAll(s)].find((e) => !e.closest('[data-testid="email-row"]') && e.getBoundingClientRect().height > 0);
    if (!el) return false;
    el.setAttribute('data-footage-target', t);
    return true;
  }, selector, tag);
}

const indexStatus = () => rpc('search_index_status').then((r) => r.ok || r);

/** Off camera: search `q` in the vault index; what came back, with where it matched. */
async function dryRun(q) {
  await browser.execute((query) => {
    const st = window.__SEARCH_STORE__.getState();
    st.setSearchFilters({ location: 'local' });
    st.setSearchQuery(query);
    setTimeout(() => window.__SEARCH_STORE__.getState().performSearch(), 0);
  }, q);
  await waitPage((query) => {
    const st = window.__SEARCH_STORE__?.getState?.();
    return !!st && st.searchActive && !st.isSearching && st.searchQuery === query;
  }, { timeout: 60000, interval: 300 }, q);
  await browser.pause(500);
  return browser.execute(() => (window.__SEARCH_STORE__.getState().searchResults || [])
    .map((e) => ({ uid: e.uid, subject: e.subject, matchedIn: e.matchedIn || null, hasAttachments: !!e.hasAttachments })));
}

const pgpKeysFile = () => join(process.env.FOOTAGE_DATA_DIR || '', 'pgp-keys.json');

async function removeAllKeys() {
  const list = await rpc('pgp.list_keys');
  for (const k of list.ok?.keys || []) await rpc('pgp.remove_key', { fingerprint: k.fingerprint });
  const after = await rpc('pgp.list_keys');
  return after.ok?.keys?.length ?? null;
}

// ── Take plumbing ────────────────────────────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  facts[`${clip}Seconds`] = rec.seconds;
  return rec;
}

async function shoot(ctx, clip, body, { prepare } = {}) {
  if (!want(clip)) ctx.skip();
  await resetView();
  if (prepare) await prepare();
  await beforeTake(clip);
  const take = new Take(clip);
  await take.start();
  try {
    await body(take);
    return await finish(take, clip);
  } catch (e) {
    await take.abort();
    throw e;
  }
}

/** Settings > `navLabel` (> `tabLabel`) by real clicks; the search field's focus ring goes at once. */
async function toSettingsPage(take, navLabel, tabLabel, ready, what) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await browser.execute(() => document.activeElement?.blur?.());
  await take.hold(600);
  await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'nav-reveal', { text: navLabel, ms: 600 });
  await take.click('[data-testid="settings-page"] .settings-nav-item', 'nav', { text: navLabel });
  if (tabLabel) {
    await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
      .some((b) => (b.innerText || '').trim() === t), `${what} tab`, 8000, tabLabel);
    await take.hold(500);
    await take.click('[data-testid="settings-page"] [role="tab"]', 'tab', { text: tabLabel });
  }
  await take.waitFor(ready, what, 15000);
  await browser.execute(() => document.activeElement?.blur?.());
}

async function closeSettingsByClick(take) {
  const sel = await browser.execute((c) => {
    for (const s of [`[data-testid="settings-page"] button[aria-label="${c}"]`, `[data-testid="settings-page"] button[title="${c}"]`]) {
      if ([...document.querySelectorAll(s)].some((b) => b.offsetHeight > 0)) return s;
    }
    return null;
  }, L('common.close'));
  if (sel) await take.click(sel, 'settings-close');
  else {
    take.cut('settings-close', 'settings closed with Escape');
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings to close', 6000);
}

/** A click on the first link inside the rendered body (an iframe): the move and click logged at its real spot. */
async function clickBodyLink(take, label) {
  const b = await browser.execute(() => {
    for (const f of document.querySelectorAll('iframe')) {
      const a = f.contentDocument?.querySelector('a[href]');
      if (!a) continue;
      const fr = f.getBoundingClientRect();
      const r = a.getBoundingClientRect();
      if (r.width <= 0) continue;
      return { x: fr.x + r.x, y: fr.y + r.y, w: r.width, h: r.height };
    }
    return null;
  });
  if (!b) throw new Error('no link inside the rendered body');
  const x = b.x + b.w / 2, y = b.y + b.h / 2;
  take.log({ t: take.t(Date.now()), type: 'move', x, y, bbox: b, label, dur: take.travelMs / 1000 });
  take.cursor = { x, y };
  await browser.pause(take.travelMs);
  const at = Date.now();
  const ok = await browser.execute(() => {
    for (const f of document.querySelectorAll('iframe')) {
      const a = f.contentDocument?.querySelector('a[href]');
      if (a) { a.click(); return true; }
    }
    return false;
  });
  if (!ok) throw new Error('body link vanished');
  take.log({ t: take.t(at), raf: take.t(at), type: 'click', x, y, bbox: b, label });
}

// ── The clips ────────────────────────────────────────────────────────────────

describe('footage: Product Hunt tier 2 batch C', function () {
  this.timeout(2400000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));

    // c23: only the four attachment messages into the vault.
    const uids = await uidsBySubject(ATTACHMENT_SUBJECTS);
    facts.attachmentUids = uids;
    for (const uid of uids.filter(Boolean)) {
      const r = await browser.executeAsync((u, done) => {
        Promise.resolve(window.__MAIL_STORE__.getState().saveEmailLocally(u)).then(() => done(true), (e) => done(String(e?.message || e)));
      }, uid);
      console.log(`[setup] archived ${uid}: ${r}`);
    }
    facts.archived = await waitPage((us) => us.every((u) => window.__MAIL_STORE__?.getState?.().archivedEmailIds?.has?.(u)
      || [...(window.__MAIL_STORE__?.getState?.().archivedEmailIds || [])].some((k) => String(k).endsWith(`:${u}`) || k === u)),
    { timeout: 60000, interval: 1000 }, uids.filter(Boolean));

    // c26: the generated key must import (parse + self-signatures) and land in
    // the test key file, not the keychain. Removed again right after.
    const fx = JSON.parse(process.env.FOOTAGE_PGP_FIXTURE || 'null');
    facts.pgp = { generated: fx?.fingerprint || null, keysFile: pgpKeysFile() };
    facts.pgp.leftoverKeys = await removeAllKeys();
    if (fx) {
      const imp = await rpc('pgp.import_key', { armored: fx.armoredKey, passphrase: '' });
      facts.pgp.importCheck = imp.error ? { error: imp.error } : imp.ok;
      facts.pgp.fileAfterImport = existsSync(pgpKeysFile());
      facts.pgp.keysAfterCheck = await removeAllKeys();
    }
    facts.pgp.useGenerated = !!(fx && !facts.pgp.importCheck?.error && facts.pgp.fileAfterImport);
    if (fx && !facts.pgp.fileAfterImport && !facts.pgp.importCheck?.error) {
      console.error('[setup] PGP key did NOT land in the test key file: c26 is off');
      facts.pgp.unsafe = true;
    }
    console.log(`[setup] pgp: ${JSON.stringify(facts.pgp)}`);

    // c23: wait for the daemon to extract and index the attachment text.
    const t1 = Date.now();
    let hits = [];
    while (Date.now() - t1 < 300000) {
      hits = await dryRun(SEARCH_WORD);
      const inAtt = hits.filter((h) => (h.matchedIn || []).includes('attachment'));
      if (inAtt.length >= 4) break;
      if (Date.now() - t1 > 15000 && Date.now() - t1 < 17000) console.log(`[setup] index: ${JSON.stringify(await indexStatus())}`);
      await browser.pause(8000);
    }
    facts.c23DryRun = { seconds: Number(since(t1)), hits };
    console.log(`[setup] dry run "${SEARCH_WORD}" after ${since(t1)} s: ${JSON.stringify(hits)}`);
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    facts.pgp = facts.pgp || {};
    try { facts.pgp.keysAtEnd = await removeAllKeys(); } catch (e) { facts.pgp.cleanupError = e.message; }
    try { await setSetting('confirmBeforeDelete', true); } catch { /* best effort */ }
    writeFileSync(join(OUT_DIR, 'ph-tier2c.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 25. Reader safety.
  it('c25-reader-safety', async function () {
    const threadNeedle = 'launch campaign, round three';
    const replyNeedle = 'Refund for order #4417';
    const phishNeedle = 'your August payment could not be processed';
    const shield = (status) => `[data-testid="sender-verification"][data-status="${status}"]`;
    const WARN = '[data-testid="sender-verification"]:not([data-status="verified"])';
    await shoot(this, 'c25-reader-safety', async (take) => {
      await take.hold(1200);
      // The verified sender: SPF, DKIM and DMARC.
      if (!(await tagRow(threadNeedle, 'thread-row'))) throw new Error('thread row not on screen');
      await take.reveal('[data-footage-target="thread-row"]', 'thread-row', { ms: 700 });
      await take.click('[data-footage-target="thread-row"]', 'open-thread');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'verified shield', 12000, shield('verified'));
      await take.hold(900);
      await take.click(shield('verified'), 'shield-verified');
      await take.waitFor((t) => document.body.innerText.includes(t), 'auth popover', 5000, L('email.header.dmarc'));
      facts.c25Verified = await browser.execute(() => (document.querySelector('.fixed.z-50')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(2800);
      // A Reply-To that is not the sender.
      if (!(await tagRow(replyNeedle, 'reply-row'))) throw new Error('reply-to row not on screen');
      await take.reveal('[data-footage-target="reply-row"]', 'reply-row', { ms: 700 });
      await take.click('[data-footage-target="reply-row"]', 'open-reply-to');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'warning shield', 12000, WARN);
      await take.hold(800);
      await take.click(WARN, 'shield-warning');
      await take.waitFor((t) => document.body.innerText.includes(t), 'reply-to issue', 5000, 'differs from sender');
      facts.c25ReplyTo = await browser.execute(() => (document.querySelector('.fixed.z-50')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(3000);
      // A link whose text is not where it goes.
      if (!(await tagRow(phishNeedle, 'phish-row'))) throw new Error('phishing row not on screen');
      await take.reveal('[data-footage-target="phish-row"]', 'phish-row', { ms: 700 });
      await take.click('[data-footage-target="phish-row"]', 'open-phish');
      await take.waitFor(() => [...document.querySelectorAll('iframe')].some((f) => !!f.contentDocument?.querySelector('a[href]')), 'phishing body', 12000);
      await take.hold(1600);
      await clickBodyLink(take, 'body-link');
      await take.waitFor((t) => document.body.innerText.includes(t), 'link safety dialog', 8000, L('linkSafety.linkTextSays'));
      facts.c25LinkDialog = await browser.execute(() => (document.querySelector('.mail-dialog')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(3600);
    });
    // Off camera: the dialog's Cancel.
    await clickSel('.mail-dialog button', L('common.cancel'));
    await browser.pause(500);
  });

  // 23. Attachment search.
  it('c23-attachment-search', async function () {
    const matchRow = '[data-testid="email-row"]:has([data-testid="attachment-match"])';
    await shoot(this, 'c23-attachment-search', async (take) => {
      await take.hold(1200);
      await take.click(SEL.searchToggle, 'search-toggle');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'search input', 5000, SEL.searchInput);
      const loc = await browser.execute(() => window.__SEARCH_STORE__?.getState?.().searchFilters?.location);
      if (loc !== 'local') {
        take.cut('location-vault', `location was ${loc}; set to Vault through the store`);
        await browser.execute(() => window.__SEARCH_STORE__.getState().setSearchFilters({ location: 'local' }));
      }
      await browser.execute(() => document.activeElement?.blur?.());
      await take.hold(500);
      await take.click(SEL.searchInput, 'search-box');
      await take.hold(250);
      await take.type(SEL.searchInput, SEARCH_WORD, 'search-box', { follow: true });
      await take.hold(300);
      await take.submit(SEL.searchInput, 'search-box');
      await take.waitFor((s) => document.querySelectorAll(s).length > 0, 'attachment hits', 30000, matchRow);
      facts.c23OnScreen = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
        .map((r) => ({ text: (r.innerText || '').replace(/\s+/g, ' ').slice(0, 90), match: !!r.querySelector('[data-testid="attachment-match"]') })));
      console.log(`[fact] c23 rows: ${JSON.stringify(facts.c23OnScreen)}`);
      await take.hold(1800);
      await take.hover(`${matchRow} [data-testid="attachment-match"]`, 'match-clip');
      await take.hold(1500);
      await take.unhover();
      // Open the Word file's message, then the PDF's: the attachment is in the reader.
      for (const [i, subj] of [[1, ATTACHMENT_SUBJECTS[1]], [0, ATTACHMENT_SUBJECTS[0]]]) {
        if (!(await tagRow(subj, `hit-${i}`))) { console.warn(`[take] no row for ${subj}`); continue; }
        await take.click(`[data-footage-target="hit-${i}"]`, `open-hit-${i}`);
        await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
        await take.hold(2600);
      }
      await take.hold(800);
    }, {
      prepare: async () => {
        await browser.execute(() => window.__SEARCH_STORE__?.getState?.().setSearchFilters?.({ location: 'local' }));
        await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().clearSearchHistory?.());
      },
    });
  });

  // 24. Delete, undo, the deleted-mail bin.
  it('c24-delete-recovery', async function () {
    let subject = '';
    const readerDelete = '[data-footage-target="reader-delete"]';
    await shoot(this, 'c24-delete-recovery', async (take) => {
      await take.hold(1200);
      await take.click('[data-footage-target="victim"]', 'open-row');
      await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
      await take.hold(1000);
      if (!(await tagOutsideRows('[data-quick-action="delete"]', 'reader-delete'))) throw new Error('no delete in the reader toolbar');
      await take.click(readerDelete, 'delete');
      await take.waitFor((s) => ![...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(s))
        && !!document.querySelector('[data-testid="undo-toast"]'), 'row gone + undo toast', 15000, subject);
      facts.c24Toast = await browser.execute(() => (document.querySelector('[data-testid="undo-toast"]')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(1600);
      // Cmd+Z.
      take.note('key-cmd-z', { at: Number(take.t(Date.now()).toFixed(3)), keys: 'Meta+z' });
      await browser.execute(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, bubbles: true, cancelable: true })));
      await take.waitFor((s) => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(s)),
        'row back after Cmd+Z', 20000, subject);
      await take.hold(1800);
      facts.c24BinAfterUndo = (await rpc('deleted.list')).ok;
      // Delete it again, then find it in Settings > Storage > Deleted emails.
      if (!(await tagRow(subject, 'victim'))) throw new Error('restored row not found');
      await take.click('[data-footage-target="victim"]', 'open-row-again');
      await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
      await take.hold(700);
      if (!(await tagOutsideRows('[data-quick-action="delete"]', 'reader-delete'))) throw new Error('no delete in the reader toolbar');
      await take.click(readerDelete, 'delete-again');
      await take.waitFor((s) => ![...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(s)),
        'row gone again', 15000, subject);
      await take.hold(900);
      await toSettingsPage(take, L('settings.tab.storage'), null,
        () => !!document.querySelector('[data-testid="deleted-retention"]'), 'storage page');
      await take.reveal('[data-testid="deleted-retention"]', 'bin-card', { ms: 900 });
      await take.waitFor(() => !!document.querySelector('[data-testid="deleted-list"] tr[data-deleted-id]'), 'bin rows', 10000);
      facts.c24BinRows = await browser.execute(() => [...document.querySelectorAll('[data-testid="deleted-list"] tr[data-deleted-id]')]
        .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 140)));
      await take.hold(1400);
      await take.moveTo('[data-testid="deleted-retention"]', 'retention');
      const before = await browser.execute(() => document.querySelector('[data-testid="deleted-retention"]')?.value);
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="deleted-retention"]');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, '30');
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      take.note('set-retention', { from: before, to: '30', at: Number(take.t(Date.now()).toFixed(3)) });
      await take.hold(1300);
      const first = '[data-testid="deleted-list"] tr[data-deleted-id]:first-child';
      await take.hover(`${first} [data-action="recover-local"]`, 'recover-local');
      await take.hold(700);
      await take.unhover();
      const id = await browser.execute((f) => document.querySelector(f)?.dataset.deletedId, first);
      await take.click(`${first} [data-action="recover-server"]`, 'recover-server');
      await take.waitFor((i) => !document.querySelector(`[data-deleted-id="${i}"]`), 'bin row gone', 15000, id);
      await take.hold(2200);
    }, {
      prepare: async () => {
        await setSetting('confirmBeforeDelete', false);
        // c23's search bar can survive resetView: closed by its own toggle.
        for (let i = 0; i < 3; i++) {
          const open = await browser.execute((s) => !!document.querySelector(s)?.offsetHeight, SEL.searchInput);
          if (!open) break;
          await browser.execute(() => window.__SEARCH_STORE__?.getState?.().clearSearch?.());
          await clickSel(SEL.searchToggle);
          await browser.pause(700);
        }
        facts.c24SearchBarOpen = await browser.execute((s) => !!document.querySelector(s)?.offsetHeight, SEL.searchInput);
        facts.c24BinBefore = (await rpc('deleted.list')).ok;
        subject = await browser.execute(() => {
          const row = document.querySelector('[data-testid="email-row"]');
          const e = (window.__MAIL_STORE__.getState().sortedEmails || [])[0];
          if (!row || !e?.subject || !(row.innerText || '').includes(e.subject)) return '';
          row.setAttribute('data-footage-target', 'victim');
          return e.subject;
        });
        if (!subject) throw new Error('top row and the store disagree');
        facts.c24Subject = subject;
        console.log(`[c24] deleting "${subject}"`);
      },
    });
    await setSetting('confirmBeforeDelete', true);
    facts.c24BinAfter = (await rpc('deleted.list')).ok;
    await resetView();
    facts.c24RowBack = await browser.execute((s) => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(s)), subject);
  });

  // 26. OpenPGP.
  it('c26-pgp', async function () {
    if (facts.pgp?.unsafe) this.skip();
    const fx = JSON.parse(process.env.FOOTAGE_PGP_FIXTURE || 'null');
    const useGen = facts.pgp?.useGenerated;
    const armored = useGen ? fx.armoredKey : fixtureKey();
    const subject = useGen ? PGP_SUBJECT : PGP_FIXTURE_SUBJECT;
    const secret = useGen ? PGP_SECRET_LINE : 'The vault combination is';
    facts.c26Using = useGen ? 'generated' : 'gnupg-fixture';
    // The encrypted row and a neighbour (a second open must be a fresh read).
    const tagPgp = () => browser.execute((s) => {
      document.querySelectorAll('[data-footage-target="pgp-row"], [data-footage-target="other-row"]').forEach((el) => el.removeAttribute('data-footage-target'));
      const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
      const i = rows.findIndex((r) => (r.innerText || '').includes(s));
      const o = rows[i + 1] || rows[i - 1];
      if (i < 0 || !o) return false;
      rows[i].setAttribute('data-footage-target', 'pgp-row');
      o.setAttribute('data-footage-target', 'other-row');
      return true;
    }, subject);
    await shoot(this, 'c26-pgp', async (take) => {
      await take.hold(1200);
      await take.reveal('[data-footage-target="pgp-row"]', 'pgp-row', { ms: 700 });
      await take.click('[data-footage-target="pgp-row"]', 'open-locked');
      await take.waitFor(() => !!document.querySelector('[data-testid="pgp-locked"]'), 'locked notice', 15000);
      await take.hold(2400);
      await toSettingsPage(take, L('settings.tab.privacySecurity'), L('pgp.tab'),
        () => !!document.querySelector('[data-testid="pgp-no-keys"]'), 'encryption page');
      await take.hold(700);
      await take.click('[data-testid="settings-page"] textarea', 'key-field');
      take.cut('paste-key', 'armored secret key pasted (value setter, one input event)');
      await browser.execute((a) => {
        const area = document.querySelector('[data-testid="settings-page"] textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, a);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        area.scrollTop = 0;
      }, armored);
      await take.hold(1200);
      await take.click('[data-testid="settings-page"] button', 'import', { text: L('pgp.import') });
      await take.waitFor(() => !!document.querySelector('[data-testid="pgp-key-row"]'), 'key row', 30000);
      if (!existsSync(pgpKeysFile())) {
        await removeAllKeys();
        throw new Error(`imported key is not in ${pgpKeysFile()}: removed, clip refused`);
      }
      facts.c26KeyRow = await browser.execute(() => (document.querySelector('[data-testid="pgp-key-row"]')?.innerText || '').replace(/\s+/g, ' '));
      await take.reveal('[data-testid="pgp-key-row"]', 'key-row', { ms: 600 });
      await take.hold(2400);
      await closeSettingsByClick(take);
      if (!(await tagPgp())) throw new Error('encrypted row gone after settings');
      await take.hold(500);
      // Another row, then the encrypted one again: a fresh read with the key.
      await take.click('[data-footage-target="other-row"]', 'open-other');
      await take.hold(900);
      await take.click('[data-footage-target="pgp-row"]', 'open-decrypted');
      await take.waitFor((s) => !!document.querySelector('[data-testid="pgp-decrypted"]') && document.body.innerText.includes(s), 'decrypted body', 20000, secret);
      facts.c26Reader = await browser.execute(() => (document.querySelector('[data-testid="pgp-decrypted"]')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(4200);
    }, {
      prepare: async () => {
        facts.c26KeysBefore = await removeAllKeys();
        if (!useGen) {
          // The fixture message is months back: a server search for it, off camera.
          await browser.execute((q) => {
            const st = window.__SEARCH_STORE__.getState();
            st.setSearchFilters({ location: 'all' });
            st.setSearchQuery(q);
            setTimeout(() => window.__SEARCH_STORE__.getState().performSearch(), 0);
          }, subject);
          await waitPage((q) => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(q)), { timeout: 30000 }, subject);
        }
        if (!(await tagPgp())) throw new Error(`no row for "${subject}" with a neighbour on screen`);
      },
    });
    facts.c26KeysAfter = await removeAllKeys();
  });
});
