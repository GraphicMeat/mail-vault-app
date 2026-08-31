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
import { raiseWindow } from './window.js';
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

/**
 * The longest literal run of a format string — the part that is on screen
 * verbatim, whatever the placeholder interpolates to.
 *
 * Deleting the placeholders and keeping the rest only works when they sit at
 * the edges. Chinese puts this one in the middle:
 * `已选择 {{selectedCount}} 封邮件` collapses to `已选择  封邮件`, with a double
 * space where the number belongs — a string the DOM can never contain.
 */
const literalRun = (key) => L(key)
  .split(/\{\{.*?\}\}/)
  .map((part) => part.trim())
  .filter(Boolean)
  .sort((a, b) => b.length - a.length)[0];

const SELECTED_COUNT = literalRun('bulk.ops.emailsSelected');

/** The phase words the bulk progress bubble shows while it is still working. */
const IN_FLIGHT = [
  L('bulk.progress.downloading'),
  L('bulk.progress.verifying'),
  L('bulk.progress.deleting'),
  L('bulk.progress.removingVault'),
];


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
    // "Start Archive" appears in no catalog, so its text cannot be asserted in
    // any language but English. The testid can.
    bulkConfirm: !!document.querySelector('[data-testid="bulk-step2-confirm"]'),
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

// ── Shot plumbing ───────────────────────────────────────────────────────────

