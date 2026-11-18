import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForApp } from './helpers.js';
import { dismissOnboardingNotice } from './insightsHelpers.js';

const wait = (predicate, message) => browser.waitUntil(predicate, { timeout: 60000, interval: 200, timeoutMsg: message });
const out = resolve(process.env.HARNESS_SHOTS_OUT || '.artifacts');

async function setMode(theme) {
  await browser.execute(value => {
    if (document.documentElement.getAttribute('data-theme') === value) return;
    [...document.querySelectorAll('button')].find(button =>
      /^switch to (light|dark) mode$/i.test((button.getAttribute('aria-label') || button.title || '').trim()))?.click();
  }, theme);
  await wait(() => browser.execute(value => document.documentElement.getAttribute('data-theme') === value, theme), `Theme ${theme} did not apply`);
}

describe('Group inbox capture', function () {
  this.timeout(240000);

  it('captures group list and folded sidebar', async () => {
    assert.equal(await waitForApp(), 'ready');
    await dismissOnboardingNotice();
    assert.ok(browser.mockAccounts.length >= 3, 'Three mock accounts required');
    const [personal, workOne, workTwo] = browser.mockAccounts;
    await browser.execute((a, b, c) => window.__SETTINGS_STORE__.setState({
      language: 'en', sidebarLayout: 'stacked', sidebarCollapsed: false,
      hiddenAccounts: {}, accountOrder: [a.id, b.id, c.id], collapsedAccountGroups: {},
      accountGroups: { [a.id]: 'Personal', [b.id]: 'Work', [c.id]: 'Work' },
      unreadPerAccount: { [b.id]: 3, [c.id]: 4 },
    }), personal, workOne, workTwo);
    await wait(() => browser.execute(() => !!document.querySelector('.sidebar-account-list [role="group"][aria-label="Work"]')),
      'Work group did not render');
    await browser.$('.sidebar-account-list [role="group"][aria-label="Work"] .sidebar-group-open').click();
    try {
      await wait(() => browser.execute((b, c) => {
      const state = window.__MAIL_STORE__.getState();
      const title = document.querySelector('[data-testid="mailbox-title"]');
      return state.unifiedGroup === 'Work' && state.emails.length >= 6
        && state.emails.every(row => [b, c].includes(row._accountId) && row._mailbox === 'INBOX')
        && new Set(state.emails.filter(row => row._accountId === b).map(row => row.subject)).size >= 3
        && new Set(state.emails.filter(row => row._accountId === c).map(row => row.subject)).size >= 3
        && title?.textContent.trim() === 'Work'
        && !!document.querySelector('[role="group"][aria-label="Work"] [aria-current="true"]')
        && !document.querySelector('[data-testid="all-inboxes-btn"][aria-current="true"]');
      }, workOne.id, workTwo.id), 'group-inbox-list did not reach its scoped list');
    } catch (error) {
      console.error('group-inbox-list state', JSON.stringify(await browser.execute((b, c) => {
        const state = window.__MAIL_STORE__.getState();
        return {
          group: state.unifiedGroup, activeMailbox: state.activeMailbox, loading: state.loading,
          rows: state.emails.length, accounts: [...new Set(state.emails.map(row => row._accountId))],
          mailboxes: [...new Set(state.emails.map(row => row._mailbox))],
          distinctSubjects: [b, c].map(id => new Set(state.emails.filter(row => row._accountId === id).map(row => row.subject)).size),
          title: document.querySelector('[data-testid="mailbox-title"]')?.textContent,
          groupSelected: !!document.querySelector('[role="group"][aria-label="Work"] [aria-current="true"]'),
          allSelected: !!document.querySelector('[data-testid="all-inboxes-btn"][aria-current="true"]'),
        };
      }, workOne.id, workTwo.id)));
      throw error;
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, 'group-inbox-list.reached'), '[role="group"][aria-label="Work"] [aria-current="true"]\n');
    await dismissOnboardingNotice();
    process.env.SHOTS_APP_BINARY = resolve('target/debug/mailvault');
    process.env.SHOTS_OUT = out;
    const { capture } = await import('../../scripts/screenshots/capture.js');
    for (const theme of ['light', 'dark']) {
      await setMode(theme);
      await browser.pause(300);
      capture(`group-inbox-list-${theme}`);
    }

    await browser.$('[data-testid="all-inboxes-btn"]').click();
    await wait(() => browser.execute(() => {
      const state = window.__MAIL_STORE__.getState();
      return state.unifiedGroup === null && state.activeMailbox === 'UNIFIED' && state.emails.length >= 6
        && document.querySelector('[data-testid="mailbox-title"]')?.textContent.trim() === 'All Inboxes';
    }), 'All Inboxes did not open');
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ collapsedAccountGroups: { Work: true } }));
    await wait(() => browser.execute(() => {
      const work = document.querySelector('.sidebar-account-list [role="group"][aria-label="Work"]');
      const personal = document.querySelector('.sidebar-account-list [role="group"][aria-label="Personal"]');
      return work?.querySelector('.sidebar-group-toggle')?.getAttribute('aria-expanded') === 'false'
        && !work.querySelector('.sidebar-account-open')
        && Number.parseInt(work.querySelector('.sidebar-unread-count')?.textContent || '0', 10) > 0
        && !!personal?.querySelector('.sidebar-account-open')
        && !!document.querySelector('[data-testid="all-inboxes-btn"][aria-current="true"]');
    }), 'group-folded did not reach its folded sidebar');
    writeFileSync(resolve(out, 'group-folded.reached'), '[role="group"][aria-label="Work"] .sidebar-group-toggle[aria-expanded="false"]\n');
    for (const theme of ['light', 'dark']) {
      await setMode(theme);
      await browser.pause(300);
      capture(`group-folded-${theme}`);
    }
  });
});
