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

/**
 * A `<select>` driven the way React can hear it. WebDriver's own select
 * interaction sets `value` on the element, which React's onChange never sees —
 * the control shows the new option and the app keeps the old state, which is a
 * screenshot of a lie rather than an error.
 */
const setSelect = (testId, value) => browser.execute((id, v) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el || el.offsetHeight === 0) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, testId, value);

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
    // What the run actually photographed. The theme lives in its own persisted
    // store, so a seed that misses it produces a whole set in the wrong colours
    // and nothing in the log says so.
    theme: document.documentElement.getAttribute('data-theme') || '',
    palette: document.documentElement.getAttribute('data-palette') || '',
    settings: vis('[data-testid="settings-page"]'),
    // Which Settings tab is open, in no language at all — the labels moved
    // when Settings was redesigned and text finders moved with them.
    settingsPage: document.querySelector('[data-testid="settings-content"]')?.dataset.page || '',
    listTitle: (document.querySelector('[data-testid="mailbox-title"]')?.textContent || '').trim(),
    snapshotRows: document.querySelectorAll('[data-testid="settings-content"][data-page="time-capsule"] div[role="button"]').length,
    // The failure message truncates `text`, and the sidebar eats the whole
    // budget before the settings panel starts. Carry the panel's own words.
    settingsText: (document.querySelector('[data-testid="settings-content"]')?.innerText || '')
      .replace(/\s+/g, ' ').slice(0, 260),
    searchInput: !!document.querySelector('[data-testid="mail-search-input"]'),
    chat: vis('[data-testid="chat-view"]'),
    compose: vis('[data-testid="compose-modal"]'),
    shortcuts: vis('[data-testid="shortcuts-modal"]'),
    insights: vis('[data-testid="sender-insights-panel"]'),
    // The Insights workspace, not the per-sender panel above it: two different
    // features whose names collide. `data-status` is the store's own state, so
    // a shot never has to guess whether the snapshot finished.
    insightsPage: document.querySelector('[data-testid="insights-page"]')?.dataset.status || '',
    insightsTab: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.testid || '',
    explorer: document.querySelector('[data-testid="explorer-view"]')?.dataset.grouping || '',
    explorerGroups: document.querySelectorAll('[data-testid="explorer-group-row"]').length,
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
  // The blur above lands in the DOM before this returns, but WebKit repaints on
  // its next frame: a capture taken immediately still shows the ring a dialog's
  // auto-focused close button was wearing.
  await browser.pause(150);
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

/**
 * Settings → Appearance. Appearance used to be a panel inside General and is
 * now a top-level tab with its own sub-tabs (colors / layout / reading /
 * date-time), so the old two-click path silently landed on General and every
 * option lookup below it failed.
 *
 * `section` is a sub-tab id, asserted through `data-page` rather than a label:
 * the tab strip is translated and the ids are not.
 */
async function openAppearance(section = 'colors') {
  await openSettings();
  await browser.pause(500);
  if (!(await clickByText(L('settings.appearance.appearance')))) {
    throw new Error('Appearance tab not found in Settings');
  }
  await browser.pause(500);
  if (section !== 'colors') {
    if (!(await clickByText(L(`settings.appearance.section.${section}`)))) {
      throw new Error(`appearance section not found: ${section}`);
    }
    await browser.pause(400);
  }
}

/**
 * Appearance is a persisted setting, so a shot can set it at the store instead
 * of clicking a Settings page whose tabs and labels have already moved once.
 * The store's own setter runs first when there is one — some of them do more
 * than assign.
 */
async function setSetting(key, value) {
  const ok = await browser.execute((k, v) => {
    const store = window.__SETTINGS_STORE__;
    if (!store) return false;
    const state = store.getState();
    const setter = `set${k.charAt(0).toUpperCase()}${k.slice(1)}`;
    if (typeof state[setter] === 'function') state[setter](v);
    else store.setState({ [k]: v });
    return true;
  }, key, value);
  if (!ok) throw new Error(`__SETTINGS_STORE__ missing — is this a VITE_E2E build? (${key})`);
  await browser.pause(600);
}

