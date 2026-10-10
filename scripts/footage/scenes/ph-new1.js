/**
 * Product Hunt tour, new features batch 1: one app boot per theme, one `it`
 * (one .mov) per clip, and each clip runs only in its own theme.
 *
 *   light  n01-privacy-mode        (Premium) inbox with names, the sidebar privacy toggle: list, reader,
 *                                  sidebar accounts and chat view masked; Option held to peek, released; still on
 *   light  n02-social-share-image  (Premium) a message, Export > Social: presets, backgrounds, padding,
 *                                  App window / Email card, the live preview; Save PNG
 *   dark   n03-redacted-export     (Premium) Export as image with "Redact sensitive info" + Black bar, Export;
 *                                  then the Social preview with redaction off and on again
 *
 * Run env as the tier 2 batches: FOOTAGE_THEME (required), FOOTAGE_EXTRA_MAIL=1,
 * FOOTAGE_ALIGN_ALL=1, MAILVAULT_SMTP_PLAINTEXT=1, FOOTAGE_EXPECT_TOTAL=2852.
 * `FOOTAGE_ONLY=n01-privacy-mode` limits a run.
 *
 * Staged / disclosed:
 *  - Every mask is the app's own: nothing is drawn over the page. The masks
 *    on screen and the peek are read back from the DOM into the facts file.
 *  - n01: the Option hold is a synthetic keydown / keyup of Alt on the
 *    document, the same events the app's peek listener reads. The switch to
 *    chat view is the viewStyle setting set through the store (a `cut` in
 *    actions.json), not the Settings page.
 *  - n02 / n03: the native save panel cannot be driven, so the destination
 *    comes from the VITE_E2E seam (`__MV_EXPORT_DEST__`); the files are really
 *    rendered and written, and copied into the run's output as evidence.
 *  - n03: the second half is the Social format's preview, a different render
 *    path from the image export (same redaction option, same dictionary).
 *
 * Helpers are copied from ph-tier2a/2b on purpose: importing a spec would
 * register its clips in this run.
 */
import { mkdirSync, writeFileSync, existsSync, statSync, copyFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake, since, setSetting,
} from '../lib/scene.js';

const THEME = process.env.FOOTAGE_THEME || '';
const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const CLIP_THEME = {
  'n01-privacy-mode': 'light',
  'n02-social-share-image': 'light',
  'n03-redacted-export': 'dark',
};
const want = (clip) => CLIP_THEME[clip] === THEME && (!ONLY.length || ONLY.includes(clip));
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = { theme: THEME };

/** People in the demo mail (and the owner), to prove what is masked on screen. */
const PEOPLE = ['Rowan', 'Marsh', 'Nell', 'Okafor', 'Ana Brandt', 'Marta', 'Priya', 'Theo Lomas', 'Dario Vella', 'Sana Whitlock'];

const readerOpen = (empty) => !document.body.innerText.includes(empty);
const PRIVACY_BTN = '.sidebar-footer [data-testid="privacy-button"]';
const EXPORT_TITLE = L('export.dialog.exportMessageTitle');
const dialogOpen = (t) => [...document.querySelectorAll('.mail-dialog')].some((d) => d.offsetHeight > 0 && (d.innerText || '').includes(t));
const dialogClosed = (t) => ![...document.querySelectorAll('.mail-dialog')].some((d) => d.offsetHeight > 0 && (d.innerText || '').includes(t));
/** The social preview canvas is painted (it unmounts behind a spinner while the content renders). */
const previewReady = () => {
  const c = [...document.querySelectorAll('.mail-dialog canvas[role="img"]')].find((e) => e.offsetHeight > 0);
  return !!c && c.width > 0 && parseFloat(c.style.width || '0') > 0;
};

// ── Take plumbing (from ph-tier2b.js) ───────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

