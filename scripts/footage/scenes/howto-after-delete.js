/**
 * How-to takes for the FAQ: what stays open after you delete the open email,
 * one take per option of Settings > Mail preferences > Deleting > "When an
 * email is deleted". One boot, five takes, each on its own five emails.
 *
 *   after-delete-none            Select nothing
 *   after-delete-next            Select the next email
 *   after-delete-previous        Select the previous email
 *   after-delete-next-unread     Select the next unread email
 *   after-delete-previous-unread Select the previous unread email
 *
 * Every take: Settings > Mail preferences > the Behavior tab > pick the option
 * (the example under the select changes) > close Settings > open one email >
 * Delete in the reader > hold on what the reader shows.
 *
 * Off camera before each take the first rows are re-seeded (read flags through
 * the app's own mark read / mark unread), so the five options land on five
 * different rows: the open email T has read neighbours, one unread email three
 * rows above it and one three rows below. The row each option must open is
 * computed here from the list on screen, independently of the app's rule, and
 * the take fails when the reader opens anything else.
 *
 * Each take writes <clip>.steps.json: named moments (seconds into the .mov) and
 * the window-point rectangles the page held at that moment, which the
 * publisher turns into the camera path (zoom), so the zoom follows the layout
 * of every language instead of fractions fitted to English.
 *
 * Pair with FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=65 FOOTAGE_EXPECT_TOTAL=2842.
 * FOOTAGE_VERIFY=1 runs every step without a recorder.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, OUT_DIR } from '../lib/footage.js';
import { APP_LOCALE } from '../lib/locale.js';
import { L, probe, bootToInbox, resetView, beforeTake, waitPage, since, setSetting } from '../lib/scene.js';

const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const T = 3;            // index of the email that is opened and deleted
const SEEDED = 7;      // rows re-seeded (all read but two)
const UNREAD_ABOVE = T - 3;
const UNREAD_BELOW = T + 3;
const SELECT = '[data-testid="after-delete-select"]';
const EXAMPLE = '.onboarding-after-delete-sample';
const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const readerEmpty = (empty) => document.body.innerText.includes(empty);

const MODES = [
  { clip: 'after-delete-none', mode: 'none' },
  { clip: 'after-delete-next', mode: 'next' },
  { clip: 'after-delete-previous', mode: 'previous' },
  { clip: 'after-delete-next-unread', mode: 'nextUnread' },
  { clip: 'after-delete-previous-unread', mode: 'previousUnread' },
];

/** The row the option must open, from the rows on screen and their read state (the app's rule, restated). */
export function expectedUid(uids, unread, at, mode) {
  if (mode === 'none') return null;
  const below = uids.slice(at + 1);
  const above = uids.slice(0, at).reverse();
  const backward = mode === 'previous' || mode === 'previousUnread';
  const order = backward ? [...above, ...below] : [...below, ...above];
  if (mode === 'next' || mode === 'previous') return order[0] ?? null;
  return order.find((u) => unread.has(u)) ?? order[0] ?? null;
}

