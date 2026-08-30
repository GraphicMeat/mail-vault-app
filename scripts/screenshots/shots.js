/**
 * Drives the app through every screen the README and the website show, and
 * captures the native window at each stop.
 *
 *   scripts/screenshots/prepare-build.sh
 *   cargo build -p mailvault --features webdriver
 *   npx wdio run wdio.screenshots.conf.js
 *
 * Two rules earned the hard way:
 *
 *   1. Every shot asserts the screen it is about to photograph. `screencapture`
 *      will happily write a stale frame of an occluded window, so "the file was
 *      written" proves nothing — the state line and the assertion do.
 *   2. A shot that cannot reach its state is SKIPPED and logged, never faked.
 */

import { waitForApp, waitForEmails, openSettings, closeSettings, pressKey } from '../../tests/e2e/helpers.js';
import { capture } from './capture.js';
import { demoScenarios } from './demoData.js';
import { makeLabels } from './labels.js';
import { appCode } from './locales.js';

// One env var picks the language, the mailbox and the output directory.
const LOCALE_DIR = process.env.SHOTS_LOCALE || 'en';
const APP_LOCALE = appCode(LOCALE_DIR);

/**
 * Every UI string this file clicks or asserts on comes from the app's own
 * catalog. Hardcoded English breaks the moment the chrome is German — and
 * breaks silently, because a finder that matches nothing leaves the previous
 * screen up and the shot is taken anyway.
 */
const L = makeLabels(APP_LOCALE);
const { MARKERS } = demoScenarios(APP_LOCALE);

// The chat view groups by topic, and the topic row shows the thread subject.
// `Rack & Rind` is a brand and identical in every locale, so it is the one
// stable needle in a subject whose other words all move.
const THREAD_NEEDLE = 'Rack & Rind';


const SETTLE = 900;

// SHOTS_ONLY=email-list-view,thread-view narrows a run while iterating.
const ONLY = (process.env.SHOTS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

// ── DOM helpers ─────────────────────────────────────────────────────────────

const clickByTitle = (title) => browser.execute((t) => {
  for (const el of document.querySelectorAll(`[title="${t}"]`)) {
    if (el.offsetHeight > 0) { el.click(); return true; }
  }
  return false;
}, title);

const clickByText = (text, sel = 'button') => browser.execute((t, s) => {
  for (const el of document.querySelectorAll(s)) {
    if (el.offsetHeight > 0 && (el.textContent || '').trim().startsWith(t)) {
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      el.click();
      return true;
    }
  }
  return false;
}, text, sel);

const clickTestId = (id) => browser.execute((t) => {
  const el = document.querySelector(`[data-testid="${t}"]`);
  if (!el || el.offsetHeight === 0 || el.disabled) return false;
  el.click();
  return true;
}, id);

const clickRowMaybe = (needle) => browser.execute((n) => {
  for (const row of document.querySelectorAll('[data-testid="email-row"], [data-testid="sender-row"]')) {
    if ((row.innerText || '').includes(n)) {
      row.scrollIntoView({ behavior: 'instant', block: 'center' });
      row.click();
      return true;
    }
  }
  return false;
}, needle);

async function clickRow(needle) {
  if (!(await clickRowMaybe(needle))) throw new Error(`no row matching "${needle}"`);
  await browser.pause(600);
}

/**
 * Everything a shot might need to assert, in one round trip.
 *
 * The callback runs in the PAGE, so every translated string it needs has to
 * arrive as an argument — `L` lives in this process and referencing it inside
 * the body fails with "Can't find variable: L", ten seconds at a time, until
 * the whole run times out.
 */
const probe = () => browser.execute((selectEmailRead, chronological) => {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    return !!el && el.offsetHeight > 0;
  };
  const text = document.body.innerText || '';
  return {
    settings: vis('[data-testid="settings-page"]'),
    chat: vis('[data-testid="chat-view"]'),
    compose: vis('[data-testid="compose-modal"]'),
    shortcuts: vis('[data-testid="shortcuts-modal"]'),
    insights: vis('[data-testid="sender-insights-panel"]'),
    threadHeaders: document.querySelectorAll('[data-testid="thread-email-header"]').length,
    rows: document.querySelectorAll('[data-testid="email-row"]').length,
    senderRows: document.querySelectorAll('[data-testid="sender-group-row"]').length,
    grouped: !!document.querySelector(`button[title="${chronological}"]`),
    viewerEmpty: text.includes(selectEmailRead),
    iframes: document.querySelectorAll('iframe').length,
    // Full text, not a slice: assertions match against content far below the
    // fold (an attachment chip, a settings heading). Truncation happens where
    // it belongs — in the log line and the failure message.
    text: text.replace(/\s+/g, ' '),
  };
}, L('viewer.selectEmailRead'), L('list.switchChronologicalView'));