/** One clip: back to the plain inbox, wait for a quiet frame, record `body`. */
async function shoot(ctx, clip, body, { prepare } = {}) {
  if (!want(clip)) ctx.skip();
  await resetView();
  if (prepare) await prepare();
  await resetView();
  await beforeTake(clip);
  const take = new Take(clip);
  await take.start();
  try {
    await body(take);
    return await finish(take, clip);
  } catch (e) {
    facts[`${clip}Error`] = String(e?.message || e);
    await take.abort();
    await closeExportDialog();
    throw e;
  }
}

/** Tag the first visible element under `scope` matching `sel` whose trimmed text is exactly `text`. */
function markExact(scope, sel, text, tag) {
  return browser.execute((sc, s, tx, tg) => {
    document.querySelectorAll(`[data-footage-target="${tg}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const roots = sc ? [...document.querySelectorAll(sc)] : [document];
    for (const root of roots) {
      const hit = [...root.querySelectorAll(s)].find((el) => el.getClientRects().length > 0 && (el.innerText || el.textContent || '').trim() === tx);
      if (hit) { hit.setAttribute('data-footage-target', tg); return true; }
    }
    return false;
  }, scope, sel, text, tag);
}

/** The smallest visible element under `root` whose text contains `needle` (from ph-tier1.js). */
function markSmallest(root, needle, tag) {
  return browser.execute((r, n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const hit = [...document.querySelectorAll(`${r} *`)]
      .filter((el) => el.offsetHeight > 30 && (el.innerText || '').includes(n))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!hit) return false;
    hit.setAttribute('data-footage-target', t);
    return true;
  }, root, needle, tag);
}

/** A native input set the way React hears it; the cursor travels there first. */
async function setControl(take, selector, value, label, { move = true } = {}) {
  if (take && move) await take.moveTo(selector, label);
  const r = await browser.execute((s, v) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.offsetHeight > 0);
    if (!el) return { error: `no visible ${s}` };
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value };
  }, selector, value);
  if (r.error) throw new Error(`${label}: ${r.error}`);
  if (take) take.note(`set-${label}`, { value, at: Number(take.t(Date.now()).toFixed(3)) });
  return r;
}

/** A range slider walked from its value to `to` in a few steps (reads as a drag). */
async function slide(take, selector, to, label, { steps = 6, gap = 90 } = {}) {
  await take.moveTo(selector, label);
  const from = Number(await browser.execute((s) => [...document.querySelectorAll(s)].find((e) => e.offsetHeight > 0)?.value, selector));
  for (let i = 1; i <= steps; i++) {
    const v = Math.round(from + ((to - from) * i) / steps);
    await setControl(null, selector, v, label, { move: false });
    await browser.pause(gap);
  }
  take.note(`slide-${label}`, { from, to, at: Number(take.t(Date.now()).toFixed(3)) });
}

/** What is on screen now: mask count, which people's names are readable, in the page and in the reader frames. */
function maskFacts(people) {
  return browser.execute((names) => {
    const read = (txt) => names.filter((n) => txt.includes(n));
    const frames = [...document.querySelectorAll('iframe')].map((f) => {
      try { return f.contentDocument ? (f.contentDocument.body?.innerText || '') : null; } catch { return null; }
    });
    const sidebar = [...document.querySelectorAll('.sidebar-account-name, .sidebar-account-address')].map((e) => e.innerText);
    return {
      masks: document.querySelectorAll('.mv-private').length,
      maskedInputs: document.querySelectorAll('.mv-private-input').length,
      pageNames: read(document.body.innerText || ''),
      frameNames: frames.map((t) => (t == null ? 'cross-origin' : read(t))),
      frameMasks: [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument?.querySelectorAll('.mv-private').length ?? null; } catch { return null; } }),
      sidebar,
      privacyPressed: document.querySelector('.sidebar-footer [data-testid="privacy-button"]')?.getAttribute('aria-pressed'),
    };
  }, people);
}

/** Privacy mode on or off, by the sidebar button (setup only, off camera). */
async function setPrivacy(on) {
  const pressed = await browser.execute((s) => document.querySelector(s)?.getAttribute('aria-pressed'), PRIVACY_BTN);
  if ((pressed === 'true') !== on) {
    await browser.execute((s) => document.querySelector(s)?.click(), PRIVACY_BTN);
    await browser.pause(800);
  }
  return browser.execute((s) => document.querySelector(s)?.getAttribute('aria-pressed'), PRIVACY_BTN);
}

/** Option (Alt) alone, held: the events the app's peek listener reads (document, capture). */
async function optionKey(take, phase) {
  const at = await browser.execute((p) => {
    document.dispatchEvent(new KeyboardEvent(p === 'down' ? 'keydown' : 'keyup', {
      key: 'Alt', code: 'AltLeft', altKey: p === 'down', bubbles: true, cancelable: true, composed: true,
    }));
    return Date.now();
  }, phase);
  take.log({ t: take.t(at), type: 'key', key: 'Option', phase, label: `option-${phase}` });
}

/** The reader's Export action: inline in the reader bar, or in its overflow menu. */
async function openExport(take) {
  const inline = '.email-action-bar [data-quick-action="export"]';
  const visible = await browser.execute((s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0 && !e.closest('[role="menu"]')), inline);
  if (visible) {
    await take.click(inline, 'export');
  } else {
    await take.click('.email-action-bar .email-action-main .quick-actions-trigger', 'actions-more');
    await take.waitFor(() => !!document.querySelector('[role="menu"] [data-quick-action="export"]')?.offsetHeight, 'export in menu', 5000);
    await take.hold(500);
    await take.click('[role="menu"] [data-quick-action="export"]', 'export');
  }
  await take.waitFor(dialogOpen, 'export dialog', 8000, EXPORT_TITLE);
  return visible ? 'inline' : 'menu';
}

async function closeExportDialog() {
  await browser.execute((cancel) => {
    const d = [...document.querySelectorAll('.mail-dialog')].find((e) => e.offsetHeight > 0);
    [...(d?.querySelectorAll('button') || [])].find((b) => (b.innerText || '').trim() === cancel)?.click();
  }, L('common.cancel'));
  await browser.pause(500);
  await browser.execute(() => { delete window.__MV_EXPORT_DEST__; delete window.__MV_EXPORT_DIR__; });
}

/** Copy what an export wrote into the run's output (a subdir, not <clip>.* names). */
function keepEvidence(dir, name) {
  const evidence = join(OUT_DIR, name);
  mkdirSync(evidence, { recursive: true });
  return readdirSync(dir).map((n) => {
    const p = join(dir, n);
    const size = statSync(p).size;
    try { copyFileSync(p, join(evidence, basename(n))); } catch { /* listed anyway */ }
    return { name: n, size };
  });
}

const STUDIO_SWAP = 'Studio swap: can you take the Tuesday slot?';
// Its body names no one outside the senders' own names (run 1: "Marta" in the
// Flank & Co body is not in the privacy dictionary and stayed readable).
const TABLE_ROW = 'Table for six';
const SOCIAL_RADIO = '.mail-dialog label:has(input[name="mv-export-format"][value="social"])';
const chip = (group) => `.mail-dialog [role="group"][aria-label="${group}"] button`;
const swatch = (id) => `.mail-dialog button[aria-label="${L(`export.social.swatch.${id}`)}"]`;
const redactBox = '.mail-dialog label:has(input[type="checkbox"])';

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt new features batch 1', function () {
  this.timeout(3600000);

  before(async function () {
    if (THEME !== 'light' && THEME !== 'dark') throw new Error(`FOOTAGE_THEME must be light or dark, got "${THEME}"`);
    if (!Object.keys(CLIP_THEME).some(want)) { console.log(`[setup] no ${THEME} clip selected`); this.skip(); }
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accounts = (browser.demoAccounts || []).map((a) => ({ id: a.id, email: a.email, name: a.name }));
    // The account rows' data-usage hover card never gets its stats in the
    // harness and sat on "Loading..." over the list (ph-tier2a).
    await setSetting('transferHoverEnabled', false);
    facts.privacyAtBoot = await setPrivacy(false);
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-new1.facts.json'), JSON.stringify(facts, null, 2));
  });

  // n01. Privacy mode (Premium).
  it('n01-privacy-mode', async function () {
    const people = [...PEOPLE, ...(facts.accounts || []).flatMap((a) => [a.email, a.name]).filter(Boolean)];
    try {
      await shoot(this, 'n01-privacy-mode', async (take) => {
        await take.hold(1500);
        await take.reveal(SEL.row, 'studio-swap-row', { text: 'Studio swap', ms: 800 });
        await take.click(SEL.row, 'studio-swap-row', { text: 'Studio swap' });
        await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
        await take.hold(2400);
        facts.n01Before = await maskFacts(people);
        // On: the sidebar footer's shield.
        await take.click(PRIVACY_BTN, 'privacy-on');
        await take.waitFor(() => document.querySelectorAll('.mv-private').length > 0, 'masks', 5000);
        facts.n01OnAt = Number(take.t(Date.now()).toFixed(2));
        await take.hold(1500);
        facts.n01On = await maskFacts(people);
        await take.hold(2200);
        facts.n01On2 = await maskFacts(people);
        // Another message, read with the masks on.
        await take.reveal(SEL.row, 'table-row', { text: TABLE_ROW, ms: 700 });
        await take.click(SEL.row, 'table-row', { text: TABLE_ROW });
        await take.waitFor((s) => !!document.querySelector('.email-action-bar')?.offsetHeight
          && (document.body.innerText || '').includes(s), 'second reader', 10000, 'long table at the back');
        await take.hold(2600);
        facts.n01Reader = await maskFacts(people);
        // Chat view: the layout setting, through the store (a cut).
        take.cut('chat-view', 'viewStyle set to chat through the settings store (Settings > Appearance > Layout in the app)');
        await setSetting('viewStyle', 'chat');
        await take.waitFor(() => document.querySelectorAll('[data-testid="sender-row"]').length > 0, 'chat senders', 10000);
        await take.hold(1400);
        // Names are masked here, so the conversation is found by its subject.
        const person = await browser.execute(() => {
          document.querySelectorAll('[data-footage-target="person"]').forEach((el) => el.removeAttribute('data-footage-target'));
          const rows = [...document.querySelectorAll('[data-testid="sender-row"]')].filter((r) => r.offsetHeight > 0);
          const hit = rows.find((r) => (r.innerText || '').includes('round three')) || rows[0];
          if (!hit) return null;
          hit.setAttribute('data-footage-target', 'person');
          return (hit.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
        });
        if (!person) throw new Error('no sender row in chat view');
        facts.n01ChatPerson = person;
        await take.click('[data-footage-target="person"]', 'chat-person');
        await take.hold(900);
        const bubbles = (reply) => (document.querySelector('[data-testid="chat-view"]')?.innerText || '').includes(reply);
        if (!(await browser.execute(bubbles, L('chat.bubble.reply')))) {
          if (await markSmallest('[data-testid="chat-view"]', 'round three', 'topic')) {
            await take.hold(900);
            await take.click('[data-footage-target="topic"]', 'chat-topic');
          }
          await take.waitFor(bubbles, 'bubbles', 15000, L('chat.bubble.reply'));
        }
        await take.hold(2600);
        facts.n01Chat = await maskFacts(people);
        // Peek: Option held alone. No click while it is held (a pointerdown ends it).
        await optionKey(take, 'down');
        await take.waitFor(() => document.querySelectorAll('.mv-private').length === 0, 'peek', 3000);
        facts.n01PeekAt = Number(take.t(Date.now()).toFixed(2));
        await take.hold(900);
        facts.n01Peek = await maskFacts(people);
        await take.hold(1800);
        await optionKey(take, 'up');
        await take.waitFor(() => document.querySelectorAll('.mv-private').length > 0, 'masks back', 3000);
        facts.n01ReleaseAt = Number(take.t(Date.now()).toFixed(2));
        await take.hold(3000);
        facts.n01End = await maskFacts(people);
      });
    } finally {
      // Off camera: n02's social panel forces redaction while privacy is on.
      facts.n01PrivacyAfter = await setPrivacy(false);
      await setSetting('viewStyle', 'list');
    }
  });

  // n02. Share a message as a styled image (Premium).
  it('n02-social-share-image', async function () {
    const exportDir = join(browser.footageDataDir, 'Exports-n02');
    const pngPath = join(exportDir, 'studio-swap-social.png');
    await shoot(this, 'n02-social-share-image', async (take) => {
      await take.hold(1200);
      await take.reveal(SEL.row, 'studio-swap-row', { text: 'Studio swap', ms: 800 });
      await take.click(SEL.row, 'studio-swap-row', { text: 'Studio swap' });
      await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
      await take.hold(1600);
      facts.n02ExportVia = await openExport(take);
      await take.hold(1000);
      await take.click(SOCIAL_RADIO, 'format-social');
      await take.waitFor(previewReady, 'social preview', 30000);
      facts.n02PanelAtOpen = await browser.execute(() => ([...document.querySelectorAll('.mail-dialog')].find((d) => d.offsetHeight > 0)?.innerText || '').replace(/\s+/g, ' ').slice(0, 600));
      await take.hold(2400);
      await take.click(chip(L('export.social.size')), 'size-square', { text: '1:1' });
      await take.waitFor(previewReady, 'preview 1:1', 10000);
      await take.hold(1300);
      for (const id of ['ocean', 'aurora']) {
        await take.click(swatch(id), `bg-${id}`, { dur: 500 });
        await take.hold(1200);
      }
      await slide(take, `.mail-dialog input[type="range"][aria-label="${L('export.social.padding')}"]`, 104, 'padding');
      await take.hold(700);
      await slide(take, `.mail-dialog input[type="range"][aria-label="${L('export.social.radius')}"]`, 30, 'corners');
      await take.hold(1100);
      // The whole app window with the message open.
      await take.click(chip(L('export.social.content')), 'content-app', { text: L('export.social.contentApp') });
      const appAt = Date.now();
      await take.waitFor(previewReady, 'app window preview', 60000);
      facts.n02AppCaptureSeconds = Number(since(appAt));
      await take.hold(1300);
      await take.click(chip(L('export.social.size')), 'size-landscape', { text: '16:9' });
      await take.waitFor(previewReady, 'preview 16:9', 10000);
      await take.hold(2600);
      // Back to the card, portrait, a warmer background.
      await take.click(chip(L('export.social.content')), 'content-card', { text: L('export.social.contentCard') });
      await take.waitFor(previewReady, 'card preview', 30000);
      await take.hold(700);
      await take.click(chip(L('export.social.size')), 'size-portrait', { text: '4:5' });
      await take.waitFor(previewReady, 'preview 4:5', 10000);
      await take.hold(800);
      await take.click(swatch('candy'), 'bg-candy', { dur: 500 });
      await take.hold(2800);
      facts.n02Final = await browser.execute(() => {
        const c = [...document.querySelectorAll('.mail-dialog canvas[role="img"]')].find((e) => e.offsetHeight > 0);
        const box = document.querySelector('.mail-dialog input[type="checkbox"]');
        return { canvas: c ? { w: c.width, h: c.height, css: c.style.width + 'x' + c.style.height } : null, redact: box?.checked ?? null };
      });
      await browser.execute((p) => { window.__MV_EXPORT_DEST__ = p; }, pngPath);
      if (!(await markExact('.mail-dialog', 'button', L('export.social.save'), 'save-png'))) throw new Error('no Save PNG button');
      await take.click('[data-footage-target="save-png"]', 'save-png');
      await take.waitFor(dialogClosed, 'saved and closed', 60000, EXPORT_TITLE);
      await take.hold(1500);
    }, {
      prepare: async () => {
        mkdirSync(exportDir, { recursive: true });
        facts.n02PrivacyBefore = await setPrivacy(false);
      },
    });
    await browser.execute(() => { delete window.__MV_EXPORT_DEST__; });
    facts.n02Files = keepEvidence(exportDir, 'n02-exports');
    console.log(`[n02] exported: ${JSON.stringify(facts.n02Files)}`);
    if (!existsSync(pngPath)) throw new Error('social PNG missing');
  });

  // n03. Export can redact sensitive info (Premium).
  it('n03-redacted-export', async function () {
    const exportDir = join(browser.footageDataDir, 'Exports-n03');
    const pngPath = join(exportDir, 'studio-swap-redacted.png');
    const redactLabel = L('export.dialog.redactLabel');
    try {
      await shoot(this, 'n03-redacted-export', async (take) => {
        await take.hold(1000);
        await take.reveal(SEL.row, 'studio-swap-row', { text: 'Studio swap', ms: 800 });
        await take.click(SEL.row, 'studio-swap-row', { text: 'Studio swap' });
        await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
        await take.hold(1300);
        facts.n03ExportVia = await openExport(take);
        await take.hold(800);
        await take.click('.mail-dialog label:has(input[name="mv-export-format"][value="image"])', 'format-image', { dur: 500 });
        await take.hold(500);
        await take.click(redactBox, 'redact-on', { text: redactLabel });
        await take.waitFor(() => !!document.querySelector('.mail-dialog input[name="mv-export-redact-style"]'), 'redact styles', 5000);
        await take.hold(900);
        await take.click('.mail-dialog label:has(input[name="mv-export-redact-style"][value="bar"])', 'black-bar');
        await take.hold(1800);
        facts.n03Dialog = await browser.execute(() => ([...document.querySelectorAll('.mail-dialog')].find((d) => d.offsetHeight > 0)?.innerText || '').replace(/\s+/g, ' '));
        await browser.execute((p) => { window.__MV_EXPORT_DEST__ = p; }, pngPath);
        if (!(await markExact('.mail-dialog', 'button', L('common.export'), 'export-run'))) throw new Error('no Export button');
        await take.click('[data-footage-target="export-run"]', 'export');
        const t0 = take.t(Date.now());
        take.cut('export-busy-start', 'Export button spinning while the redacted image renders; trim to taste');
        await take.waitFor(dialogClosed, 'export written', 60000, EXPORT_TITLE);
        take.cut('export-busy-end', 'dialog closed: the redacted PNG is written');
        facts.n03Busy = { from: Number(t0.toFixed(2)), to: Number(take.t(Date.now()).toFixed(2)) };
        await browser.execute(() => { delete window.__MV_EXPORT_DEST__; });
        await take.hold(900);
        // The same message as a social card: its live preview, redacted by default.
        await openExport(take);
        await take.hold(500);
        await take.click(SOCIAL_RADIO, 'format-social');
        await take.waitFor(previewReady, 'social preview', 30000);
        await take.hold(2200);
        await take.click(redactBox, 'redact-off', { text: redactLabel });
        await take.waitFor(previewReady, 'unredacted preview', 30000);
        await take.hold(1900);
        await take.click(redactBox, 'redact-on-again', { text: redactLabel });
        await take.waitFor(previewReady, 'redacted preview', 30000);
        await take.hold(2600);
      }, {
        prepare: async () => {
          mkdirSync(exportDir, { recursive: true });
          facts.n03PrivacyBefore = await setPrivacy(false);
        },
      });
    } finally {
      await closeExportDialog();
    }
    facts.n03Files = keepEvidence(exportDir, 'n03-exports');
    console.log(`[n03] exported: ${JSON.stringify(facts.n03Files)}`);
    if (!existsSync(pngPath)) throw new Error('redacted PNG missing');
  });
});
