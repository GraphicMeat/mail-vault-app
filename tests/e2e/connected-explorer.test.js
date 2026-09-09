import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appDataDir } from './mockImap.js';
import { waitForApp, waitForEmails } from './helpers.js';

const wait = (predicate, message) => browser.waitUntil(predicate, { timeout: 20000, interval: 150, timeoutMsg: message });
function diskSettings() {
  try { return JSON.parse(readFileSync(join(appDataDir(browser.testDataDir), 'frontend-settings.json'), 'utf8'))['mailvault-settings']?.state; }
  catch { return null; }
}
async function click(selector) {
  assert.equal(await browser.execute(sel => {
    const node = document.querySelector(sel);
    if (!node || node.disabled || node.closest('[hidden], [inert]')) return false;
    node.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit !== node && !node.contains(hit)) return false;
    node.focus(); node.click(); return true;
  }, selector), true, `Control is reachable: ${selector}`);
}
async function choose(value) {
  assert.equal(await browser.execute(value => {
    const select = document.querySelector('[data-testid="explorer-grouping"]');
    if (!select) return false;
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  }, value), true);
  await wait(() => browser.execute(value => document.querySelector('[data-testid="explorer-view"]')?.dataset.grouping === value, value), `Grouping ${value}`);
}
const groups = () => browser.execute(() => [...document.querySelectorAll('[data-testid="explorer-group-row"]')].map(e => ({ label: e.dataset.label, text: e.textContent })));
async function openFirst() {
  await wait(async () => (await groups()).length > 0, 'Expected Explorer groups');
  await click('[data-testid="explorer-group-open"]');
}
async function enter() {
  await click('[data-testid="mail-view-explorer"]');
  await wait(() => browser.execute(() => !!document.querySelector('[data-testid="explorer-view"]')), 'Explorer appears');
}