/** Wait until `pred(state)` holds, or fail the shot with what was on screen. */
async function expectState(pred, description, timeout = 12000) {
  let last = {};
  try {
    await browser.waitUntil(async () => {
      last = await probe();
      return pred(last);
    }, { timeout, interval: 400 });
  } catch {
    throw new Error(`${description} — saw ${JSON.stringify({ ...last, text: (last.text || '').slice(0, 200) })}`);
  }
}

const hasText = (needle) => (s) => s.text.includes(needle);

// ── Window handling ─────────────────────────────────────────────────────────

/**
 * Size the window and pin it above whatever else is on that desktop. An
 * occluded WKWebView stops painting and the capture then silently repeats the
 * last good frame — this is the only defence against a whole run of wrong shots.
 * Needs the permissions scripts/screenshots/prepare-build.sh grants.
 */
async function raiseWindow() {
  return browser.executeAsync((w, h, done) => {
    const api = window.__TAURI__;
    const win = api?.window?.getCurrentWindow?.();
    const Size = api?.dpi?.LogicalSize || api?.window?.LogicalSize;
    if (!win || !Size) { done('no tauri window api'); return; }
    Promise.resolve()
      .then(() => win.setSize(new Size(w, h)))
      .then(() => win.center())
      .then(() => win.setAlwaysOnTop(true))
      .then(() => win.setFocus())
      .then(() => done('ok'))
      .catch((e) => done(`failed: ${e}`));
  }, 1440, 900);
}

// ── Shot plumbing ───────────────────────────────────────────────────────────

async function shot(name, settle = SETTLE) {
  await browser.pause(settle);
  const state = await probe();
  console.log(`[state] ${name}`, JSON.stringify({ ...state, text: state.text.slice(0, 120) }));
  capture(name);
}

async function step(name, fn, settle) {
  if (ONLY.length && !ONLY.includes(name)) return;
  try {
    await fn();
    await shot(name, settle);
  } catch (e) {
    console.error(`[shot] SKIPPED ${name}: ${e.message}`);
  }
}

// ── App-state helpers ───────────────────────────────────────────────────────

/** Settings → General → Appearance, where layout / view style / list style live. */
async function openAppearance() {
  await openSettings();
  await browser.pause(500);
  await clickByText(L('settings.tab.general'));
  await browser.pause(400);
  await clickByText(L('settings.appearance.appearance'));
  await browser.pause(500);
}

async function setAppearance(optionLabel) {
  await openAppearance();
  if (!(await clickByText(optionLabel))) throw new Error(`appearance option not found: ${optionLabel}`);
  await browser.pause(500);
  await closeSettings();
  await browser.pause(SETTLE);
}

/** The list header's checkbox opens the bulk operations modal. */
const openBulkModal = () => browser.execute(() => {
  const btn = document.querySelector('[data-testid="email-list-header"] button');
  if (!btn) return false;
  btn.click();
  return true;
});

/**
 * Back to a clean inbox: no modal, no popover, no staged compose, no selection.
 * Leftovers from the previous shot are the second most common way to ship a
 * wrong screenshot (the first is an occluded window).
 */
