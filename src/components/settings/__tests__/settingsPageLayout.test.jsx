// @vitest-environment jsdom
//
// Every settings tab must land inside the shared page shell: SettingsPageLayout's
// `.settings-form` (index.css:1272, quick-actions.css:330 both key off it), or a
// SettingsTabs-driven `.settings-tabbed-page` (its tabpanel is itself a
// SettingsPageLayout). PortableSettings shipped without either for years because
// nothing enforced it — this is that enforcement, looping over `allTabs` so a new
// tab is covered the moment it's added, with no per-tab list to remember to update.
//
// A tab whose page needs heavier mocking than this file sets up (network/daemon
// calls during mount) falls back to a source scan of the file SettingsPage.jsx
// renders for it, checking that file reaches for SettingsPageLayout/SettingsTabs.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { allTabs, SettingsPage } from '../../SettingsPage';
import { useMailStore } from '../../../stores/mailStore';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [], activeAccountId: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Full-bleed by design, not by drift — each keeps its own `.settings-form`
// page behind a "Settings" sub-view rather than wrapping its main view:
// - accounts: its own two-column `.account-settings-layout` (list + editor).
// - cleanup / time-capsule: the account-pilled review list, a full-height
//   view with its own scrolling; their "Settings" sub-view renders
//   AISettings / TimeCapsuleSettings, which are already `.settings-form`.
const FULL_BLEED = new Set(['accounts', 'cleanup', 'time-capsule']);

const SETTINGS_PAGE_SRC = readFileSync(resolve(process.cwd(), 'src/components/SettingsPage.jsx'), 'utf8');
const SETTINGS_DIR = resolve(process.cwd(), 'src/components');

// Component name -> the file SettingsPage.jsx imports it from.
const importedFrom = new Map();
for (const m of SETTINGS_PAGE_SRC.matchAll(/^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+'([^']+)';/gm)) {
  const names = m[1] ? m[1].split(',').map(s => s.trim()) : [m[2]];
  for (const name of names) importedFrom.set(name, m[3]);
}

// The component SettingsPage.jsx renders for a tab really does use the
// shared layout — read straight from source, for a tab that won't mount here.
function tabSourceUsesSharedLayout(tabId) {
  const branch = SETTINGS_PAGE_SRC.match(new RegExp(`activeTab === '${tabId}' && \\([\\s\\S]{0,200}?<(\\w+)`));
  const importPath = branch && importedFrom.get(branch[1]);
  if (!importPath) return false;
  const relative = importPath.replace(/^\.\//, '');
  const file = resolve(SETTINGS_DIR, relative.endsWith('.jsx') ? relative : `${relative}.jsx`);
  return /SettingsPageLayout|SettingsTabs/.test(readFileSync(file, 'utf8'));
}

describe('every settings tab keeps the shared page shell', () => {
  it.each(allTabs.filter(tab => !FULL_BLEED.has(tab.id)))('$id', ({ id }) => {
    let content;
    try {
      render(<SettingsPage initialTab={id} onClose={() => {}} />);
      content = screen.getByTestId('settings-content');
    } catch {
      // Couldn't mount cheaply here (e.g. a network call during render) —
      // fall back to proving the page reaches for the shared layout at all.
      expect(tabSourceUsesSharedLayout(id)).toBe(true);
      return;
    }
    expect(content.firstElementChild?.matches('.settings-form, .settings-tabbed-page')).toBe(true);
  });
});
