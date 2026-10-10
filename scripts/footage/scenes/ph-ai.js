/**
 * Product Hunt tour, the AI clips (docs/product-hunt-demo-script.md rows 5
 * and 17): one app boot per theme, one `it` (one .mov) per clip, each clip
 * only in its own theme.
 *
 *   c05-auto-tags        (light) the billing account, Settings > Auto Tags, a new
 *                        rule: name, tag, Advanced > the provider toggle and its
 *                        review dialog, the rule in plain English, Preview (real
 *                        Apple Intelligence verdicts), Save, Edit, Backfill, Undo
 *   c17-ai-writing       (dark) compose: a rough paragraph, Shorten, the review
 *                        dialog, Send, the rewrite replaces the draft
 *   c17b-thread-summary  (dark) the Rack & Rind thread in the reader, Summarize,
 *                        the review dialog, the summary panel
 *
 * The model is Apple Intelligence through the mailvault-fm-helper sidecar:
 * run with FOOTAGE_FM_HELPER=1 (run.sh builds the helper and refuses to go on
 * when the model is not available). c05's setup runs one untimed preview over
 * the billing account first (it warms the model, measures the pace and fails
 * the clip before recording when the verdicts are refusals).
 *
 * Staged: AI features switched on through the settings store for c17 (they
 * are off by default); the hover card off as in ph-tier2a. Nothing else.
 *
 * Helpers are copied from ph-tier1.js / ph-tier2a.js on purpose: importing a
 * spec would register its clips in this run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake,
  waitPage, since, setSetting,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const THEME = process.env.FOOTAGE_THEME === 'light' ? 'light' : 'dark';
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = { theme: THEME };

// The rule c05 writes on camera (no dashes: typed text never carries one).
const RULE_NAME = 'Money';
const TAG_NAME = 'Money';
// The small on-device model's verdicts vary with the wording (run r1: the
// broad wording said "No match" to "Invoice 0119"). c05's untimed preflight
// tries each wording twice over the billing account and the take types the
// one whose real verdicts best separate statements and invoices from the rest.
const INSTRUCTIONS = [
  'Invoices and bank statements',
  "Anything from my bank, Butcher's Ledger, and any invoice",
  'Bank statements and invoices I need to pay or file',
  'Bank statements, invoices and anything about payments or billing',
];
let INSTRUCTION = INSTRUCTIONS[0];
const SHOULD_MATCH = /statement|invoice/i;
const AMBIGUOUS = /insurance|storage report|subscription|standing order|retainer|licence|contract|dispatch|back-order/i;

/** How well one preflight's verdicts fit: hits on SHOULD_MATCH, minus false matches and refusals. */
function score(rows) {
  let s = 0;
  for (const r of rows) {
    if (AMBIGUOUS.test(r.subject)) continue;
    const want = SHOULD_MATCH.test(r.subject);
    if (r.refused) s -= 0.5;
    else if (want && r.matched) s += 1;
    else if (want && !r.matched) s -= 1;
    else if (!want && r.matched) s -= 1;
  }
  return s;
}

// ── Page predicates (serialised into the page; no closures) ─────────────────

const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const readerOpen = (empty) => !document.body.innerText.includes(empty);
const visible = (s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0);
const enabledWith = (s, t) => [...document.querySelectorAll(s)]
  .some((b) => b.offsetHeight > 0 && !b.disabled && (b.innerText || '').includes(t));
/** The AI review dialog's whole text, or null. */
const dialogText = () => {
  const pre = document.querySelector('[data-testid="ai-preview-text"]');
  const box = pre?.closest('[role="dialog"], .mail-dialog') || pre?.parentElement?.parentElement;
  return box ? (box.innerText || '') : null;
};

// ── Take plumbing (from ph-tier2a.js) ───────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