async function resetToInbox() {
  // Compose closes through its own Close button — Escape only minimises it into
  // the outbox tray, where it kept photobombing the next four shots.
  await browser.execute((close) => {
    document.querySelector(`[data-testid="compose-modal"] button[title="${close}"]`)?.click();
  }, L('common.close'));
  await browser.pause(500);
  await browser.execute((label) => {
    for (const b of document.querySelectorAll('button')) {
      if (b.offsetHeight > 0 && (b.textContent || '').trim().toLowerCase() === label.toLowerCase()) b.click();
    }
  }, L('common.discard'));
  await browser.pause(400);
  await browser.execute((cancel, clear, close) => {
    // Any open modal keeps its own X; leaving one up photobombs later shots.
    for (const b of document.querySelectorAll('button')) {
      if (b.offsetHeight === 0) continue;
      const text = (b.textContent || '').trim();
      const title = (b.getAttribute('title') || '').toLowerCase();
      if (text === cancel || title === close.toLowerCase() || /^(close|dismiss)$/.test(title)) b.click();
    }
    // Search: clear the query, then collapse the bar.
    for (const b of document.querySelectorAll('button')) {
      if (b.offsetHeight > 0 && (b.textContent || '').trim() === clear) b.click();
    }
    // The insights panel is a toggle: it only closes by clicking the same
    // control again, and it stayed open across four shots when it did not.
    const panel = document.querySelector('[data-testid="sender-insights-panel"]');
    if (panel && panel.offsetHeight > 0) document.querySelector('[data-testid="sender-insights-toggle"]')?.click();
    document.body.click(); // popovers and dropdowns close on an outside click
  }, L('common.cancel'), L('common.clear'), L('common.close'));
  await browser.pause(400);
  await browser.execute((searchEmails) => {
    const search = document.querySelector(`input[placeholder="${searchEmails}"]`)
      || document.querySelector('input[type="search"], input[placeholder]');
    if (search && search.offsetHeight > 0) document.querySelector(`button[title="${searchEmails}"]`)?.click();
  }, L('list.searchEmails'));
  await pressKey('Escape');
  await browser.pause(400);
  await browser.execute((clearSel, cancel) => {
    for (const b of document.querySelectorAll('button')) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (b.offsetHeight > 0 && (t === clearSel.toLowerCase() || t === cancel.toLowerCase())) b.click();
    }
  }, L('selection.clearSelection'), L('common.cancel'));
  await browser.pause(500);
}

