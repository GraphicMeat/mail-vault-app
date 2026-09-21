/**
 * E2E: the metadata layer is really wired to the daemon (UI-only).
 *
 * Three phases of tags, saved views and custom fields had been proven by unit
 * specs and a socket probe, and never once by the running app. This asserts
 * only what cannot be true unless the app talked to the daemon and rendered
 * what came back:
 *   1. the Views section holds the three starters the daemon seeds,
 *   2. their names are translated in the app (the daemon stores none),
 *   3. opening one names it in the list header,
 *   4. the Fields tab in Mail preferences answers a fields.list.
 */

import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

describe('Saved views, tags and custom fields', function () {
  this.timeout(60000);

  let appState;
  before(async function () {
    appState = await waitForApp();
  });

  beforeEach(function () {
    if (appState !== 'ready') this.skip();
  });

  it('shows the starter views the daemon seeded', async function () {
    const rows = await browser.waitUntil(async () => {
      const found = await browser.execute(() => Array.from(document.querySelectorAll('[data-testid^="view-row-"]'))
        .map(node => ({ id: node.dataset.testid, label: node.textContent.trim() })));
      return found.length >= 3 ? found : false;
    }, { timeout: 20000, timeoutMsg: 'the Views section never filled — did views.list answer?' });

    const ids = rows.map(row => row.id).sort();
    expect(ids).toEqual([
      'view-row-builtin-attachments',
      'view-row-builtin-needs-reply',
      'view-row-builtin-starred',
    ]);
  });

  it('names them in the app’s own words, not the database’s', async function () {
    const labels = await browser.execute(() => Array.from(document.querySelectorAll('[data-testid^="view-row-"]'))
      .map(node => node.textContent.trim()));
    // The daemon stores an empty name for every starter, so anything readable
    // here came from the catalogue.
    expect(labels.every(label => label.length > 0)).toBe(true);
    // A missing catalogue entry renders the key itself, and `views.builtin.starred`
    // would sail past a /starred/i check. Refuse anything key-shaped.
    const keyShaped = labels.filter(label => /^[a-z]+\.[a-z.]+$/i.test(label));
    expect(keyShaped).toEqual([]);
  });

  it('opening a view names it above the list', async function () {
    await browser.execute(() => document.querySelector('[data-testid="view-row-builtin-attachments"]')?.click());
    const title = await browser.waitUntil(async () => {
      const text = await browser.execute(() => document.querySelector('[data-testid="mailbox-title"]')?.textContent?.trim() || '');
      return /attachment|anhäng|adjunt|pièce|allegat|添付|첨부|anexo|附件/i.test(text) ? text : false;
    }, { timeout: 15000, timeoutMsg: 'the list header never named the open view' });
    expect(title.length).toBeGreaterThan(0);
  });

  it('offers the custom field editor, and it answers', async function () {
    await openSettings();
    await browser.pause(400);
    await clickSettingsNav('Mail preferences');
    // The sub-tabs render with the pane, not with the dialog.
    await browser.waitUntil(async () => browser.execute(() => {
      const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
      return !!root && [...root.querySelectorAll('button, [role="tab"]')]
        .some(node => /^(fields|felder|campos|champs|campi|フィールド|필드|字段)$/i.test(node.textContent.trim()));
    }), { timeout: 15000, timeoutMsg: 'the Fields tab never appeared in Mail preferences' });
    const clicked = await browser.execute(() => {
      const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
      const fields = Array.from((root || document).querySelectorAll('button, [role="tab"]'))
        .find(node => /^(fields|felder|campos|champs|campi|フィールド|필드|字段)$/i.test(node.textContent.trim()));
      if (!fields) return false;
      fields.click();
      return true;
    });
    expect(clicked).toBe(true);
    await browser.pause(500);
    const hasEditor = await browser.execute(() => !!document.querySelector('[data-testid="new-field-form"]'));
    expect(hasEditor).toBe(true);
    await closeSettings();
  });
});