describe('Explorer in the native mailbox', function () {
  this.timeout(90000);
  before(async () => { await waitForApp(); await waitForEmails(); });
  beforeEach(async () => {
    await browser.execute(async () => {
      const settings = window.__SETTINGS_STORE__.getState();
      settings.setEmailListView?.('list');
      settings.setExplorerGrouping?.('date');
      settings.setExplorerDateDepth?.('month');
      window.__SETTINGS_STORE__.setState({ explorerPaths: {} });
      settings.setEmailListGrouping('chronological');
      settings.setThreadMode('flat');
      settings.setLayoutMode('three-column');
      const mail = window.__MAIL_STORE__.getState();
      mail.clearSearch(); mail.clearSelection(); mail.closeEmail();
      if (mail.unreadOnly) mail.toggleUnreadOnly();
      if (mail.activeAccountId !== '11111111-1111-4111-8111-111111111111' || mail.activeMailbox !== 'INBOX') {
        await mail.activateAccount('11111111-1111-4111-8111-111111111111', 'INBOX');
      }
    });
    await waitForEmails();
  });
  after(async () => { await browser.execute(() => { const s=window.__SETTINGS_STORE__.getState(); s.setEmailListView?.('list'); s.setLayoutMode('three-column'); window.__MAIL_STORE__.getState().clearSelection(); }); });

  it('opens Explorer through its real control and preserves the normal list mode', async () => {
    await enter();
    assert.ok((await groups()).length > 0);
    assert.equal(await browser.execute(() => document.querySelector('[data-testid="thread-mode-toggle"]') !== null), false);
    await click('[data-testid="mail-view-list"]');
    assert.equal(await browser.execute(() => document.querySelector('[data-testid="thread-mode-toggle"]')?.value), 'flat');
    assert.ok(await browser.execute(() => document.querySelectorAll('[data-testid="email-row"]').length > 0));
  });

  it('browses date groups and opens a real message in the existing reader', async () => {
    await enter(); await openFirst(); await openFirst();
    await wait(() => browser.execute(() => !!document.querySelector('[data-testid="explorer-view"] [data-testid="email-row"]')), 'Month has message rows');
    const uid = await browser.execute(() => Number(document.querySelector('[data-testid="explorer-view"] [data-testid="email-row"]').dataset.uid));
    await click('[data-testid="explorer-view"] [data-testid="email-row"]');
    await wait(() => browser.execute(uid => window.__MAIL_STORE__.getState().selectedEmail?.uid === uid, uid), 'Reader loads selected message');
    assert.ok(await browser.execute(() => !!(document.querySelector('[data-testid="explorer-view"] [data-testid="email-row"] [data-testid="message-state-icon"]') || document.querySelector('[data-testid="explorer-view"] [data-testid="email-row"] svg'))));
    await click('[data-testid="explorer-back"]');
    assert.ok((await groups()).length > 0);
  });

  it('selects every email in a sender group through its checkbox', async () => {
    await enter(); await choose('sender');
    const target = await browser.execute(() => {
      const row = document.querySelector('[data-testid="explorer-group-row"]');
      const address = row.dataset.detail;
      const expected = window.__MAIL_STORE__.getState().sortedEmails.filter(e => e.from?.address?.trim().toLowerCase() === address).map(e => e.uid).sort((a,b)=>a-b);
      return { address, expected };
    });
    assert.ok(target.expected.length > 0);
    await click('[data-testid="explorer-group-row"] input[type="checkbox"]');
    assert.deepEqual(await browser.execute(() => [...window.__MAIL_STORE__.getState().selectedEmailIds].sort((a,b)=>a-b)), target.expected);
    await click('[data-testid="explorer-group-row"] input[type="checkbox"]');
    assert.equal(await browser.execute(() => window.__MAIL_STORE__.getState().selectedEmailIds.size), 0);
  });

  it('adds day groups only when requested', async () => {
    await enter();
    await browser.execute(() => {
      const select = document.querySelector('[aria-label="Date detail"]');
      select.value = 'day'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await openFirst(); await openFirst();
    assert.ok((await groups()).length > 0);
    await openFirst();
    assert.ok(await browser.execute(() => document.querySelectorAll('[data-testid="explorer-view"] [data-testid="email-row"]').length > 0));
  });

  it('browses conversations and opens the complete thread', async () => {
    await enter(); await choose('conversation'); await openFirst(); await openFirst(); await openFirst();
    await click('[data-testid="explorer-open-thread"]');
    await wait(() => browser.execute(() => !!window.__MAIL_STORE__.getState().selectedThread), 'Full conversation opens');
    assert.ok(await browser.execute(() => window.__MAIL_STORE__.getState().selectedThread.emails.length > 0));
  });

  it('filters the current group and keeps the path while filtering unread', async () => {
    await enter(); await openFirst(); await openFirst();
    const path = await browser.execute(() => document.querySelector('[aria-label="Explorer path"]').textContent);
    await click('[data-testid="unread-filter-toggle"]');
    assert.equal(await browser.execute(() => document.querySelector('[aria-label="Explorer path"]').textContent), path);
    await browser.execute(() => {
      const input = document.querySelector('[data-testid="explorer-search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'No such explorer subject 987654');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(() => browser.execute(() => document.querySelector('[data-testid="explorer-empty"]')?.textContent.includes('No matching emails')), 'Local search narrows current group');
    assert.equal(await browser.execute(() => document.querySelector('[aria-label="Explorer path"]').textContent), path);
  });

  it('restores the selected view, grouping and path after a webview reload', async () => {
    await enter(); await choose('sender'); await openFirst();
    const path = await browser.execute(() => document.querySelector('[aria-label="Explorer path"]').textContent);
    const paths = await browser.execute(() => window.__SETTINGS_STORE__.getState().explorerPaths);
    await wait(() => { const s = diskSettings(); return s?.emailListView === 'explorer' && s.explorerGrouping === 'sender' && JSON.stringify(s.explorerPaths) === JSON.stringify(paths); }, 'Explorer settings written to disk');
    await browser.refresh();
    await waitForApp();
    await wait(() => browser.execute(() => window.__SETTINGS_STORE__?.persist.hasHydrated()), 'Settings hydrated after reload');
    await wait(() => browser.execute(() => document.querySelector('[data-testid="explorer-view"]')?.dataset.grouping === 'sender'), 'Explorer preference restored');
    await wait(() => browser.execute(path => document.querySelector('[aria-label="Explorer path"]')?.textContent === path, path), 'Explorer path restored after headers load');
  });

  it('keeps controls and rows inside narrow and stacked list panes', async () => {
    await enter();
    for (const layout of ['three-column', 'two-column']) {
      await browser.execute(layout => { const s=window.__SETTINGS_STORE__.getState(); s.setLayoutMode(layout); s.setListPaneSize(320); s.setListPaneHeight(320); }, layout);
      await browser.pause(250);
      const geometry = await browser.execute(() => {
        const root = document.querySelector('[data-testid="explorer-view"]');
        const r = root.getBoundingClientRect();
        return { display: getComputedStyle(root).display, rowViewport: root.querySelector('.explorer-scroll').clientHeight, width: r.width, overflow: root.scrollWidth > root.clientWidth + 1, escaped: [...root.querySelectorAll('select,input,button')].filter(e => e.offsetWidth && e.getBoundingClientRect().right > r.right + 1).map(e=>e.getAttribute('aria-label') || e.textContent) };
      });
      assert.equal(geometry.display, 'flex', 'Explorer stylesheet loaded');
      assert.ok(geometry.rowViewport >= 56, `Rows have usable height: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.width > 0); assert.equal(geometry.overflow, false); assert.deepEqual(geometry.escaped, []);
      await openFirst(); await openFirst();
      await click('[data-testid="explorer-view"] [data-testid="email-row"]');
      await click('[data-testid="explorer-back"]'); await click('[data-testid="explorer-back"]');
    }
    if (process.env.E2E_EXPLORER_SCREENSHOTS) {
      await browser.execute(() => { const s=window.__SETTINGS_STORE__.getState(); s.setLayoutMode('three-column'); s.setListPaneSize(440); });
      await choose('sender');
      process.env.SHOTS_APP_BINARY = process.env.TAURI_APP_BINARY || resolve('target/debug/mailvault');
      process.env.SHOTS_OUT = '/tmp/mv-explorer-shots';
      const { capture } = await import('../../scripts/screenshots/capture.js');
      capture('explorer-sender');
    }
  });

  it('labels partial groups and loads the next page explicitly', async () => {
    await enter();
    await browser.execute(async () => { await window.__MAIL_STORE__.getState().activateAccount('22222222-2222-4222-8222-222222222222', 'INBOX'); });
    await wait(() => browser.execute(() => { const s=window.__MAIL_STORE__.getState(); return !s.loading && s.sortedEmails.length > 0 && s.totalEmails === 700; }), 'Large mailbox loaded its first window');
    const before = await browser.execute(() => window.__MAIL_STORE__.getState().sortedEmails.length);
    assert.ok(before < 700, `Fixture must be partial, got ${before}`);
    assert.ok(await browser.execute(() => document.querySelector('[data-testid="explorer-partial"]')?.textContent.includes('loaded emails')));
    await browser.execute(() => [...document.querySelectorAll('[data-testid="explorer-view"] button')].find(e=>e.textContent.trim()==='Load more emails').click());
    await wait(() => browser.execute(before => window.__MAIL_STORE__.getState().sortedEmails.length > before, before), 'Explicit loading grows groups');
    await browser.execute(() => {
      const settings = window.__SETTINGS_STORE__.getState();
      settings.setLayoutMode('two-column'); settings.setListPaneHeight(320);
      const input = document.querySelector('[data-testid="explorer-search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Vader message');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(() => browser.execute(() => !!document.querySelector('[data-testid="explorer-view"] [data-testid="email-row"]')), 'Virtualized message results appear');
    await browser.execute(() => {
      document.querySelector('[data-testid="mail-view-explorer"]').focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    });
    let keyboardState;
    await wait(async () => {
      keyboardState = await browser.execute(() => {
        const focus = document.activeElement;
        const rect = focus.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const root = document.querySelector('[data-testid="explorer-view"]');
        const scroller = root.querySelector('.explorer-scroll');
        const mail = window.__MAIL_STORE__.getState();
        const readerLoaded = !!mail.selectedEmail && !mail.loadingEmail;
        return { reachable: readerLoaded && focus.hasAttribute('data-explorer-index') && !!hit && focus.contains(hit) && !!mail.selectedEmailId,
          focus: focus.tagName, index: focus.dataset.explorerIndex, key: focus.dataset.explorerKey,
          selected: mail.selectedEmailId, readerLoaded, hit: hit?.className,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          root: { height: root.clientHeight, top: root.getBoundingClientRect().top, scroll: root.scrollTop },
          inner: { height: scroller.clientHeight, top: scroller.getBoundingClientRect().top, scroll: scroller.scrollTop } };
      });
      return keyboardState.reachable;
    }, 'Keyboard navigation reveals the active virtual row below short-pane controls')
      .catch(error => { throw new Error(`${error.message}: ${JSON.stringify(keyboardState)}`); });
  });

  it('keeps cross-account selection and message opening distinct in All Inboxes', async () => {
    await enter();
    // Seed the third fixture's headers too, so the selection snapshot does not
    // depend on whether its background sync arrived before this test began.
    await browser.execute(async () => {
      const mail = window.__MAIL_STORE__.getState();
      await mail.activateAccount('33333333-3333-4333-8333-333333333333', 'INBOX');
      await mail.setUnifiedInbox(true);
    });
    await wait(() => browser.execute(() => { const s=window.__MAIL_STORE__.getState(); return s.activeMailbox === 'UNIFIED' && new Set(s.sortedEmails.map(e=>e._accountId)).size === 3; }), 'All fixture accounts are present');
    const expected = await browser.execute(() => window.__MAIL_STORE__.getState().sortedEmails.map(e=>`${e._accountId}:${e._mailbox}:${e.uid}`).sort());
    await click('[data-testid="explorer-view"] .explorer-summary input[type="checkbox"]');
    assert.deepEqual(await browser.execute(() => [...window.__MAIL_STORE__.getState().selectedEmailIds].sort()), expected);
    await browser.execute(() => {
      window.__MAIL_STORE__.getState().clearSelection();
      const input=document.querySelector('[data-testid="explorer-search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Vader message');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await wait(() => browser.execute(() => !!document.querySelector('[data-testid="explorer-view"] [data-testid="email-row"]')), 'Search shows account two mail');
    await click('[data-testid="explorer-view"] [data-testid="email-row"]');
    await wait(() => browser.execute(() => window.__MAIL_STORE__.getState().selectedEmail?._accountId === '22222222-2222-4222-8222-222222222222'), 'Reader opens the correct account');
  });
});