/** One clip: back to the plain inbox, wait for a quiet frame, record `body`. */
async function shoot(ctx, clip, body, { prepare, theme } = {}) {
  if (!want(clip) || (theme && theme !== THEME)) ctx.skip();
  await resetView();
  if (prepare) await prepare();
  await beforeTake(clip);
  const take = new Take(clip);
  await take.start();
  try {
    await body(take);
    return await finish(take, clip);
  } catch (e) {
    facts[`${clip}Error`] = String(e?.message || e);
    await take.abort();
    throw e;
  }
}

/** One daemon RPC from the page (setup only): the same channel the app's daemonCall uses. */
async function rpc(method, params) {
  await browser.setTimeout({ script: 900000 });
  return browser.executeAsync((m, p, done) => {
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!inv) { done({ error: 'no invoke' }); return; }
    inv('daemon_rpc', { method: m, params: p }).then((v) => done({ ok: v ?? null }), (e) => done({ error: String(e?.message || e) }));
  }, method, params);
}

const COMPOSE_BTN = '.mail-sidebar .sidebar-compose button';
const EDITOR = SEL.editor;
const composeOpen = (s) => !!document.querySelector(s)?.offsetHeight;
const CONFIRM = '[data-testid="ai-preview-confirm"]';

/** Compose opens in the main window (not a separate one the recorder cannot see). */
async function composeInApp() {
  const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
  if (mode !== 'app') await setSetting('composeOpenMode', 'app');
  return mode;
}

/** AI features on (staged: off by default), provider read back. */
async function aiOn() {
  const before = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().aiSettings || null);
  await browser.execute(() => window.__SETTINGS_STORE__.getState().setAiSettings({ enabled: true }));
  if (before?.provider !== 'appleFm') {
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setAiSettings({ provider: 'appleFm' }));
  }
  const after = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().aiSettings || null);
  const providers = await rpc('ai.providers', {});
  console.log(`[setup] aiSettings ${JSON.stringify(before)} -> ${JSON.stringify(after)}; providers ${JSON.stringify(providers)}`);
  const apple = (providers.ok || []).find?.((p) => p.provider === 'appleFm');
  if (!apple?.available) throw new Error(`Apple FM not available to the daemon: ${JSON.stringify(providers)}`);
  return { before, after, providers: providers.ok };
}

