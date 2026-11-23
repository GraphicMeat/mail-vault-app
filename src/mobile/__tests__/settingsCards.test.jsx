// @vitest-environment jsdom
// Settings on the phone reads in cards: every setting, control and navigation row sits on a card
// (a surface distinct from the page), as Mail preferences > Behavior always did. The first screen
// is one card per navigation group, its heading and rows together; every page (each section, each
// tab) holds its settings in desktop's cards. Rendered over the fake engine (fixtures/mockEngine.js)
// with the real Settings shell; narrowSettings.test.js checks each card class is a surface on the
// phone. Tabs and the page header are navigation, not settings, and stay off the cards.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { installMockEngine } from './fixtures/mockEngine.js';
import { phonePages, openPage, settle } from './fixtures/settingsPages.js';

/**
 * What a card is on the phone (each a surface there: narrowSettings.test.js), and a card a view
 * draws with utilities (a surface, a border, the 12px radius: Data usage's accounts, Remove account).
 */
const CARDS = '.settings-section, .settings-editor-section, .settings-preference-group, .account-settings-list, .account-settings-identity, .bg-mail-surface.border.rounded-xl';

let t;
let Settings;
let useMobileStore;
let PREF_DEFAULTS;
let accounts;

beforeAll(async () => {
  installMockEngine();
  ({ t } = await import('../i18n.js'));
  ({ default: Settings } = await import('../Settings.jsx'));
  ({ useMobileStore } = await import('../store.js'));
  ({ PREF_DEFAULTS } = await import('../prefs.js'));
  accounts = (await window.__TAURI__.core.invoke('daemon_rpc', { method: 'mobile.accounts.list' })).accounts;
});

beforeEach(() => {
  useMobileStore.setState({
    prefs: { ...PREF_DEFAULTS, aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1', markAsReadMode: 'delay', badgeEnabled: true },
    accounts, activeAccountId: 'a1', activeFolder: 'INBOX', syncState: {}, reauthState: null,
    premium: { premium: true, source: 'apple', expiresMs: Date.now() + 86_400_000 },
  });
});
afterEach(cleanup);

const CONTROLS = 'button, input, select, textarea, [role="switch"], [role="radio"], [role="checkbox"], .setting-row, h3, h4';
/** A control or row on the page that is a setting: not a tab, not inside a sample picture. */
const settingsOf = (root) => [...root.querySelectorAll(CONTROLS)]
  .filter((el) => !el.closest('[role="tablist"], .setting-row-preview, figure, [aria-hidden="true"]'));
const describeEl = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 40)}"`;

describe('settings on cards', () => {
  it('the first screen: each navigation group is one card holding its heading and its rows', async () => {
    const { container } = render(<Settings onClose={() => {}} />);
    await settle();
    const nav = container.querySelector('.settings-navigation');
    const headings = [...nav.querySelectorAll('.settings-nav-heading')];
    expect(headings.length).toBeGreaterThan(2);
    for (const heading of headings) {
      const card = heading.closest('.settings-section');
      expect(card, heading.textContent).not.toBe(null);
      // The heading's card holds rows, and only one heading.
      expect(card.querySelectorAll('.settings-nav-item').length, heading.textContent).toBeGreaterThan(0);
      expect(card.querySelectorAll('.settings-nav-heading')).toHaveLength(1);
    }
    const loose = [...nav.querySelectorAll('.settings-nav-item')].filter((item) => !item.closest('.settings-section'));
    expect(loose.map(describeEl)).toEqual([]);
  });

  it('the first screen: search results sit on a card too', async () => {
    const { container } = render(<Settings onClose={() => {}} />);
    await settle();
    await act(async () => { fireEvent.change(container.querySelector('.settings-search input'), { target: { value: t('settings.appearance.theme') } }); });
    const results = [...container.querySelectorAll('.settings-search-result')];
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((item) => !item.closest('.settings-section')).map(describeEl)).toEqual([]);
  });

  for (const page of phonePages()) {
    it(`${page.name}: every setting and section heading sits on a card`, async () => {
      const { container } = await openPage(render, Settings, t, page);
      const body = container.querySelector('.mv-settings__body');
      if (page.notice) {
        // "<Feature> is in MailVault on desktop": the notice is one card.
        expect(body.querySelector('.settings-section')?.textContent).toBe(body.textContent);
        return;
      }
      const found = settingsOf(body);
      expect(found.length, 'the page shows settings').toBeGreaterThan(0);
      expect(found.filter((el) => !el.closest(CARDS)).map(describeEl)).toEqual([]);
    });
  }
});