/**
 * Both highlighting shots are about row GROUNDS, so the list must not read as
 * mid-scroll: clicking a row part way down leaves a half-row clipped under the
 * header. (The migration toast in the corner stays: `wdio.screenshots.conf.js`
 * seeds a job "already in flight" on purpose, so every shot in a run carries
 * it.)
 */
async function settleListForHighlightShot() {
  await browser.execute(() => {
    // The list has no testid of its own: walk up from a row to the first
    // ancestor that actually scrolls. Snap to the row grid rather than to the
    // top - scrolling to 0 puts the open message's conversation below the fold,
    // and the conversation IS what the second shot is about.
    const row = document.querySelector('[data-testid="email-row"]');
    let el = row?.parentElement;
    while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
    if (!el || !row) return;
    const h = row.getBoundingClientRect().height || 56;
    el.scrollTo({ top: Math.round(el.scrollTop / h) * h });
  });
  await browser.pause(500);
}

/**
 * The select-messages control opens the bulk operations modal. It used to be
 * the only button in `email-list-header`; it now lives in the toolbar below,
 * and "the first button in the header" is the search toggle — which opened
 * search and cost three shots in a row before anything said so.
 */
const openBulkModal = (label) => browser.execute((selectMessages) => {
  const btn = document.querySelector(`.mail-list-toolbar button[aria-label="${selectMessages}"]`)
    || document.querySelector(`button[aria-label="${selectMessages}"]`);
  if (!btn || btn.offsetHeight === 0) return false;
  btn.click();
  return true;
}, label);

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
  // A search that actually RAN leaves the list filtered to its results, and
  // every row finder below it then fails with "no row matching …". Nothing here
  // used to clear it because the search step had been silently failing; the
  // header's own control is labelled `list.clearSearch`, not `common.clear`.
  await browser.execute(() => {
    const store = window.__SEARCH_STORE__;
    if (store && typeof store.getState().clearSearch === 'function') store.getState().clearSearch();
    const search = document.querySelector('[data-testid="mail-search-input"]');
    if (search && search.offsetHeight > 0) document.querySelector('[data-testid="mail-search-toggle"]')?.click();
  });
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

/**
 * Back to the work account's own INBOX.
 *
 * `resetToInbox` clears modals and selection, not navigation: `unified-inbox`
 * leaves the run in All Inboxes across three accounts and nothing switches
 * back. The rows the shots below click live in ONE mailbox, so the account and
 * the folder have to be named, not assumed. `aria-label` carries the address
 * whatever the sidebar density hides, and folder rows carry an untranslated
 * `data-path`.
 */