/** The review dialog: wait, read it, hold on it, Send. */
async function reviewAndSend(take, key, holdMs) {
  await take.waitFor(visible, 'review dialog', 10000, CONFIRM);
  facts[`${key}Dialog`] = await browser.execute(dialogText);
  console.log(`[footage] ${key} dialog: ${JSON.stringify(facts[`${key}Dialog`])}`);
  await take.hold(holdMs);
  await take.click(CONFIRM, 'review-send');
}

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt AI clips', function () {
  this.timeout(2400000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accounts = (browser.demoAccounts || []).map((a) => ({ id: a.id, email: a.email, name: a.name }));
    // As ph-tier2a: the account rows' data-usage hover card sat on "Loading..."
    // in the harness while the pointer rested on the rows.
    facts.transferHoverWas = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().transferHoverEnabled);
    await setSetting('transferHoverEnabled', false);
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-ai.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 5. Auto Tags in plain English (light).
  it('c05-auto-tags', async function () {
    const accounts = browser.demoAccounts || [];
    const billing = accounts.find((a) => /^accounts@/.test(a.email)) || accounts[2];
    if (!billing) throw new Error('no billing account');
    const ACCT = `.mail-sidebar .sidebar-account-open[aria-label*="${billing.email}"]`;
    const CARD = '[data-testid="settings-auto-tags"]';
    const NAME = `${CARD} input[aria-label="${L('autoTag.name')}"]`;
    const NEWTAG = `${CARD} input[aria-label="${L('autoTag.newTagPlaceholder')}"]`;
    const INSTR = `${CARD} textarea[aria-label="${L('autoTag.instruction')}"]`;
    const SUMMARY = `${CARD} details.settings-editor-details > summary`;
    const TOGGLE = '[data-testid="auto-tag-allow-remote"]';
    const ACTIONS = `${CARD} .settings-editor-actions button`;
    const SAVE = `${CARD} .settings-editor-actions.justify-end button`;
    const RESULTS = '[data-testid="auto-tag-preview-results"]';
    const STATUS = '[data-testid="auto-tag-backfill-status"]';
    const doneRe = `^${L('autoTag.backfillDone').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\\\{\w+\\\}\\\}/g, '\\d+')}$`;
    const resultRows = (s) => [...document.querySelectorAll(`${s} div.border-b`)].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim());

    await shoot(this, 'c05-auto-tags', async (take) => {
      await take.hold(1300);
      await take.click(ACCT, 'account-billing');
      await take.waitFor((id) => window.__MAIL_STORE__?.getState?.().activeAccountId === id
        && document.querySelectorAll('[data-testid="email-row"]').length > 0, 'billing inbox', 10000, billing.id);
      await take.hold(1900);
      // Settings > Auto Tags (Organize), by real clicks.
      await take.click('[data-testid="open-settings"]', 'settings');
      await take.waitFor(settingsOpen, 'settings', 8000);
      // The settings search field takes focus on open; a mouse user's click
      // would not leave it ringed (setup-level blur, no picture change but the ring).
      facts.c05Blurred = await browser.execute(() => { const a = document.activeElement; const tag = a?.tagName; a?.blur?.(); return tag || null; });
      await take.hold(700);
      await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'nav-reveal', { text: L('autoTag.tabLabel'), ms: 700 });
      await take.hold(300);
      await take.click('[data-testid="settings-page"] .settings-nav-item', 'nav-auto-tags', { text: L('autoTag.tabLabel') });
      await take.waitFor(visible, 'auto tags page', 15000, CARD);
      await take.hold(1200);
      // A new rule: name, then a new tag.
      await take.click(`${CARD} button`, 'new-rule', { text: L('autoTag.newRule') });
      await take.waitFor(visible, 'rule editor', 8000, NAME);
      await take.hold(500);
      await take.click(NAME, 'name');
      await take.type(NAME, RULE_NAME, 'name', { base: 90, jitter: 25, seed: 5 });
      await take.hold(400);
      await take.reveal(NEWTAG, 'new-tag', { ms: 600 });
      await take.click(NEWTAG, 'new-tag');
      await take.type(NEWTAG, TAG_NAME, 'new-tag', { base: 90, jitter: 25, seed: 6 });
      await take.hold(300);
      await take.click(`${CARD} button`, 'create-tag', { text: L('autoTag.newTag') });
      await take.waitFor((s) => document.querySelector(s)?.value === '', 'tag created', 8000, NEWTAG);
      await take.hold(700);
      // Advanced: the provider toggle and the review it opens. On before any
      // instruction exists: with it off, the editor samples the rule with the
      // local model (not loaded in this build) 1.5 s after each change.
      await take.reveal(SUMMARY, 'advanced', { text: L('autoTag.advanced'), ms: 700 });
      await take.click(SUMMARY, 'advanced', { text: L('autoTag.advanced') });
      await take.hold(400);
      facts.c05AdvancedOpenedByClick = await browser.execute((s, t) => [...document.querySelectorAll(s)]
        .find((e) => (e.innerText || '').includes(t))?.parentElement?.open ?? null, SUMMARY, L('autoTag.advanced'));
      if (!facts.c05AdvancedOpenedByClick) throw new Error('Advanced options did not open on click');
      facts.c05ToggleRow = await browser.execute((s) => (document.querySelector(s)?.closest('.flex.items-center.justify-between')?.innerText || '').trim(), TOGGLE);
      await take.reveal(TOGGLE, 'allow-provider', { ms: 700 });
      await take.hold(900);
      await take.click(TOGGLE, 'allow-provider');
      await reviewAndSend(take, 'c05', 2800);
      await take.waitFor((s) => !document.querySelector(s), 'dialog closed', 5000, CONFIRM);
      await take.waitFor((s) => document.querySelector(s)?.getAttribute('aria-checked') === 'true'
        || document.querySelector(s)?.getAttribute('aria-pressed') === 'true'
        || /active|bg-mail-accent|on\b/.test(document.querySelector(s)?.className || ''), 'toggle on', 3000, TOGGLE).catch(() => {});
      facts.c05ToggleAfter = await browser.execute((s) => { const e = document.querySelector(s); return e ? { aria: e.getAttribute('aria-checked') ?? e.getAttribute('aria-pressed'), cls: String(e.className).slice(0, 120) } : null; }, TOGGLE);
      await take.hold(900);
      // The rule, in plain English.
      await take.reveal(INSTR, 'instruction', { ms: 900 });
      await take.click(INSTR, 'instruction');
      await take.type(INSTR, INSTRUCTION, 'instruction', { base: 48, jitter: 20, seed: 8 });
      await take.hold(800);
      // Preview: the real model over the account's cached mail.
      await take.reveal(ACTIONS, 'preview', { text: L('autoTag.preview'), ms: 800 });
      await take.click(ACTIONS, 'preview', { text: L('autoTag.preview') });
      const p0 = Date.now();
      take.note('previewStart', Number(take.t(p0).toFixed(3)));
      await take.waitFor((s, busy) => !!document.querySelector(s)
        && ![...document.querySelectorAll('button')].some((b) => (b.innerText || '').includes(busy)), 'preview results', 300000, RESULTS, L('autoTag.previewing'));
      take.note('previewEnd', Number(take.t(Date.now()).toFixed(3)));
      facts.c05PreviewSeconds = Number(since(p0));
      facts.c05PreviewRows = await browser.execute(resultRows, RESULTS);
      facts.c05PreviewError = await browser.execute((s) => document.querySelector(`${s} .text-mail-danger`)?.innerText || null, RESULTS);
      console.log(`[footage] c05 preview ${facts.c05PreviewSeconds} s: ${JSON.stringify(facts.c05PreviewRows)} ${facts.c05PreviewError || ''}`);
      const refused = facts.c05PreviewRows.filter((r) => r.endsWith(L('autoTag.previewRefused'))).length;
      if (facts.c05PreviewError || !facts.c05PreviewRows.length || refused > facts.c05PreviewRows.length / 2) {
        throw new Error(`preview did not come from the model: ${refused}/${facts.c05PreviewRows.length} refused ${facts.c05PreviewError || ''}`);
      }
      await take.reveal(RESULTS, 'results', { ms: 900 });
      await take.hold(2600);
      // The results box scrolls on its own (max-h-56) only when the rows overflow it.
      if (await browser.execute((s) => { const e = document.querySelector(s); return !!e && e.scrollHeight > e.clientHeight + 4; }, RESULTS)) {
        await take.scrollEase(`${RESULTS} div.border-b`, 260, 'results-down', { ms: 2600 });
        await take.hold(1400);
      }
      // Save, open it again, Backfill over the history, then Undo.
      await take.reveal(SAVE, 'save', { text: L('common.save'), ms: 700 });
      await take.click(SAVE, 'save', { text: L('common.save') });
      await take.waitFor((s) => !document.querySelector(s), 'editor closed', 8000, NAME);
      await take.hold(1200);
      facts.c05RuleRow = await browser.execute((c, e) => (document.querySelector(`${c} button[title="${e}"]`)?.parentElement?.parentElement?.innerText || '').replace(/\s+/g, ' ').trim(), CARD, L('autoTag.edit'));
      await take.reveal(`${CARD} button[title="${L('autoTag.edit')}"]`, 'edit', { ms: 600 });
      await take.click(`${CARD} button[title="${L('autoTag.edit')}"]`, 'edit');
      await take.waitFor(enabledWith, 'backfill button', 8000, ACTIONS, L('autoTag.backfill'));
      await take.hold(700);
      await take.reveal(ACTIONS, 'backfill', { text: L('autoTag.backfill'), ms: 800 });
      await take.click(ACTIONS, 'backfill', { text: L('autoTag.backfill') });
      const b0 = Date.now();
      take.note('backfillStart', Number(take.t(b0).toFixed(3)));
      const progress = [];
      while (Date.now() - b0 < 300000) {
        const s = await browser.execute((q) => document.querySelector(q)?.innerText || '', STATUS);
        if (!progress.length || progress.at(-1).text !== s) progress.push({ t: Number(take.t(Date.now()).toFixed(3)), text: s });
        if (new RegExp(doneRe).test(s.trim())) break;
        await browser.pause(150);
      }
      take.note('backfillEnd', Number(take.t(Date.now()).toFixed(3)));
      facts.c05BackfillProgress = progress;
      facts.c05BackfillSeconds = Number(since(b0));
      if (!new RegExp(doneRe).test((progress.at(-1)?.text || '').trim())) throw new Error(`backfill never finished: ${JSON.stringify(progress.at(-1))}`);
      console.log(`[footage] c05 backfill ${facts.c05BackfillSeconds} s: ${progress.at(-1).text}`);
      await take.reveal(STATUS, 'status', { ms: 600 });
      await take.hold(2600);
      await take.click(ACTIONS, 'undo', { text: L('autoTag.undo') });
      await take.waitFor((s) => !document.querySelector(s), 'undo done', 15000, STATUS);
      facts.c05AfterUndo = await browser.execute((s, u) => [...document.querySelectorAll(s)].map((b) => (b.innerText || '').trim()).filter(Boolean), ACTIONS, L('autoTag.undo'));
      await take.hold(2600);
    }, {
      theme: 'light',
      prepare: async () => {
        // Untimed preflight: the same rule over the same account through Apple
        // FM, before any take. Warms the model, measures the pace, and stops
        // here when the verdicts are refusals (helper not found, unavailable).
        facts.c05Preflight = [];
        const totals = new Map(INSTRUCTIONS.map((i) => [i, 0]));
        for (let pass = 0; pass < 2; pass++) {
          for (const instruction of INSTRUCTIONS) {
            const t0 = Date.now();
            const r = await rpc('auto_tags.preview', {
              accountId: billing.id, provider: { type: 'appleFm' },
              rule: { name: RULE_NAME, instruction, constraints: {}, tagId: 'preflight', inboxAction: 'keep', minConfidence: 0.7, allowRemote: true, enabled: false },
            });
            const rows = r.ok?.candidates || [];
            const ms = Date.now() - t0;
            const one = {
              instruction, pass, error: r.error || null, seconds: ms / 1000, count: rows.length, score: score(rows),
              rows: rows.map((x) => ({ subject: x.subject, mailbox: x.mailbox, matched: x.matched, confidence: x.confidence, refused: x.refused })),
            };
            facts.c05Preflight.push(one);
            console.log(`[setup] c05 preflight ${pass} "${instruction}": score ${one.score}, ${ms} ms, `
              + `${JSON.stringify(one.rows.map((x) => `${x.subject.slice(0, 28)}=${x.refused ? 'refused' : x.matched ? x.confidence : 'no'}`))}`);
            const refused = rows.filter((x) => x.refused).length;
            if (r.error || !rows.length || refused > rows.length / 2) {
              throw new Error(`Apple FM preflight failed: ${r.error || `${refused}/${rows.length} refused: ${rows.find((x) => x.refused)?.refused}`}`);
            }
            totals.set(instruction, totals.get(instruction) + one.score);
          }
        }
        INSTRUCTION = [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
        facts.c05Scores = Object.fromEntries(totals);
        facts.c05Instruction = INSTRUCTION;
        console.log(`[setup] c05 wording: "${INSTRUCTION}" ${JSON.stringify(facts.c05Scores)}`);
      },
    });
  });

  // 17. AI writing help (dark): Shorten in a fresh compose.
  it('c17-ai-writing', async function () {
    const ROUGH = 'Hi Theo, just checking in to see if there is any chance at all that the box sleeves could be ready by Thursday, '
      + 'since the client prints on Friday and we would really like to have them in hand before then. Thanks so much!';
    const AI = '[data-testid="compose-modal"] [data-testid="ai-compose-actions"] button';
    const editorText = (s) => (document.querySelector(s)?.innerText || '').trim();
    await shoot(this, 'c17-ai-writing', async (take) => {
      await take.hold(900);
      await take.click(COMPOSE_BTN, 'compose');
      await take.waitFor(composeOpen, 'compose', 10000, EDITOR);
      await take.hold(500);
      await take.click('[data-testid="compose-subject"]', 'subject');
      await take.type('[data-testid="compose-subject"]', 'Box sleeves', 'subject', { base: 70, jitter: 25, seed: 5 });
      await take.hold(200);
      await take.moveTo(EDITOR, 'body');
      await take.typeRich(EDITOR, ROUGH, 'body', { base: 24, jitter: 10, seed: 7, caret: 'start' });
      facts.c17Typed = await browser.execute(editorText, EDITOR);
      await take.hold(700);
      await take.waitFor(enabledWith, 'Shorten enabled', 30000, AI, L('ai.actions.shorten'));
      await take.click(AI, 'shorten', { text: L('ai.actions.shorten') });
      await reviewAndSend(take, 'c17', 2200);
      const g0 = Date.now();
      take.note('generateStart', Number(take.t(g0).toFixed(3)));
      await take.waitFor((c, s, before) => !document.querySelector(c) && (document.querySelector(s)?.innerText || '').trim() !== before,
        'rewrite in the editor', 120000, CONFIRM, EDITOR, facts.c17Typed);
      take.note('generateEnd', Number(take.t(Date.now()).toFixed(3)));
      facts.c17GenerateSeconds = Number(since(g0));
      facts.c17Result = await browser.execute(editorText, EDITOR);
      facts.c17Error = await browser.execute(() => document.querySelector('[data-testid="ai-compose-actions"] .text-mail-danger')?.innerText || null);
      console.log(`[footage] c17 rewrite in ${facts.c17GenerateSeconds} s: ${JSON.stringify(facts.c17Result)}`);
      await take.hold(3600);
    }, {
      theme: 'dark',
      prepare: async () => {
        facts.c17ComposeMode = await composeInApp();
        facts.c17Ai = await aiOn();
      },
    });
  });

  // 17b. Summarize a thread in the reader (dark), its own take.
  it('c17b-thread-summary', async function () {
    const thread = 'launch campaign, round three';
    const AI = '[data-testid="ai-compose-actions"] button';
    const PANEL = '[data-testid="ai-summary-panel"]';
    await shoot(this, 'c17b-thread-summary', async (take) => {
      await take.hold(1200);
      await take.reveal(SEL.row, 'thread-row', { text: thread, ms: 900 });
      await take.click(SEL.row, 'thread-row', { text: thread });
      await take.waitFor(readerOpen, 'thread to open', 10000, L('viewer.selectEmailRead'));
      await take.hold(1800);
      await take.waitFor(enabledWith, 'Summarize enabled', 30000, AI, L('ai.actions.summarize'));
      await take.reveal(AI, 'summarize', { text: L('ai.actions.summarize'), ms: 800 });
      await take.click(AI, 'summarize', { text: L('ai.actions.summarize') });
      await reviewAndSend(take, 'c17b', 2200);
      const g0 = Date.now();
      take.note('generateStart', Number(take.t(g0).toFixed(3)));
      await take.waitFor(visible, 'summary panel', 120000, PANEL);
      take.note('generateEnd', Number(take.t(Date.now()).toFixed(3)));
      facts.c17bGenerateSeconds = Number(since(g0));
      facts.c17bSummary = await browser.execute((s) => document.querySelector(s)?.innerText || null, PANEL);
      console.log(`[footage] c17b summary in ${facts.c17bGenerateSeconds} s: ${JSON.stringify(facts.c17bSummary)}`);
      await take.reveal(PANEL, 'summary', { ms: 800 });
      await take.hold(4000);
    }, {
      theme: 'dark',
      prepare: async () => {
        facts.c17bAi = await aiOn();
      },
    });
  });
});
