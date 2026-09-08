/**
 * Settings is a retained working surface: minimizing must release the mail UI
 * without replacing the section, scrollers, or unfinished forms on restore.
 *
 * Runs in connected-ci against wdio.conf.js's seeded mock IMAP accounts and
 * isolated app HOME. No production account state is injected or mail sent.
 * UI actions use real controls. DOM snapshots retain references only to prove
 * that restore kept the same working surface instead of rebuilding a lookalike.
 */
import assert from 'node:assert/strict';
import { waitForApp, waitForEmails, openSettings } from './helpers.js';

const SETTINGS = '[data-testid="settings-page"]';
const CONTENT = '[data-testid="settings-content"]';
const BUBBLE = '[data-testid="settings-bubble"]';
const COMPOSE = '[data-testid="compose-modal"]';
const COMPOSE_BUBBLE = '[data-testid="compose-bubble"]';

const exists = selector => browser.execute(sel => !!document.querySelector(sel), selector);
const settingsOpen = () => browser.execute(sel => {
  const panel = document.querySelector(sel);
  return panel?.getAttribute('role') === 'dialog' && !panel.closest('[inert], [aria-hidden="true"]')
    && getComputedStyle(panel).visibility !== 'hidden';
}, SETTINGS);
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 15_000, interval: 100, timeoutMsg: message });

// tauri-wd cannot hydrate element references for WebdriverIO's display
// polyfill. Match the existing compose harness: resolve controls inside the
// webview, verify their live DOM state, and invoke their real UI handlers.
const visible = selector => browser.execute(sel => {
  const element = document.querySelector(sel);
  return !!element && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    && element.offsetHeight > 0 && element.offsetWidth > 0
    && getComputedStyle(element).visibility !== 'hidden';
}, selector);
const text = selector => browser.execute(sel => document.querySelector(sel)?.innerText || '', selector);
const value = selector => browser.execute(sel => document.querySelector(sel)?.value ?? null, selector);

async function click(selector) {
  await wait(() => visible(selector), `Control is not visible: ${selector}`);
  const clicked = await browser.execute(sel => {
    const element = document.querySelector(sel);
    if (!element || element.disabled || element.closest('[hidden], [inert], [aria-hidden="true"]')
      || !element.offsetHeight || getComputedStyle(element).visibility === 'hidden') return false;
    element.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    element.focus({ preventScroll: true });
    element.click();
    return true;
  }, selector);
  assert.equal(clicked, true, `Control could not be activated: ${selector}`);
}

/** Exact accessible name, scoped to the live Settings surface. */
async function clickNamed(label, selector = 'button') {
  const found = await browser.execute((rootSelector, wanted, candidates) => {
    const root = document.querySelector(rootSelector);
    if (!root || root.closest('[inert], [aria-hidden="true"]')) return false;
    const control = [...root.querySelectorAll(candidates)].find(el => {
      const name = el.getAttribute('aria-label') || el.textContent.trim();
      return name === wanted && !el.disabled && getComputedStyle(el).visibility !== 'hidden' && el.offsetHeight > 0;
    });
    if (!control) return false;
    control.focus();
    control.click();
    return true;
  }, SETTINGS, label, selector);
  assert.equal(found, true, `Settings control was not available: ${label}`);
}

async function navigate(page, tab) {
  await clickNamed(page, '.settings-nav-item');
  const pageId = { Appearance: 'appearance', Templates: 'templates' }[page];
  await wait(() => browser.execute((selector, expected) => document.querySelector(selector)?.dataset.page === expected, CONTENT, pageId), `Settings did not open ${page}`);
  if (tab) await clickNamed(tab, '[role="tab"]');
  await wait(() => browser.execute((contentSelector, name) => {
    const panel = document.querySelector(contentSelector);
    return panel && (!name || [...panel.querySelectorAll('[role="tab"]')].some(el =>
      el.textContent.trim() === name && el.getAttribute('aria-selected') === 'true'));
  }, CONTENT, tab || null), `Settings did not navigate to ${page}${tab ? ` / ${tab}` : ''}`);
}

async function minimize() {
  await click(`${SETTINGS} button[aria-label="Minimize Settings"]`);
  await wait(async () => (await exists(BUBBLE)) && !(await settingsOpen()), 'Settings did not minimize into its bubble');
  const hidden = await browser.execute(sel => {
    const panel = document.querySelector(sel);
    return { mounted: !!panel, inert: !!panel?.closest('[inert]'), visibility: panel && getComputedStyle(panel).visibility };
  }, SETTINGS);
  assert.deepEqual(hidden, { mounted: true, inert: true, visibility: 'hidden' });
}