async function openWorkInbox() {
  // The sidebar is behind the Settings page, and `resetToInbox` does not close
  // it — the premium block before this leaves Settings open, so the account
  // button this clicks was not on screen at all.
  await closeSettings();
  await browser.pause(500);
  const email = browser.demoAccounts[0].email;
  await browser.execute((mail) => {
    document.querySelector(`.sidebar-account-open[aria-label*="${mail}"]`)?.click();
  }, email);
  await browser.pause(900);
  await browser.execute(() => {
    document.querySelector('[data-testid="folder-row"][data-path="INBOX"]')?.click();
  });
  await browser.pause(900);
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

    // ── Row highlighting: the two Appearance options ──────────────────────
    // Threading goes flat first: the marking mode's lighter grey lands on the
    // REST of the open message's conversation, and grouped mode collapses that
    // conversation into the single row you just opened.
    await step('list-highlight-hover', async () => {
      await setSetting('threadMode', 'flat');
      await clickRow(MARKERS.thread);
      await expectState((s) => !s.viewerEmpty, 'no message open for the highlighting shots');
      await settleListForHighlightShot();
    });

    await step('list-highlight-selection', async () => {
      await setSetting('emailRowHighlight', 'selection');
      await expectState((s) => !s.viewerEmpty, 'the open message did not survive the setting change');
      await settleListForHighlightShot();
    });

    // Back to the appearance the rest of the run — and the seed — assumes.
    await setSetting('emailRowHighlight', 'hover');
    await setSetting('threadMode', 'expandable');
    await resetToInbox();

    await step('email-invoice-attachment', async () => {
      await clickRow(MARKERS.invoice);
      await expectState((s) => s.text.includes('invoice-CC-2026-0413.pdf'), 'attachment chip missing');
    });

    // ── Search ────────────────────────────────────────────────────────────
    await step('search-results', async () => {
      await resetToInbox();
      // Both controls carry a testid now. The old finders keyed on
      // `list.searchEmails`, which is the toggle's TITLE but not the input's
      // placeholder (`search.searchEmails`), so the fallback selector typed
      // into whichever input happened to be first in the document.
      if (!(await clickTestId('mail-search-toggle'))) throw new Error('search toggle not found');
      // The panel mounts on the next render. Typing into a null input used to
      // fail silently here and the step died two asserts later on a screen that
      // had never been searched.
      await expectState((s) => s.searchInput, 'search panel did not open');
      await browser.execute(() => {
        const input = document.querySelector('[data-testid="mail-search-input"]');
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Rack & Rind');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await browser.pause(900);
      // `search.search` and `workspace.search` are BOTH "Search", and the
      // toggle in the header comes first in the DOM — clicking by text hit the
      // toggle and closed the panel it had just opened. Submit the form the
      // panel owns instead.
      const submitted = await browser.execute(() => {
        const btn = document.querySelector('#mail-search-panel button[type="submit"]');
        if (!btn || btn.offsetHeight === 0) return false;
        btn.click();
        return true;
      });
      if (!submitted) await browser.keys(['Enter']);
      // The list header is the one place that says a search actually ran: it
      // swaps the mailbox name for "Search Results" only when searchActive.
      await expectState((s) => s.listTitle === L('list.searchResults'),
        'search results header missing', 20000);
      await browser.pause(800);
    });

    // ── Security ──────────────────────────────────────────────────────────
    await step('link-safety', async () => {
      // This used to click any button labelled `common.clear`, which is not the
      // control that ends a search — `resetToInbox` knows how, and has to run
      // here now that the search step actually searches.
      await resetToInbox();
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
      if (!(await openBulkModal(L('workspace.selectMessages')))) throw new Error('bulk modal did not open');
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
      // The source chips carry a per-mode `title` (`workspace.sourceHint.<id>`)
      // and that is an EXACT match; their visible labels are not what the
      // harness thought. See state-icons below for what the text finder cost.
      if (!(await clickByTitle(L('workspace.sourceHint.local')))) throw new Error('vault view mode not found');
      await expectState((s) => s.rows > 0, 'local view has no rows');
    });

    await step('state-icons', async () => {
      // The chip renders `sidebar.allMail` ("All mail"), not `sidebar.viewAll`
      // ("All") — and `clickByText` matches on startsWith, so English and
      // German passed by luck ("All mail" starts with "All", "Alle E-Mails"
      // with "Alle") while Italian skipped outright ("Tutta la posta" does not
      // start with "Tutto") and French silently clicked whatever else began
      // with "Tout". Match the exact per-mode title instead.
      if (!(await clickByTitle(L('workspace.sourceHint.all')))) throw new Error('all view mode not found');
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
      await setSetting('viewStyle', 'chat');
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
      await setSetting('viewStyle', 'list');
      await browser.pause(800);
      if (!(await clickTestId('all-inboxes-btn'))) throw new Error('All Inboxes button not found');
      await expectState((s) => s.rows > 0 && s.text.includes(L('sidebar.allInboxes')), 'unified inbox did not load', 30000);
      await browser.pause(1500);
      // An empty reading pane reads as a dead app in a screenshot.
      await clickRow('Theo Lomas');
      await expectState((s) => !s.viewerEmpty, 'unified inbox message did not open');
    });

    // ── Explorer ──────────────────────────────────────────────────────────
    // Explorer is a mode of the message list, so it has to be left again
    // before anything downstream photographs a list: `resetToInbox` knows
    // nothing about it.
    await step('explorer-date', async () => {
      await resetToInbox();
      if (!(await clickTestId('mail-view-explorer'))) throw new Error('Explorer control not found');
      if (!(await setSelect('explorer-grouping', 'date'))) throw new Error('grouping select not found');
      await expectState((s) => s.explorer === 'date' && s.explorerGroups > 0, 'Explorer date groups did not render');
    });

    await step('explorer-sender', async () => {
      if (!(await setSelect('explorer-grouping', 'sender'))) throw new Error('grouping select not found');
      await expectState((s) => s.explorer === 'sender' && s.explorerGroups > 0, 'Explorer sender groups did not render');
    });

    await step('explorer-conversation', async () => {
      if (!(await setSelect('explorer-grouping', 'conversation'))) throw new Error('grouping select not found');
      await expectState((s) => s.explorer === 'conversation' && s.explorerGroups > 0,
        'Explorer conversation groups did not render');
    });

    /**
     * The panel is taller than the window, and the chart is the bottom half of
     * it. Left at scroll 0 the shot is all toolbar and half a bubble map, so
     * bring the tab strip up under the header and let the chart have the frame.
     */
    const frameInsights = () => browser.execute(() => {
      const scroller = document.querySelector('[data-testid="insights-page"] .insights-scroll');
      const tabs = document.querySelector('.insights-tabs');
      if (!scroller || !tabs) return false;
      // `offsetTop` is measured against the nearest positioned ancestor, which
      // is not this scroller — using it overshoots and pushes the tab strip
      // ("Sender map / Timeline / Activity") off the top edge, so the shot
      // loses the one element that says there are three views. Measure the
      // distance between the two rects instead.
      const delta = tabs.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta), behavior: 'instant' });
      return true;
    });

    // ── Insights ──────────────────────────────────────────────────────────
    // Insights hides the whole mail workspace while it is open, so it runs
    // after every list shot and closes itself before Settings.
    await step('insights-map', async () => {
      if (!(await clickTestId('mail-view-list'))) throw new Error('list view control not found');
      await browser.pause(600);
      if (!(await clickTestId('open-insights'))) throw new Error('Insights sidebar entry not found');
      // The snapshot reads every cached header, so `ready` can be several
      // seconds out; the panel is `inert` until then and photographs blank.
      await expectState((s) => s.insightsPage === 'ready', 'Insights snapshot never became ready', 60000);
      await expectState((s) => !s.text.includes(L('insights.noMail')), 'Insights found no mail to draw');
      await frameInsights();
    }, 1800);

    await step('insights-timeline', async () => {
      if (!(await clickTestId('insights-tab-timeline'))) throw new Error('timeline tab not found');
      await expectState((s) => s.insightsTab === 'insights-tab-timeline' && s.insightsPage === 'ready',
        'timeline panel did not open');
      await frameInsights();
    }, 1800);

    await step('insights-activity', async () => {
      if (!(await clickTestId('insights-tab-activity'))) throw new Error('activity tab not found');
      await expectState((s) => s.insightsTab === 'insights-tab-activity' && s.insightsPage === 'ready',
        'activity panel did not open');
      await frameInsights();
    }, 1800);

    // Leave Insights, or every shot below it photographs the workspace.
    await browser.execute(() => document.querySelector('[data-testid="insights-close"]')?.click());
    await browser.pause(1200);

    // Back to a real account before Settings. `unified-inbox` leaves the run in
    // All Inboxes, where `activeAccountId` resolves to no account — and Time
    // Capsule disables Take Snapshot on exactly that (`accountEmail` is
    // `accounts.find(a => a.id === resolvedAccountId)?.email`). `clickByText`
    // does not check `disabled`, so the click reported success and the shot
    // then waited 20s for a snapshot row that was never going to appear.
    await openWorkInbox();

    // ── Settings ──────────────────────────────────────────────────────────
    await step('settings-appearance', async () => {
      await openAppearance('colors');
      await expectState((s) => s.settingsPage === 'appearance' && s.text.includes(L('settings.colors.palette')),
        'appearance colors section not on screen');
    });

    // The layout section is what the website's "can I change the layout"
    // answers point at: reading pane, sidebar, message rows in one frame.
    await step('settings-layout', async () => {
      await openAppearance('layout');
      await expectState((s) => s.settingsPage === 'appearance' && s.text.includes(L('workspace.readingPane')),
        'appearance layout section not on screen');
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

    await step('premium-backup-hours', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.backup'));
      await browser.pause(400);
      if (!(await clickByText(L('settings.backup.backupSchedule')))) throw new Error('backup schedule sub-tab not found');
      await browser.pause(400);
      // "At set hours" is the only frequency that reveals the 24-hour grid, and
      // WebDriver's own select handling never reaches React's onChange inside
      // WKWebView — the first run of this step skipped in every locale with the
      // grid never rendered. Write the config on the store the VITE_E2E build
      // publishes instead; the grid appearing below IS the proof it took.
      // A morning/midday/night trio photographs as a schedule somebody chose
      // rather than as the 03:00 the picker seeds itself with.
      await browser.execute(() => {
        window.__SETTINGS_STORE__.getState().setBackupGlobalConfig({ interval: 'hours', hours: [7, 12, 22] });
      });
      await $('[data-testid="backup-hours-picker"] [data-hour="22"]').waitForExist({ timeout: 10000 });
      await browser.pause(400);
      // The hint under the grid exists only while the grid does, so this fails
      // loudly if the select never took the change.
      await expectState(hasText(L('settings.backup.schedule.pickHours')),
        'hour picker not on screen');
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
      // The tree lost its testid to the i18n/a11y sweep, and so did the locked
      // overlay — but the overlay still blurs a LIVE copy of the card under
      // `aria-hidden="true"`, and pointer-events-none does not stop the
      // el.click() clickByText uses, so a locked run still mounts the tree in
      // there. The only table on this page is the folder tree; one that is NOT
      // inside the aria-hidden copy is both "the tree rendered" and "the seed
      // unlocked it".
      await browser.waitUntil(async () => browser.execute(() =>
        [...document.querySelectorAll('[data-testid="settings-content"][data-page="backup"] table')]
          .some((el) => !el.closest('[aria-hidden="true"]'))),
        { timeout: 15000, interval: 400,
          timeoutMsg: 'backup verification tree not on screen, or still behind the locked overlay' });
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
      if (!(await clickByText(L('settings.tab.cleanup')))) throw new Error('cleanup tab not found');
      // Two failures wear the same message otherwise: a nav click that missed,
      // and a panel that never finished. `data-page` separates them.
      await expectState((s) => s.settingsPage === 'cleanup', 'cleanup tab did not open');
      // The classifier auto-runs against the demo mailbox the moment this view
      // mounts unlocked. The summary grid lost its testid to the i18n sweep; a
      // row checkbox is the same branch and a stronger claim — it exists only
      // once premium AND real results have landed, never on the lock screen or
      // the "classifying" screen.
      await $('[data-testid="settings-content"][data-page="cleanup"] input[type="checkbox"]')
        .waitForExist({ timeout: 45000 });
    }, 1200);

    await step('premium-auto-cleanup', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.storage'));
      await browser.pause(600);
      // Two seeded rules (wdio.screenshots.conf.js) so this shows configured
      // rules rather than "no rules yet".
      // Rule rows lost their testid; the section keeps `settings-auto-cleanup`
      // and each rule still renders its enable switch, which the locked branch
      // does not.
      const row = await $('[data-testid="settings-auto-cleanup"] [role="switch"]');
      await row.waitForExist({ timeout: 8000 });
      await row.scrollIntoView({ block: 'center' });
    });

    await step('premium-time-capsule', async () => {
      await openSettings();
      await browser.pause(500);
      if (!(await clickByText(L('settings.tab.timeCapsule')))) throw new Error('time capsule tab not found');
      await expectState((s) => s.settingsPage === 'time-capsule', 'time capsule tab did not open');
      await browser.pause(400);
      // Snapshots live on disk, not in seeded settings — take a real one from
      // the already-synced demo mailbox so the list shows an actual entry
      // instead of "no snapshots yet".
      // `clickByText` treats a disabled button as a hit, which is how this
      // waited out its whole timeout instead of failing in one line.
      const snapshot = await browser.execute((label) => {
        for (const b of document.querySelectorAll('button')) {
          if (b.offsetHeight > 0 && (b.textContent || '').trim().startsWith(label)) {
            if (b.disabled) return 'disabled';
            b.click();
            return 'clicked';
          }
        }
        return 'missing';
      }, L('timeCapsule.takeSnapshot'));
      if (snapshot !== 'clicked') throw new Error(`take snapshot control ${snapshot}`);
      // Rows lost their testid and gained role="button" in the a11y sweep.
      // Everything else clickable on this page is a real <button>, so the div
      // is unambiguous — but a `waitForExist` that times out says only that,
      // while the panel may be showing "creating", an error and a Retry, or an
      // empty list. Assert through the probe so the failure carries the screen.
      await expectState((s) => s.snapshotRows > 0, 'snapshot list never showed a row', 60000);
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
      // The toggle's testId became a label in the a11y sweep; the switch is
      // still rendered only for premium, and the free branch shows a Lock chip
      // with no switch at all.
      await $('[data-testid="settings-tracker-blocking"] [role="switch"]').waitForExist({ timeout: 5000 });
      if (await $('[data-testid="tracker-upsell"]').isExisting()) {
        throw new Error('tracker panel is still showing the upsell — entitlement not applied');
      }
    });

    await step('premium-migration', async () => {
      await openSettings();
      await browser.pause(500);
      await clickByText(L('settings.tab.migration'));
      // A seeded in-flight job (wdio.screenshots.conf.js) so the shot shows
      // real progress and a folder checklist — "progress you can watch" —
      // instead of step 1 of an empty wizard.
      // `migration-progress` is gone, and the blurred-live-tree gate with it:
      // a locked run now renders only a static gate card with no accounts on
      // it. The progress view draws the seeded job's source and destination
      // addresses, so the seeded email IS the assertion — a value, not a
      // translated string, so it holds in every locale and proves the unlock at
      // the same time.
      const migrationSource = browser.demoAccounts[0].email;
      await expectState((s) => s.settingsPage === 'migration' && s.text.includes(migrationSource),
        'seeded migration progress not on screen (or the panel is still gated)');
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
      // Accounts grew sub-tabs and opens on Profile; Change Server lives in
      // Connection, so the old single click looked at a page that no longer
      // holds it.
      if (!(await clickByText(L('settings.accounts.sectionConnection')))) {
        throw new Error('accounts connection sub-tab not found');
      }
      await browser.pause(400);
      if (!(await clickByText(L('settings.accounts.changeServer')))) throw new Error('change server control not found');
      await expectState(hasText(L('changeServer.imapHost')), 'change server dialog not on screen');
    });

    await step('premium-export-image', async () => {
      await closeSettings();
      await browser.pause(500);
      await resetToInbox();
      // `unified-inbox` left the run in All Inboxes and nothing switched back;
      // this row lives in one mailbox, and the unified list is chunked and
      // virtualized, so a row finder scanning mounted nodes never sees it.
      await openWorkInbox();
      await expectState((s) => s.rows > 0 && !s.settings, 'not back on the work inbox');
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

    await step('premium-focus-session', async () => {
      await pressKey('Escape');            // the export dialog from the previous step
      await closeSettings();
      await browser.pause(400);
      await resetToInbox();
      if (!(await clickTestId('focus-button'))) throw new Error('focus button not found');
      await $('[data-testid="focus-dialog"]').waitForExist({ timeout: 5000 });
      // Open with the default (25) then pick 45, so the shot proves the selected chip is the one
      // just clicked - this is the repro for the "previous preset stays lit" report.
      if (!(await clickTestId('focus-preset-45'))) throw new Error('45 preset not found');
      await browser.pause(300);
      // Nothing closes the dialog here: `step` takes the shot AFTER this
      // returns, so an Escape would photograph the inbox. The next step opens
      // with closeSettings(), whose first act is an Escape, and that clears it.
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
      // Same reason as premium-export-image: without this the closing shot is
      // whatever unified view the run happened to end in.
      await openWorkInbox();
      await expectState((s) => s.rows > 0 && !s.settings, 'did not land back on the inbox');
    });
  });
});