async function shot(name, settle = SETTLE) {
  await browser.pause(settle);
  const state = await probe();
  console.log(`[state] ${name}`, JSON.stringify({ ...state, text: state.text.slice(0, 120) }));
  // Clicking through the sidebar/list leaves a focus ring on whatever was
  // clicked last, and it rides along into the capture. Guarded: some shots
  // deliberately show a focused field with a caret (compose, search).
  await browser.execute(() => {
    const el = document.activeElement;
    if (el && el !== document.body && !/^(INPUT|TEXTAREA)$/.test(el.tagName) && !el.isContentEditable) el.blur();
  });
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
      await expectState((s) => [
        L('linkSafety.suspiciousLinkDetected'),
        L('linkSafety.dangerousLinkDetected'),
        L('linkSafety.linkTextSays'),
      ].some((phrase) => s.text.includes(phrase)),
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
      await expectState((s) => s.insights, 'sender details did not open');
    });

    /**
     * The dialog, not just the glyph.
     *
     * `reply-to-mismatch` above shows the warning MARK on the row and in the
     * sender panel — useful, but it never opens the explanation. Settings →
     * Security lists "Reply-To domain mismatch" and needs the picture of what
     * that alert actually says, so this shoots the open dialog.
     *
     * Clicked by testid, not by aria-label: the label is translated, so a
     * capture keyed on it would find nothing in eight of nine locales.
     */
    await step('safety-reply-to-modal', async () => {
      if (!(await clickTestId('reply-to-alert-icon'))) throw new Error('reply-to warning glyph not found');
      await expectState((s) => s.text.includes(L('alert.replyTo.repliesWouldGo'))
                            || s.text.includes(L('alert.replyTo.sentDomain')),
        'reply-to dialog did not open');
    });

    await step('safety-sender-impersonation', async () => {
      // Close the reply-to dialog the previous step left open. resetToInbox()
      // presses Escape too, but its first pass clicks buttons BY TEXT and a
      // Dialog's close control is an icon with no text, so the explicit press
      // is what actually shuts it.
      await pressKey('Escape');
      await browser.pause(300);
      await resetToInbox();
      await clickRow(MARKERS.impersonation);
      await browser.pause(700);
      if (!(await clickTestId('sender-alert-icon'))) throw new Error('sender warning glyph not found');
      // Assert on the BODY copy, not the title: the title differs by severity
      // ('impersonation detected' vs 'suspicious sender name') and this fixture
      // must hit the red one — a yellow result means the fixture stopped
      // triggering Layer 0 and the shot would quietly show the wrong alert.
      await expectState((s) => s.text.includes(L('alert.sender.displayNameShows'))
                            && s.text.includes(L('alert.sender.senderImpersonationDetected')),
        'sender impersonation dialog did not open');
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
      await expectState(hasText(L('bulk.ops.bulkEmailOperations')), 'bulk modal step 1 not on screen');
      await clickByText(L('bulk.ops.last90Days'));
      await expectState(hasText(SELECTED_COUNT), 'range selection produced no count');
      await browser.pause(900);
    });

    await step('selection-dialog-archive', async () => {
      await clickByText(L('common.next'));
      await browser.pause(800);
      if (!(await clickTestId('bulk-action-archive'))) throw new Error('archive action not offered');
      await expectState((s) => s.bulkConfirm, 'archive confirm not on screen');
    });

    await step('archive-progress', async () => {
      if (!(await clickTestId('bulk-step2-confirm'))) throw new Error('confirm not clickable');
      // "Operation" also matches "Operation Complete" — the shot then shows a
      // finished bar every time, which is what archive-success is for.
      //
      // The old assertion also matched a literal `of 66 emails`; the mailbox is
      // date-relative, so that count expired and the shot spun for 30s while
      // the real operation finished without it.
      await expectState((s) => IN_FLIGHT.some((phase) => s.text.includes(phase))
        && !s.text.includes(L('bulk.progress.operationComplete')), 'no in-flight progress UI', 30000);
    }, 150);

    await step('archive-success', async () => {
      await expectState((s) => s.text.includes(L('bulk.progress.operationComplete')), 'archive never completed', 180000);
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
      await expectState((s) => s.rows > 0 && s.text.includes(L('sidebar.allInboxes')), 'unified inbox did not load', 30000);
      await browser.pause(1500);
      // An empty reading pane reads as a dead app in a screenshot.
      await clickRow('Theo Lomas');
      await expectState((s) => !s.viewerEmpty, 'unified inbox message did not open');
    });

    // ── Settings ──────────────────────────────────────────────────────────
    await step('settings-appearance', async () => {
      await openAppearance();
      await expectState((s) => s.settings && s.text.includes(L('settings.appearance.theme')), 'appearance tab not on screen');
    });

    await step('settings-storage', async () => {
      if (!(await clickByText(L('settings.tab.storage')))) throw new Error('storage tab not found');
      await expectState((s) => s.settings && s.text.includes(L('settings.storage.storageStatus')), 'storage tab not on screen');
      await browser.pause(900);
    });

    await step('settings-backup', async () => {
      if (!(await clickByText(L('settings.tab.backup')))) throw new Error('backup tab not found');
      await expectState((s) => s.settings && s.text.includes(L('settings.backup.backupSettings')), 'backup tab not on screen');
      await browser.pause(900);
    });

    await step('settings-backup-schedule', async () => {
      if (!(await clickByText(L('settings.backup.backupSchedule')))) throw new Error('backup schedule tab not found');
      await expectState((s) => s.settings && s.text.includes(L('settings.backup.backupSchedule')), 'backup schedule not on screen');
      await browser.pause(900);
    });

    await step('settings-security', async () => {
      if (!(await clickByText(L('settings.tab.security')))) throw new Error('security tab not found');
      await expectState((s) => s.settings && s.text.includes(L('settings.security.linkSafetyScanning')), 'security tab not on screen');
      await browser.pause(900);
    });

    await step('settings-time-capsule', async () => {
      if (!(await clickByText(L('settings.tab.timeCapsule')))) throw new Error('time capsule tab not found');
      // With billingProfile seeded the real panel renders for every locale —
      // wait for the create-snapshot control, which exists only once the
      // feature is unlocked. Matching the gate copy here would have passed
      // forever and never noticed entitlement working.
      await expectState((s) => s.settings && s.text.includes(L('timeCapsule.takeSnapshot')),
        'time capsule tab not on screen');
      await browser.pause(900);
    });

    // ── Premium features ─────────────────────────────────────────────────
    //
    // billingProfile is seeded premium (wdio.screenshots.conf.js), so every
    // one of these renders the real feature, not the blur overlay or the
    // upsell card. Each step opens Settings itself rather than assuming it is
    // still open from the previous one, so SHOTS_ONLY can capture any single
    // one of these standalone.

    await step('premium-backup-schedule', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.backup'));
      await browser.pause(400);
      // The gated schedule/verification UI lives one level deeper, in the
      // Backup tab's own "Backup Schedule" sub-tab (BackupSettings.jsx:10) —
      // the top-level tab opens on the ungated "Backup Settings" sub-tab
      // first, which is why the wait below never used to see it.
      if (!(await clickByText(L('settings.backup.backupSchedule')))) throw new Error('backup schedule sub-tab not found');
      await browser.pause(400);
      // The frequency picker only renders once the global switch is on
      // (seeded backupGlobalEnabled) — the free state shows a disabled toggle
      // and nothing below it.
      await expectState(hasText(L('settings.backup.schedule.backupFrequency')),
        'backup frequency picker not on screen');
    });

    await step('premium-backup-health', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.backup'));
      await browser.pause(400);
      // The gated schedule/verification UI lives one level deeper, in the
      // Backup tab's own "Backup Schedule" sub-tab (BackupSettings.jsx:10) —
      // the top-level tab opens on the ungated "Backup Settings" sub-tab
      // first, which is why the wait below never used to see it.
      if (!(await clickByText(L('settings.backup.backupSchedule')))) throw new Error('backup schedule sub-tab not found');
      await browser.pause(400);
      if (!(await clickByText(L('settings.backup.account.verifyBackupCoverage')))) {
        throw new Error('verify backup coverage control not found');
      }
      // A real check against the mock IMAP server and the local maildir —
      // reachable at all only because the account card is unlocked.
      await $('[data-testid="backup-verification-tree"]').waitForExist({ timeout: 15000 });
      // BackupAccountCard does not omit the locked UI, it BLURS a live copy of
      // it (opacity/blur + pointer-events-none, with an upsell on top) — and
      // pointer-events-none does not stop the el.click() clickByText uses, so
      // the button above is reachable and the tree still mounts even locked.
      // Only this overlay's absence actually proves the seed unlocked it.
      if (await $('[data-testid="backup-schedule-locked"]').isExisting()) {
        throw new Error('backup card is still behind the locked overlay — entitlement not applied');
      }
      await browser.pause(400);
    });

    await step('premium-cleanup', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.cleanup'));
      // The classifier auto-runs against the demo mailbox the moment this
      // view mounts unlocked; the summary cards exist only once premium AND
      // real results have landed, never for the free lock screen.
      await $('[data-testid="cleanup-summary"]').waitForExist({ timeout: 45000 });
    }, 1200);

    await step('premium-auto-cleanup', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.storage'));
      await browser.pause(600);
      // Two seeded rules (wdio.screenshots.conf.js) so this shows configured
      // rules rather than "no rules yet".
      const row = await $('[data-testid="cleanup-rule-row"]');
      await row.waitForExist({ timeout: 8000 });
      await row.scrollIntoView({ block: 'center' });
    });

    await step('premium-time-capsule', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.timeCapsule'));
      await browser.pause(400);
      // Snapshots live on disk, not in seeded settings — take a real one from
      // the already-synced demo mailbox so the list shows an actual entry
      // instead of "no snapshots yet".
      if (!(await clickByText(L('timeCapsule.takeSnapshot')))) throw new Error('take snapshot control not found');
      await $('[data-testid="snapshot-row"]').waitForExist({ timeout: 20000 });
    }, 1000);

    // Tracker removal: the switch and the stripped-beacon sample, not the upsell
    // card — with billingProfile seeded the real view renders for everyone.
    await step('premium-tracker-blocking', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.tracking'));
      await browser.pause(400);
      // Wait for a control that exists only when the feature is unlocked. Waiting
      // on the gate copy would pass forever and prove nothing.
      await $('[data-testid="tracker-blocking-toggle"]').waitForExist({ timeout: 5000 });
    });

    await step('premium-migration', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.migration'));
      // A seeded in-flight job (wdio.screenshots.conf.js) so the shot shows
      // real progress and a folder checklist — "progress you can watch" —
      // instead of step 1 of an empty wizard.
      await $('[data-testid="migration-progress"]').waitForExist({ timeout: 8000 });
      // MigrationSettings does not omit mainContent when locked, it BLURS the
      // same live tree (opacity/blur + pointer-events-none) under an upsell —
      // so migration-progress mounts either way once activeMigration is
      // seeded. Only this overlay's absence actually proves it is unlocked.
      if (await $('[data-testid="migration-locked"]').isExisting()) {
        throw new Error('migration panel is still behind the locked overlay — entitlement not applied');
      }
      await browser.pause(400);
    });

    await step('premium-server-change', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.accounts'));
      await browser.pause(500);
      // Unlike the rest of this section, Change Server has no entitlement gate
      // today — the modal opens for every user. This shot proves the guided
      // flow renders; it is not evidence of an unlock.
      if (!(await clickByText(L('settings.accounts.changeServer')))) throw new Error('change server control not found');
      await expectState(hasText(L('changeServer.imapHost')), 'change server dialog not on screen');
    });

    await step('premium-export-image', async () => {
      await closeSettings();
      await browser.pause(500);
      await resetToInbox();
      await clickRow(MARKERS.newsletter);
      await browser.pause(500);
      // Was `clickByTitle('Export')` with a comment explaining that the action
      // bar hardcoded English. `77fd5ca7` localized EmailActionBar, so the
      // literal stopped matching and this step skipped in all eight non-English
      // locales — English kept passing, which is why it went unnoticed. The
      // stale premium-export-image captures from the previous sweep survived,
      // so the run looked like it had produced them.
      if (!(await clickByTitle(L('common.export')))) throw new Error('export control not found');
      await expectState(hasText(L('export.dialog.mirrorRemoteContent')), 'export dialog not on screen');
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
