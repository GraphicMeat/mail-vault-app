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
 *   4. the Fields tab in Mail preferences answers a fields.list,
 *   5. a grouping chosen in the view builder is stored and read back.
 *
 * The builder lives on the Views page in Settings, not in the sidebar: the
 * sidebar opens views and nothing else.
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

  /// Open one view's builder on the Views page in Settings. Views are edited
  /// only there, never from the sidebar, so every edit below goes through
  /// Settings.
  async function openViewBuilder(viewId) {
    await openSettings();
    await browser.pause(400);
    await clickSettingsNav('Views');
    await browser.waitUntil(async () => browser.execute(id => !!document.querySelector(`[data-testid="views-row-${id}"]`), viewId),
      { timeout: 15000, timeoutMsg: `the Views page never listed ${viewId} — did views.list answer?` });
    await browser.execute(id => document.querySelector(`[data-testid="views-row-${id}"]`)?.click(), viewId);
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('[data-testid="view-editor-form"]')),
      { timeout: 10000, timeoutMsg: 'the view builder never opened' });
  }

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

  /// The builder writes through the daemon and the sidebar reads back from
  /// it, so a name that survives the round trip was really stored.
  it('renames a view from the Views page, and the sidebar shows it', async function () {
    const renamed = `Starred ${Date.now()}`;
    await openViewBuilder('builtin-starred');

    await browser.execute((name) => {
      const input = document.querySelector('[data-testid="view-name"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-testid="view-editor-form"]').requestSubmit();
    }, renamed);
    await closeSettings();

    const label = await browser.waitUntil(async () => {
      const text = await browser.execute(() => document.querySelector('[data-testid="view-row-builtin-starred"]')?.textContent?.trim() || '');
      return text.includes('Starred ') ? text : false;
    }, { timeout: 15000, timeoutMsg: 'the sidebar never showed the new name' });
    expect(label).toContain(renamed);

    // Put it back: the starter carries no name of its own.
    await openViewBuilder('builtin-starred');
    await browser.execute(() => {
      const input = document.querySelector('[data-testid="view-name"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-testid="view-editor-form"]').requestSubmit();
    });
    await closeSettings();
  });

  /// A sidebar view row only opens its view: there is no pencil at the end
  /// of it, and no other edit control anywhere in the Views section.
  it('offers no edit control on a sidebar view row', async function () {
    // An object, not the bare count: waitUntil would keep waiting on a 0.
    const found = await browser.waitUntil(async () => browser.execute(() => {
      if (!document.querySelector('[data-testid="view-row-builtin-starred"]')) return false;
      return { editControls: document.querySelectorAll('[data-testid^="view-edit-"], .sidebar-view-edit').length };
    }), { timeout: 15000, timeoutMsg: 'the Views section never showed the starred view' });
    expect(found.editControls).toBe(0);
  });

  /// The builder's grouping control is the one new affordance a headless run
  /// can reach: it needs no account and no schema. Saving it and reading it
  /// back off a reopened builder proves the daemon stored `def.group`.
  it('saves a grouping on a view, and reads it back from the daemon', async function () {
    await openViewBuilder('builtin-attachments');
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('[data-testid="view-group"]')),
      { timeout: 10000, timeoutMsg: 'the view builder never offered a grouping' });

    const options = await browser.execute(() => Array.from(document.querySelectorAll('[data-testid="view-group"] option'))
      .map(node => node.value));
    // The per-field options need a schema; these three never do.
    expect(options).toEqual(expect.arrayContaining(['', 'sender', 'date']));

    await browser.execute(() => {
      const select = document.querySelector('[data-testid="view-group"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'sender');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-testid="view-editor-form"]').requestSubmit();
    });
    await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[data-testid="view-group"]')),
      { timeout: 10000, timeoutMsg: 'the builder never closed after saving' });
    await closeSettings();

    // Reopening reads the stored view, not the form that was just closed.
    await openViewBuilder('builtin-attachments');
    const stored = await browser.waitUntil(async () => {
      const value = await browser.execute(() => document.querySelector('[data-testid="view-group"]')?.value ?? null);
      return value === null ? false : value;
    }, { timeout: 10000, timeoutMsg: 'the builder never reopened' });
    expect(stored).toBe('sender');

    // Put it back: a starter groups by nothing.
    await browser.execute(() => {
      const select = document.querySelector('[data-testid="view-group"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-testid="view-editor-form"]').requestSubmit();
    });
    await closeSettings();
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
