/**
 * A folder that is genuinely empty on the server must not accuse the server.
 *
 * Field report (2026-09-09): "Server returned empty inbox unexpectedly. Showing
 * cached data while verifying." kept coming back. It was not frequent, it was
 * PERMANENT. loadEmails refused any empty answer that contradicted local
 * evidence and returned BEFORE the cache write, so the count that made it
 * suspicious never reached zero — and vault copies count as evidence, though
 * they outlive the server copy by design. Every sync tick, folder switch and
 * app start re-tripped the same guard, and the promised "while verifying"
 * never ran.
 *
 * The guard now refuses ONE empty answer per (account, mailbox), re-asks, and
 * believes the second. This spec pins that end to end.
 *
 * Fixture-free on purpose: it creates its own folder under Trash (so a single
 * deleteFolder really removes it) instead of consuming a shared mock mailbox —
 * a mutated fixture is paid for by every later spec in the run.
 */

import assert from 'node:assert';
import { waitForApp, waitForEmails } from './helpers.js';

const BANNER = '[data-testid="cached-data-banner"]';
const FOLDER = 'EmptyVerify';

describe('empty folder, no cached-data banner', function () {
  let created = null;
  let accountId = null;

  after(async function () {
    if (!created) return;
    // Created under Trash, so deleteFolder takes the real-DELETE branch rather
    // than moving it into the bin. One obstacle: special-use is guessed from
    // the path, so a folder whose path contains "trash" is itself tagged
    // `\\Trash` and `guardLocked` refuses to delete it. Clearing the guessed
    // tag on this one node first is what lets the fixture be handed back
    // exactly as it was found - a spec that leaks a folder is paid for by
    // every later spec in the run.
    const cleaned = await browser.executeAsync(async (path, done) => {
      try {
        const store = window.__MAIL_STORE__;
        store.setState({
          mailboxes: store.getState().mailboxes.map(m => (m.path === path ? { ...m, specialUse: null } : m)),
        });
        await store.getState().deleteFolder(path);
        done({ ok: true });
      } catch (e) {
        done({ error: e?.message || String(e) });
      }
    }, created);
    if (cleaned?.error) console.warn(`[empty-folder-banner] cleanup left ${created}: ${cleaned.error}`);
  });

  it('an empty folder holding vault copies loads silently and stays empty', async function () {
    this.timeout(180_000);

    await waitForApp();
    await waitForEmails();

    const account = browser.mockAccounts[0];
    assert.ok(account?.id, 'Need a seeded mock account');
    accountId = account.id;

    // ── 1. Own folder, under Trash so the cleanup is a single call.
    await browser.executeAsync(async (id, done) => {
      await window.__MAIL_STORE__.getState().activateAccount(id, 'INBOX');
      done(true);
    }, accountId);

    const trash = await browser.execute(() => {
      const flat = [];
      const walk = (nodes) => {
        for (const n of nodes || []) { flat.push(n); if (n.children?.length) walk(n.children); }
      };
      walk(window.__MAIL_STORE__.getState().mailboxes);
      const t = flat.find(n => n.specialUse === '\\Trash' || /^trash$/i.test(n.name || ''));
      return t ? t.path : null;
    });
    assert.ok(trash, 'Mock account has no Trash folder to park the test folder under');

    const madeFolder = await browser.executeAsync(async (parent, name, done) => {
      try {
        const path = await window.__MAIL_STORE__.getState().createFolder(parent, name);
        done({ path });
      } catch (e) {
        done({ error: e?.message || String(e) });
      }
    }, trash, FOLDER);
    assert.ok(!madeFolder.error, `createFolder failed: ${madeFolder.error}`);
    created = madeFolder.path;
    assert.ok(created, 'createFolder returned no path');

    // ── 2. Vault copies in it. This is the local evidence that used to make an
    // empty server answer look like a lie for ever — the archive-everything
    // case the report came from.
    const raw = Buffer.from(
      'From: seed@example.com\r\nTo: seed@example.com\r\nSubject: empty folder seed\r\n' +
      'Date: Mon, 05 Jan 2026 12:00:00 +0000\r\n\r\nseed body\r\n'
    ).toString('base64');
    const seeded = await browser.executeAsync(async (acct, mailbox, rawB64, done) => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return done({ error: 'No Tauri invoke found' });
        for (const uid of [1, 2, 3]) {
          await invoke('maildir_store', { accountId: acct, mailbox, uid, rawSourceBase64: rawB64, flags: ['seen'] });
        }
        done({ ok: true });
      } catch (e) {
        done({ error: e?.message || String(e) });
      }
    }, accountId, created, raw);
    assert.ok(seeded.ok, `maildir_store seeding failed: ${seeded.error}`);

    // ── 3. Open it, then run loadEmails twice. loadEmails is the workflow that
    // owns the guard and the only place the banner is raised - the sidebar's
    // Refresh routes through activateAccount instead, which is why an earlier
    // draft of this spec passed on the pre-fix build while testing nothing.
    // Twice is what proves the second identical answer is believed rather than
    // refused again.
    await browser.executeAsync(async (id, path, done) => {
      await window.__MAIL_STORE__.getState().activateAccount(id, path);
      done(true);
    }, accountId, created);
    await browser.pause(1_000);
    await browser.executeAsync(async (done) => {
      await window.__MAIL_STORE__.getState().loadEmails();
      done(true);
    });
    await browser.pause(2_500);
    await browser.executeAsync(async (done) => {
      await window.__MAIL_STORE__.getState().loadEmails();
      done(true);
    });

    // The guard only fires when local evidence contradicts the empty answer,
    // so prove the evidence reached it. Without this the spec passes on the
    // pre-fix build too, testing nothing.
    const savedCount = await browser.execute(
      () => window.__MAIL_STORE__.getState().savedEmailIds.size
    );
    assert.ok(savedCount > 0, `Precondition failed: guard sees ${savedCount} vault copies in ${created}`);

    // ── 4. Watch the whole settle. The banner must never appear — not once,
    // not as a flash between the refusal and the re-verify.
    const watchUntil = Date.now() + 20_000;
    let sightings = 0;
    let sightingText = '';
    while (Date.now() < watchUntil) {
      const snap = await browser.execute((sel) => {
        const banner = document.querySelector(sel);
        return { banner: !!banner, text: banner ? banner.textContent : '' };
      }, BANNER);
      if (snap.banner) { sightings++; sightingText = snap.text; }
      await browser.pause(50);
    }
    assert.strictEqual(
      sightings, 0,
      `"Showing cached data" banner appeared ${sightings}x on an empty folder (text: "${sightingText}")`,
    );

    // ── 5. And the emptiness is accepted, not merely silent: the store has to
    // agree with the server rather than keep a phantom total alive.
    const state = await browser.execute(() => {
      const s = window.__MAIL_STORE__.getState();
      return { total: s.totalEmails, server: s.emails.length, mailbox: s.activeMailbox, loading: s.loading };
    });
    assert.strictEqual(state.mailbox, created, `Active mailbox drifted to ${state.mailbox}`);
    assert.strictEqual(state.server, 0, `Expected no server rows in an empty folder, saw ${state.server}`);
    assert.strictEqual(state.total, 0, `Expected totalEmails 0, saw ${state.total}`);
    assert.strictEqual(state.loading, false, 'Load never settled');
  });
});
