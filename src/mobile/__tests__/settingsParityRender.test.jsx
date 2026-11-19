// @vitest-environment jsdom
// Settings parity, rendered: each phone settings page is mounted (src/mobile/Settings.jsx over a
// fake engine, fixtures/mockEngine.js) and every setting the shared manifest
// (settingsManifest.js) lists on that page is looked for in the page itself, by its label as the
// phone shows it (MOBILE_LABELS), the way a search result lands on it (`findSettingRow`). A
// setting marked on the phone must be there; one marked not on the phone must not be. The static
// check (settingsParity.test.js) only proves a phone module names the label; a shared view names
// every desktop label, so only a render tells the two apart.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { installMockEngine } from './fixtures/mockEngine.js';
import {
  settingSearchGroups, MOBILE_PAGES, MOBILE_SETTINGS, MOBILE_LABELS, findSettingRow, settingText,
} from '../../components/settings/settingsManifest';

let mock;
let t;
let Settings;
let useMobileStore;
let PREF_DEFAULTS;
let accounts;

beforeAll(async () => {
  mock = installMockEngine();
  ({ t } = await import('../i18n.js'));
  ({ default: Settings } = await import('../Settings.jsx'));
  ({ useMobileStore } = await import('../store.js'));
  ({ PREF_DEFAULTS } = await import('../prefs.js'));
  accounts = (await window.__TAURI__.core.invoke('daemon_rpc', { method: 'mobile.accounts.list' })).accounts;
});

beforeEach(() => {
  useMobileStore.setState({
    // Every setting that waits on another one is open: a mark-as-read delay, the badge, AI.
    prefs: { ...PREF_DEFAULTS, aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1', markAsReadMode: 'delay', badgeEnabled: true },
    accounts, activeAccountId: 'a1', activeFolder: 'INBOX', syncState: {}, reauthState: null,
    premium: { premium: true, source: 'apple', expiresMs: Date.now() + 86_400_000 },
  });
});
afterEach(cleanup);

const settle = () => act(async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); });
const label = (key) => settingText(t(MOBILE_LABELS[key] || key));

/** Presses the first control on the page whose name (its text, label or title) is `name`. */
const press = (name) => async (root) => {
  const hit = [...root.querySelectorAll('button, [role="button"]')].find((el) => [el.textContent, el.getAttribute('aria-label'), el.title].some((v) => v && settingText(v) === settingText(name)));
  if (!hit) throw new Error(`no control named ${name}`);
  await act(async () => { fireEvent.click(hit); });
};

/**
 * A setting that shows only once something on its page is opened: what to open first (the
 * account's folder settings, the template form, the rule editor, a view's editor).
 */
const REVEAL = {
  'notifyPolicy.quietHours.title': [(root) => press(t('settings.notifications.configureFolders'))(root)],
  'settings.templates.templateName': [(root) => press(t('settings.templates.addTemplate'))(root)],
  'autoTag.name': [(root) => press(t('autoTag.newRule'))(root)],
  // Not on the phone, but only its editor could show it: opened to prove it does not.
  'views.showTimeline': [async (root) => { await act(async () => { fireEvent.click(root.querySelector('[data-testid="views-row-v1"]')); }); }],
};

/**
 * Where a label stands as a setting: its row, as search lands on it, or (`tabs`) a tab of its own
 * (Quick actions' Email reader; only when looking for a setting that should be there, since a
 * page's section tabs share words with settings elsewhere: "Layout"). A label inside a sample
 * preview (the layout preview's "Reading pane") is a picture of the app, not a setting.
 */
function findSetting(root, text, { tabs = false } = {}) {
  const page = root.cloneNode(true);
  page.querySelectorAll('.setting-row-preview').forEach((el) => el.remove());
  return findSettingRow(page, text) || (tabs && [...page.querySelectorAll('[role="tab"]')].find((el) => settingText(el.textContent) === text)) || null;
}

/** The pages the phone has, each with the settings the manifest lists on it. */
const pages = settingSearchGroups
  .filter((group) => MOBILE_PAGES[group.id] === true)
  .map((group) => ({ ...group, name: `${group.id}${group.section ? ` > ${group.section}` : ''}` }));

async function open(group) {
  const view = render(<Settings onClose={() => {}} page={group.id} />);
  await settle();
  if (group.sectionKey) {
    const tab = [...view.container.querySelectorAll('[role="tab"]')].find((el) => settingText(el.textContent) === settingText(t(group.sectionKey)));
    if (tab && tab.getAttribute('aria-selected') !== 'true') {
      fireEvent.click(tab);
      await settle();
    }
  }
  return view.container;
}

describe('settings parity, rendered', () => {
  it('there are phone pages to check', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  for (const group of pages) {
    it(`${group.name}: renders the settings on the phone and none of the others`, async () => {
      const root = await open(group);
      for (const step of group.settings.flatMap(([key]) => REVEAL[key] || [])) {
        await step(root);
        await settle();
      }
      const missing = [];
      const leaking = [];
      for (const [key] of group.settings) {
        const decision = MOBILE_SETTINGS[key];
        const found = Boolean(findSetting(root, label(key), { tabs: decision === true }));
        if (decision === true && !found) missing.push(key);
        if (decision !== true && found) leaking.push(key);
      }
      expect({ missing, leaking }).toEqual({ missing: [], leaking: [] });
    });
  }

  it('the fake engine answered every call the pages made', () => {
    expect([...mock.unhandled]).toEqual([]);
  });
});