describe('footage: howto-after-delete', function () {
  this.timeout(2400000);
  const facts = { takes: {} };

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.locale = APP_LOCALE;
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
  });

  after(function () {
    writeFileSync(join(OUT_DIR, 'howto-after-delete.facts.json'), JSON.stringify(facts, null, 2));
  });

  /**
   * The list the app reads (sortedEmails, newest first): the first run of SEEDED emails that all
   * carry a uid, and which of them are unread. The DOM order of a virtual list is not the list order.
   */
  const listState = () => browser.execute((n) => {
    const rows = window.__MAIL_STORE__.getState().sortedEmails || [];
    const shown = new Set([...document.querySelectorAll('[data-testid="email-row"]')].map((r) => String(r.dataset.uid)));
    // A message folded into a conversation has no row of its own: the window must be rows only.
    const bare = (e) => e.uid == null || !shown.has(String(e.uid));
    let at = 0;
    while (at + n <= rows.length && rows.slice(at, at + n).some(bare)) at += 1;
    const win = rows.slice(at, at + n);
    const uids = win.map((e) => String(e.uid));
    const unread = win.filter((e) => !(e.flags || []).includes('\\Seen')).map((e) => String(e.uid));
    return { uids, unread, at, rendered: shown.size, head: rows.slice(0, 24).map((e) => `${e.uid}${shown.has(String(e.uid)) ? '' : '-'}`), missing: uids.filter((u) => !shown.has(u)), allShown: uids.every((u) => shown.has(u)) };
  }, SEEDED);

  /** Mark `uids` read or unread through the app's own bulk action (a one-row selection set is what the row menu uses). */
  const mark = (uids, read) => browser.executeAsync((ids, asRead, done) => {
    const st = window.__MAIL_STORE__;
    st.setState({ selectedEmailIds: new Set(ids) });
    const run = asRead ? st.getState().markSelectedAsRead : st.getState().markSelectedAsUnread;
    Promise.resolve(run()).then(() => { st.setState({ selectedEmailIds: new Set(), selectedEmailSnapshots: new Map() }); done(true); },
      (e) => done({ error: String(e?.message || e) }));
  }, uids, read);

  /** Off camera: the first rows read but two, the open one in the middle of the window. */
  async function seed() {
    const first = await listState();
    const window14 = first.uids;
    if (window14.length < SEEDED || !first.allShown) throw new Error(`window of ${window14.length} rows from ${first.at}, ${first.rendered} rendered, missing ${JSON.stringify(first.missing)}, head ${first.head.join(' ')}`);
    for (const [ids, read] of [[window14, true], [[window14[UNREAD_ABOVE], window14[UNREAD_BELOW]], false]]) {
      const r = await mark(ids, read);
      if (r?.error) throw new Error(`mark ${read ? 'read' : 'unread'}: ${r.error}`);
    }
    const ok = await waitPage((want) => {
      const rows = window.__MAIL_STORE__.getState().sortedEmails || [];
      const unread = rows.filter((e) => want.all.includes(String(e.uid)) && !(e.flags || []).includes('\\Seen')).map((e) => String(e.uid));
      return unread.length === 2 && want.unread.every((u) => unread.includes(u));
    }, { timeout: 15000, interval: 250 }, { all: window14, unread: [window14[UNREAD_ABOVE], window14[UNREAD_BELOW]] });
    if (!ok) throw new Error('read flags did not settle');
    await browser.pause(800);
    return listState();
  }

  /** The row `uid` in window points, tagged for a click. */
  const tagRow = (uid, tag) => browser.execute((u, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => String(r.dataset.uid) === String(u));
    if (!row) return false;
    row.setAttribute('data-footage-target', t);
    return true;
  }, uid, tag);

  const tagOutsideRows = (selector, tag) => browser.execute((s, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const el = [...document.querySelectorAll(s)].find((e) => !e.closest('[data-testid="email-row"]') && e.getBoundingClientRect().height > 0);
    if (!el) return false;
    el.setAttribute('data-footage-target', t);
    return true;
  }, selector, tag);

  async function closeSettingsByClick(take) {
    const sel = await browser.execute((c) => {
      for (const s of [`[data-testid="settings-page"] button[aria-label="${c}"]`, `[data-testid="settings-page"] button[title="${c}"]`]) {
        if ([...document.querySelectorAll(s)].some((b) => b.offsetHeight > 0)) return s;
      }
      return null;
    }, L('common.close'));
    if (!sel) throw new Error('no Close button in Settings');
    await take.click(sel, 'settings-close');
    await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings to close', 6000);
  }

  /** A native <select> set the way React hears it; the cursor travels there first. */
  async function setSelect(take, selector, value) {
    await take.moveTo(selector, 'after-delete-select');
    const r = await browser.execute((s, v) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.offsetHeight > 0);
      if (!el) return { error: `no visible ${s}` };
      const from = el.value;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { from, value: el.value };
    }, selector, value);
    if (r.error) throw new Error(r.error);
    if (r.value !== value) throw new Error(`select holds ${r.value}, wanted ${value}`);
    return r;
  }

  /** Window-point boxes of what a step is about; the publisher aims the camera at their union. */
  async function boxes(take, spec) {
    const out = {};
    for (const [name, sel] of Object.entries(spec)) {
      try { out[name] = (await take.box(sel.selector ?? sel, sel.text)) || null; } catch { out[name] = null; }
    }
    return out;
  }

  /** The reader pane: from the right edge of the list to the window's right edge. */
  async function readerBox(take) {
    return browser.execute(() => {
      const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
      if (!rows.length) return null;
      const right = Math.max(...rows.map((r) => r.getBoundingClientRect().right));
      const list = rows[0].parentElement?.parentElement?.getBoundingClientRect();
      return { x: right, y: list ? list.top : 0, w: window.innerWidth - right, h: window.innerHeight - (list ? list.top : 0) };
    });
  }

  async function record(clip, flow) {
    await beforeTake(clip);
    const take = new Take(clip);
    const steps = [];
    const mark2 = (id, caption, rects = {}) => {
      steps.push({ id, caption, t: Number(take.t(Date.now()).toFixed(3)), rects });
      console.log(`[step] ${clip} ${id} @${steps.at(-1).t}s`);
    };
    await take.start();
    try {
      await flow(take, mark2);
      const rec = await take.stop();
      if (rec.delivered < 10) throw new Error(`only ${rec.delivered} pictures delivered`);
      writeFileSync(join(OUT_DIR, `${clip}.steps.json`), JSON.stringify({ clip, seconds: rec.seconds, steps }, null, 2));
    } catch (e) {
      facts[`${clip}Error`] = String(e?.message || e);
      await take.abort().catch(() => {});
      throw e;
    } finally {
      await browser.pause(1500);
      facts[`${clip}After`] = await probe();
    }
  }

  async function takeFor({ clip, mode }) {
    await resetView();
    await setSetting('afterDeleteSelect', 'none');
    await setSetting('afterDeleteSameAccount', false);
    await setSetting('confirmBeforeDelete', false);
    await waitPage((n) => document.querySelectorAll('[data-testid="email-row"]').length > n, { timeout: 20000 }, SEEDED);
    const { uids, unread } = await seed();
    const unreadSet = new Set(unread);
    const target = uids[T];
    const expected = expectedUid(uids, unreadSet, T, mode);
    const info = { mode, target, expected, unread: [uids[UNREAD_ABOVE], uids[UNREAD_BELOW]], window: uids.slice(0, SEEDED) };
    facts.takes[clip] = info;
    console.log(`[fact] ${clip} ${JSON.stringify(info)}`);
    if (unread.length !== 2 || unread[0] === unread[1]) throw new Error(`${clip}: seeded unread ${JSON.stringify(unread)}`);
    if (mode !== 'none' && !expected) throw new Error(`${clip}: no expected row`);
    const empty = L('viewer.selectEmailRead');

    await record(clip, async (take, step) => {
      await take.hold(1000);
      step('list', 'The Inbox, two unread emails among read ones.', { list: await readerBox(take).then((r) => r && { ...r, x: 0, w: r.x }) });
      // Settings > Mail preferences > Behavior.
      await take.click('[data-testid="open-settings"]', 'settings');
      await take.waitFor(settingsOpen, 'settings', 8000);
      await browser.execute(() => document.activeElement?.blur?.());
      await take.hold(600);
      await take.click('[data-testid="settings-page"] .settings-nav-item', 'mail-preferences', { text: L('settings.navigation.mailPreferences') });
      await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
        .some((b) => (b.innerText || '').trim() === t), 'behavior tab', 8000, L('generalSettings.behavior'));
      await take.hold(500);
      await take.click('[data-testid="settings-page"] [role="tab"]', 'behavior', { text: L('generalSettings.behavior') });
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'after-delete select', 15000, SELECT);
      await take.reveal(SELECT, 'after-delete', { ms: 900 });
      await take.hold(900);
      step('settings', 'Mail preferences, Deleting: the option that decides what opens after a delete.', await boxes(take, { select: SELECT, example: EXAMPLE }));
      await setSelect(take, SELECT, mode);
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'example', 6000, EXAMPLE);
      await take.hold(2200);
      step('option', 'Pick the option. The example under it shows what a delete leaves open.', await boxes(take, { select: SELECT, example: EXAMPLE }));
      await closeSettingsByClick(take);
      await take.hold(800);
      if (!(await tagRow(target, 'target'))) throw new Error(`${clip}: target row ${target} not on screen`);
      await take.click('[data-footage-target="target"]', 'open-email');
      await take.waitFor((e) => !document.body.innerText.includes(e), 'reader opened', 10000, empty);
      await take.hold(1300);
      step('open', 'Open an email.', { row: await take.box('[data-footage-target="target"]'), reader: await readerBox(take) });
      if (!(await tagOutsideRows('[data-quick-action="delete"]', 'reader-delete'))) throw new Error(`${clip}: no delete in the reader toolbar`);
      const deleteBox = await take.box('[data-footage-target="reader-delete"]');
      await take.hold(500);
      step('delete', 'Delete it from the reader.', { delete: deleteBox, row: await take.box('[data-footage-target="target"]') });
      await take.click('[data-footage-target="reader-delete"]', 'delete');
      await take.waitFor((u) => ![...document.querySelectorAll('[data-testid="email-row"]')].some((r) => String(r.dataset.uid) === String(u)),
        'row gone', 15000, target);
      await browser.pause(700);
      const after = await browser.execute((e) => ({
        selected: String(window.__MAIL_STORE__.getState().selectedEmailId ?? ''),
        empty: document.body.innerText.includes(e),
      }), empty);
      facts.takes[clip].after = after;
      if (mode === 'none') {
        if (!after.empty || after.selected) throw new Error(`${clip}: expected nothing selected, got ${JSON.stringify(after)}`);
      } else if (after.empty || !after.selected.endsWith(String(expected))) {
        throw new Error(`${clip}: expected ${expected} open, got ${JSON.stringify(after)}`);
      }
      const opened = mode === 'none' ? null : (await tagRow(expected, 'opened')) && await take.box('[data-footage-target="opened"]');
      await take.hold(1400);
      step('after', mode === 'none' ? 'Nothing is selected: the reader asks you to pick an email.' : 'The reader already shows the email the option picked.',
        { row: opened || null, reader: await readerBox(take), list: await readerBox(take).then((r) => r && { ...r, x: 0, w: r.x }) });
      await take.hold(2200);
    });
    // Off camera: undo the delete (Cmd+Z, as the undo toast offers) so every take starts from the same list.
    await browser.execute(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, bubbles: true, cancelable: true })));
    const back = await waitPage((u) => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => String(r.dataset.uid) === String(u)),
      { timeout: 20000 }, target);
    if (!back) console.warn(`[take] ${clip}: undo did not bring ${target} back; the next take seeds another window`);
    await browser.pause(1500);
  }

  const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const m of MODES.filter((x) => !ONLY.length || ONLY.includes(x.clip))) it(m.clip, () => takeFor(m));
});