async function restoreBubble() {
  await click(`${BUBBLE} button[aria-label="Restore Settings"]`);
  await wait(async () => (await settingsOpen()) && !(await exists(BUBBLE)), 'Settings bubble did not restore the working surface');
}

async function closeSettingsSession() {
  if (await exists(BUBBLE)) await click(`${BUBBLE} button[aria-label="Close Settings"]`);
  else if (await settingsOpen()) await click(`${SETTINGS} .settings-header button[aria-label="Close"]`);
  await wait(async () => !(await exists(SETTINGS)) && !(await exists(BUBBLE)), 'Closing Settings left its session mounted');
}

async function cleanupCompose() {
  // Only this spec's one draft can exist. Use its real discard controls.
  if (await exists(COMPOSE)) {
    await click(`${COMPOSE} button[title="Close"]`);
    await wait(async () => !(await exists(COMPOSE)) || await exists('[data-testid="compose-discard-dialog"]'), 'Compose neither closed nor asked to discard');
    if (await exists('[data-testid="compose-discard-dialog"]')) {
      const clicked = await browser.execute(() => {
        const dialog = document.querySelector('[data-testid="compose-discard-dialog"]');
        const discard = [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === 'Discard');
        discard?.click();
        return !!discard;
      });
      assert.equal(clicked, true, 'Draft discard action was missing');
    }
    await wait(async () => !(await exists(COMPOSE)), 'Discard did not close Compose');
  }
  if (await exists(COMPOSE_BUBBLE)) {
    // Compose's existing close button appears on hover; cleanup need not
    // depend on pointer position or the entrance animation of that bubble.
    await browser.execute(sel => document.querySelector(`${sel} button`)?.click(), COMPOSE_BUBBLE);
    await wait(async () => !(await exists(COMPOSE_BUBBLE)), 'Draft bubble did not close');
  }
}

async function typeField(selector, input) {
  await wait(() => visible(selector), `Field is not visible: ${selector}`);
  const edited = await browser.execute((sel, next) => {
    const field = document.querySelector(sel);
    if (!field || field.disabled || field.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    field.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    field.focus();
    const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, next);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, input);
  assert.equal(edited, true, `Field could not be edited: ${selector}`);
  await wait(async () => await value(selector) === input, `Text did not reach ${selector}`);
}

function scrollSnapshot() {
  return browser.execute(contentSelector => {
    const root = document.querySelector(contentSelector);
    const group = [...root.querySelectorAll('[role="group"]')].find(el => {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/);
      const label = el.getAttribute('aria-label') || ids.map(id => document.getElementById(id)?.textContent || '').join(' ');
      return label.trim() === 'Message rows';
    });
    if (!group) return { found: false };
    group.scrollIntoView({ block: 'center', behavior: 'auto' });
    const scrollers = [];
    for (let element = group.parentElement; element; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY)) {
        scrollers.push({ element, top: element.scrollTop });
      }
      if (element === root) break;
    }
    window.__settingsMinimizeSnapshot = { root, group, scrollers };
    return { found: true, scrollPositions: scrollers.map(item => item.top) };
  }, CONTENT);
}

function restoredScrollState() {
  return browser.execute(contentSelector => {
    const saved = window.__settingsMinimizeSnapshot;
    if (!saved) return null;
    const root = document.querySelector(contentSelector);
    return {
      sameContent: saved.root === root,
      sameControl: root?.contains(saved.group) || false,
      selectedTab: root?.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(),
      deltas: saved.scrollers.map(({ element, top }) => Math.abs(element.scrollTop - top)),
    };
  }, CONTENT);
}