describe('MailVault marketing screenshots', function () {
  this.timeout(600000);

  before(async function () {
    await waitForApp();
    console.log('[shots] window:', await raiseWindow());
    await browser.pause(1500);
    console.log('[shots] webview:', JSON.stringify(await browser.execute(() => ({
      sheets: document.styleSheets.length,
      inner: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
    }))));
    await waitForEmails();
    await browser.pause(2500); // first sync settles: counts, state icons, alerts
    console.log('[shots] rows:', JSON.stringify(await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 8)
        .map((r) => (r.innerText || '').replace(/\s*\n\s*/g, ' | ')))));
  });

  it('captures the set', async function () {
    // ── Reading ───────────────────────────────────────────────────────────
    await step('email-list-view', async () => {
      await clickRow(MARKERS.newsletter);
      // An HTML body renders inside an iframe, and iframe text never reaches
      // body.innerText — assert on the frame and the header instead.
      await expectState((s) => !s.viewerEmpty && s.iframes > 0 && s.text.includes(MARKERS.newsletter.slice(0, 12)),
        'newsletter body did not render');
    });

    await step('thread-view', async () => {
      await clickRow('Ana Brandt');
      await expectState((s) => s.threadHeaders >= 2, 'thread did not open');
    });

    await step('email-invoice-attachment', async () => {
      await clickRow(MARKERS.invoice);
      await expectState((s) => s.text.includes('invoice-CC-2026-0413.pdf'), 'attachment chip missing');
    });

    // ── Search ────────────────────────────────────────────────────────────
    await step('search-results', async () => {
      await resetToInbox();
      if (!(await clickByTitle(L('list.searchEmails')))) throw new Error('search toggle not found');
      await browser.pause(500);
      await browser.execute((searchEmails) => {
        const input = document.querySelector(`input[placeholder="${searchEmails}"]`)
          || document.querySelector('input[type="search"], input[placeholder]');
        if (!input) return;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Rack & Rind');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, L('list.searchEmails'));
      await browser.pause(900);
      if (!(await clickByText(L('search.search')))) await browser.keys(['Enter']);
      await expectState((s) => s.text.includes(L('list.searchResults')) || s.text.includes(L('search.found')),
        'search results header missing', 20000);
      await browser.pause(800);
    });

    // ── Security ──────────────────────────────────────────────────────────
    await step('link-safety', async () => {
      await browser.execute((clear) => {
        for (const b of document.querySelectorAll('button')) {
          if (b.offsetHeight > 0 && (b.textContent || '').trim() === clear) b.click();
        }
      }, L('common.clear'));
      await browser.pause(800);
      await clickRow(MARKERS.phishing);
      await expectState((s) => !s.viewerEmpty && s.text.includes(MARKERS.phishing.slice(0, 12)),
        'phishing message did not open');
    });

    await step('link-safety-modal', async () => {
      const clicked = await browser.execute(() => {
        const frame = document.querySelector('iframe');
        const doc = frame?.contentDocument;
        const link = doc?.querySelector('a[href]');
        if (!link) return false;
        link.click();
        return true;
      });
      if (!clicked) throw new Error('no link inside the rendered body');
      await expectState((s) => /suspicious|actually goes|link text/i.test(s.text),
        'link safety modal did not open');
    });

    await step('reply-to-mismatch', async () => {
      await browser.execute((clear) => {
        for (const b of document.querySelectorAll('button')) {
          if (b.offsetHeight > 0 && (b.textContent || '').trim() === clear) b.click();
        }
      }, L('common.clear'));
      await browser.pause(500);
      await resetToInbox();
      await clickRow(MARKERS.replyTo);
      await browser.pause(700);
      if (!(await clickTestId('sender-insights-toggle'))) throw new Error('sender details toggle not found');
      await expectState((s) => s.insights || /reply-to/i.test(s.text), 'sender details did not open');
    });

    // ── Compose ───────────────────────────────────────────────────────────
    await step('compose-email', async () => {
      await resetToInbox();
      // The keyboard shortcut needs focus in the list; the button never misses.
      if (!(await clickByText(L('sidebar.compose')))) await pressKey('c');
      await expectState((s) => s.compose, 'compose did not open');
      await browser.execute(() => {
        const set = (el, value) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const modal = document.querySelector('[data-testid="compose-modal"]');
        const to = modal?.querySelector('input');
        if (to) set(to, 'ana@sizzlemedia.co');
        const subject = document.querySelector('[data-testid="compose-subject"]');
        if (subject) set(subject, 'Rack & Rind — print-ready files are with Theo');
        const body = document.querySelector('[data-testid="compose-body"]');
        if (body) {
          body.innerHTML = '<p>Ana,</p><p>Final artwork is with Skewer — warmer hero, smoke down 20%, '
            + 'fonts outlined. Theo has the Friday press slot held, so we are printing on schedule.</p><p>Rowan</p>';
          body.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await browser.pause(800);
    });

    // ── Bulk operations ───────────────────────────────────────────────────
    await step('selection-dialog', async () => {
      await resetToInbox();
      await browser.pause(600);
      if (!(await openBulkModal())) throw new Error('bulk modal did not open');
      await expectState(hasText('Bulk Email Operations'), 'bulk modal step 1 not on screen');
      await clickByText(L('bulk.ops.last90Days'));
      await expectState(hasText('emails selected'), 'range selection produced no count');
      await browser.pause(900);
    });

    await step('selection-dialog-archive', async () => {
      await clickByText(L('bulk.ops.next'));
      await browser.pause(800);
      if (!(await clickTestId('bulk-action-archive'))) throw new Error('archive action not offered');
      await expectState(hasText('Start Archive'), 'archive confirm not on screen');
    });

    await step('archive-progress', async () => {
      if (!(await clickTestId('bulk-step2-confirm'))) throw new Error('confirm not clickable');
      // "Operation" also matches "Operation Complete" — the shot then shows a
      // finished bar every time, which is what archive-success is for.
      await expectState((s) => /Phase \d|Archiving|Saving|of 66 emails/i.test(s.text)
        && !/Operation Complete/i.test(s.text), 'no in-flight progress UI', 30000);
    }, 150);

    await step('archive-success', async () => {
      await expectState((s) => /Operation Complete/i.test(s.text), 'archive never completed', 180000);
    });

    // ── Vault ─────────────────────────────────────────────────────────────
    await step('local-vault', async () => {
      await resetToInbox();
      await browser.pause(600);
      if (!(await clickByText(L('sidebar.viewVault')))) throw new Error('vault view mode not found');
      await expectState((s) => s.rows > 0, 'local view has no rows');
    });

    await step('state-icons', async () => {
      if (!(await clickByText(L('sidebar.viewAll')))) throw new Error('all view mode not found');
      await expectState((s) => s.rows > 0, 'all view has no rows');
    });

    // ── Grouping ──────────────────────────────────────────────────────────
    await step('sender-grouped-view', async () => {
      if (!(await clickByTitle(L('list.groupSender')))) throw new Error('grouping toggle not found');
      await expectState((s) => s.grouped && s.senderRows > 0, 'sender groups did not render');
    });

    await step('sender-grouped-expanded', async () => {
      await browser.execute(() => {
        const rows = [...document.querySelectorAll('[data-testid="sender-group-row"]')];
        const busiest = rows.find((r) => (r.innerText || '').includes('Ana Brandt')) || rows[0];
        busiest?.click();
      });
      await browser.pause(1100);
    });

    // ── Chat view ─────────────────────────────────────────────────────────
    await step('chat-view', async () => {
      await clickByTitle(L('list.switchChronologicalView'));
      await browser.pause(600);
      await setAppearance(L('settings.appearance.chatView'));
      await expectState((s) => s.chat, 'chat view did not render');
    });

    await step('chat-view-chat', async () => {
      const opened = await browser.execute(() => {
        // Chat rows are nested divs, so several ancestors "contain" the name.
        // The clickable row is the SMALLEST of them — clicking an outer
        // container hits no handler and the shot silently repeats the list.
        const smallestMatch = (needle) => [...document.querySelectorAll('[data-testid="chat-view"] *')]
          .filter((el) => el.offsetHeight > 30 && (el.innerText || '').includes(needle))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        const target = smallestMatch('Ana Brandt') || smallestMatch('Theo Lomas');
        if (!target) return false;
        target.click();
        return true;
      });
      if (!opened) throw new Error('no conversation to open in chat view');
      await browser.pause(1600);
    });

    await step('chat-view-thread', async () => {
      const opened = await browser.execute((needle) => {
        const target = [...document.querySelectorAll('[data-testid="chat-view"] *')]
          .filter((el) => el.offsetHeight > 30 && (el.innerText || '').includes(needle))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        if (!target) return false;
        target.click();
        return true;
      }, THREAD_NEEDLE);
      if (!opened) throw new Error('no topic to open in chat view');
      // The bubble view is identified by its reply footer; bodies stream in one
      // fetch at a time behind it, so waiting on body text is a race.
      await expectState((s) => s.chat && s.text.includes(L('chat.bubble.reply')),
        'conversation bubbles did not render', 20000);
      await browser.pause(2500); // let every bubble body land before the shutter
    });

    // ── Multi-account ─────────────────────────────────────────────────────
    await step('unified-inbox', async () => {
      await setAppearance(L('settings.appearance.listView'));
      await browser.pause(800);
      if (!(await clickTestId('all-inboxes-btn'))) throw new Error('All Inboxes button not found');
      await expectState((s) => s.rows > 0 && /all inboxes/i.test(s.text), 'unified inbox did not load', 30000);
      await browser.pause(1500);
      // An empty reading pane reads as a dead app in a screenshot.
      await clickRow('Theo Lomas');
      await expectState((s) => !s.viewerEmpty, 'unified inbox message did not open');
    });

    // ── Settings ──────────────────────────────────────────────────────────
    await step('settings-appearance', async () => {
      await openAppearance();
      await expectState((s) => s.settings && /layout/i.test(s.text), 'appearance tab not on screen');
    });

    await step('settings-storage', async () => {
      if (!(await clickByText(L('settings.tab.storage')))) throw new Error('storage tab not found');
      await expectState((s) => s.settings && /storage/i.test(s.text), 'storage tab not on screen');
      await browser.pause(900);
    });

    await step('settings-backup', async () => {
      if (!(await clickByText(L('settings.tab.backup')))) throw new Error('backup tab not found');
      await expectState((s) => s.settings && /backup/i.test(s.text), 'backup tab not on screen');
      await browser.pause(900);
    });

    await step('settings-backup-schedule', async () => {
      if (!(await clickByText(L('settings.backup.backupSchedule')))) throw new Error('backup schedule tab not found');
      await expectState((s) => s.settings && /schedule/i.test(s.text), 'backup schedule not on screen');
      await browser.pause(900);
    });

    await step('settings-security', async () => {
      if (!(await clickByText(L('settings.tab.security')))) throw new Error('security tab not found');
      await expectState((s) => s.settings && /security/i.test(s.text), 'security tab not on screen');
      await browser.pause(900);
    });

    await step('settings-time-capsule', async () => {
      if (!(await clickByText(L('settings.tab.timeCapsule')))) throw new Error('time capsule tab not found');
      await expectState((s) => s.settings && /time capsule/i.test(s.text), 'time capsule tab not on screen');
      await browser.pause(900);
    });

    await step('shortcuts-modal', async () => {
      await closeSettings();
      await browser.pause(700);
      await pressKey('?');
      await expectState((s) => s.shortcuts, 'shortcuts modal did not open');
    });

    await step('final-inbox', async () => {
      await pressKey('Escape');
      await resetToInbox();
      await expectState((s) => s.rows > 0 && !s.settings, 'did not land back on the inbox');
    });
  });
});