describe('Connected Settings minimize lifecycle', function () {
  this.timeout(120_000);

  before(async function () {
    assert.equal(await waitForApp(), 'ready', 'Mock-account app did not reach the main mail view');
    await waitForEmails();
    await wait(() => exists('[data-testid="email-row"]'), 'No actual mock mail rows were rendered');
  });

  beforeEach(async function () {
    await click('[data-testid="open-settings"]');
    await wait(settingsOpen, 'Sidebar Settings action did not open Settings');
  });

  afterEach(async function () {
    // Close whichever overlay is actually on top before its underlying
    // bubble, so failure cleanup never clicks through a modal backdrop.
    if (await settingsOpen()) await closeSettingsSession();
    await cleanupCompose();
    await closeSettingsSession();
    await browser.execute(() => { delete window.__settingsMinimizeSnapshot; });
  });

  it('restores Appearance Layout at Message rows with the same controls and real scroll positions', async function () {
    await navigate('Appearance', 'Layout');
    const scrolled = await scrollSnapshot();
    assert.equal(scrolled.found, true, 'Message rows preference was absent from Layout');
    assert.ok(scrolled.scrollPositions.some(top => top > 50), 'The case never scrolled Settings, so it cannot prove scroll retention');
    await minimize();
    assert.match(await text(BUBBLE), /Appearance.*Layout/s);
    await restoreBubble();
    const restored = await restoredScrollState();
    assert.equal(restored.sameContent, true, 'Restore remounted the content scroller');
    assert.equal(restored.sameControl, true, 'Restore rebuilt the preference controls');
    assert.equal(restored.selectedTab, 'Layout');
    assert.ok(restored.deltas.every(delta => delta <= 1), `Restore moved a scroller: ${JSON.stringify(restored.deltas)}`);
  });

  it('resumes an unfinished template through the ordinary Settings opener, then closes to a fresh session', async function () {
    await navigate('Templates');
    await clickNamed('Add Template');
    const name = `${SETTINGS} input[aria-label="Template name"]`;
    const body = `${SETTINGS} textarea[aria-label="Template body"]`;
    await typeField(name, 'Minimized project update');
    await typeField(body, 'This unfinished template must survive minimizing.');
    await minimize();
    // Exercise the shared opener's visibility check: hidden Settings stays
    // mounted, and must not be mistaken for an already-open window.
    await openSettings();
    await wait(settingsOpen, 'Ordinary Settings opener did not restore the retained form');
    assert.equal(await value(name), 'Minimized project update');
    assert.equal(await value(body), 'This unfinished template must survive minimizing.');
    assert.equal(await exists(BUBBLE), false);
    await closeSettingsSession();
    await click('[data-testid="open-settings"]');
    await wait(settingsOpen, 'Settings did not open a fresh session after Close');
    assert.equal(await browser.execute(sel => document.querySelector(sel)?.dataset.page, CONTENT), 'appearance');
    await navigate('Templates');
    assert.equal(await exists(name), false, 'Closing Settings kept a discarded template form alive');
    await clickNamed('Add Template');
    assert.equal(await value(name), '');
    assert.equal(await value(body), '');
  });

  it('releases mail search and Escape while Settings stays minimized', async function () {
    await navigate('Appearance', 'Reading');
    await minimize();
    await click('[data-testid="email-row"]');
    // Character keys reach WKWebView through WebDriver. Escape uses the
    // existing harness's event approach because native Escape is not relayed.
    await browser.execute(() => document.activeElement?.blur());
    await browser.keys('/');
    await wait(() => browser.execute(() => document.activeElement?.matches('[data-testid="mail-search-input"]')), 'Hidden Settings blocked the mail search shortcut');
    await browser.execute(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(await exists(BUBBLE), true, 'Mail Escape closed minimized Settings');
    assert.equal(await settingsOpen(), false);
    await restoreBubble();
    assert.equal(await browser.execute(sel => document.querySelector(`${sel} [role="tab"][aria-selected="true"]`)?.textContent.trim(), CONTENT), 'Reading');
  });

  it('shares the corner stack with Compose and restores each working surface independently', async function () {
    await navigate('Appearance', 'Layout');
    await minimize();
    await browser.keys('c');
    await wait(() => exists(COMPOSE), 'Mail Compose shortcut did not work with minimized Settings');
    await typeField('[data-testid="compose-subject"]', 'Compose alongside Settings');
    await click(`${COMPOSE} button[title="Minimize"]`);
    await wait(async () => await exists(COMPOSE_BUBBLE) && !(await exists(COMPOSE)), 'Compose did not join the minimized stack');
    const stack = await browser.execute((settingsSelector, composeSelector) => {
      const settings = document.querySelector(settingsSelector);
      const compose = document.querySelector(composeSelector);
      const a = settings.getBoundingClientRect();
      const b = compose.getBoundingClientRect();
      return { sameStack: settings.parentElement === compose.parentElement, separated: a.bottom <= b.top || b.bottom <= a.top,
        onScreen: Math.min(a.top, b.top) >= 0 && Math.max(a.bottom, b.bottom) <= innerHeight };
    }, BUBBLE, COMPOSE_BUBBLE);
    assert.deepEqual(stack, { sameStack: true, separated: true, onScreen: true });
    await restoreBubble();
    assert.equal(await exists(COMPOSE_BUBBLE), true, 'Restoring Settings dismissed the compose draft');
    assert.equal(await browser.execute(sel => document.querySelector(`${sel} [role="tab"][aria-selected="true"]`)?.textContent.trim(), CONTENT), 'Layout');
    await minimize();
    await click(COMPOSE_BUBBLE);
    await wait(() => exists(COMPOSE), 'Compose bubble did not restore its draft');
    assert.equal(await value('[data-testid="compose-subject"]'), 'Compose alongside Settings');
    assert.equal(await exists(BUBBLE), true, 'Restoring Compose dismissed minimized Settings');
  });
});
