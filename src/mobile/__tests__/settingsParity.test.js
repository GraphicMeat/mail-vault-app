// @vitest-environment node
// Settings parity between desktop and the phone, over the shared manifest
// (src/components/settings/settingsManifest.js): every desktop page and every desktop setting has a
// phone decision, and every setting the manifest puts on the phone has its label in a module the
// phone build reaches from src/mobile/main.jsx. A new desktop page or setting with no decision, or
// a phone claim the phone does not render, turns this red. Static: a label named in a branch the
// phone never takes still counts, so the phone's page tests prove the controls themselves.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { analyzeSeam } from '../seam.js';
import { parityGaps, renderingSource, names } from '../parity.js';
import {
  allTabs, settingSearchGroups, MOBILE_PAGES, MOBILE_SETTINGS, MOBILE_LABELS, DESKTOP_NOTICE,
} from '../../components/settings/settingsManifest';

const ENTRY = fileURLToPath(new URL('../main.jsx', import.meta.url));
let source;
const phoneSource = async () => {
  source ??= renderingSource((await analyzeSeam(ENTRY)).modules);
  return source;
};
const manifest = (extra = {}) => ({
  pageIds: allTabs.map((tab) => tab.id),
  groups: settingSearchGroups,
  pages: MOBILE_PAGES,
  settings: MOBILE_SETTINGS,
  labels: MOBILE_LABELS,
  notice: DESKTOP_NOTICE,
  ...extra,
});

describe('settings parity', () => {
  it('reads the phone build, not the manifest or the catalogs', async () => {
    const src = await phoneSource();
    expect(src.length).toBeGreaterThan(10000);
    // Only the manifest and the catalog name these desktop-only labels.
    expect(names(src, 'settings.backup.schedule.automaticBackup')).toBe(false);
    expect(names(src, 'settings.storage.formatLabel')).toBe(false);
    expect(names(src, 'settings.security.linkSafetyScanning')).toBe(true);
  });

  it('every desktop page and setting has a phone decision, and every phone setting is rendered', async () => {
    const gaps = parityGaps(manifest({ source: await phoneSource() }));
    expect(gaps.undecidedPages).toEqual([]);
    expect(gaps.undecided).toEqual([]);
    expect(gaps.notRendered).toEqual([]);
    expect(gaps.onPhoneUnderMissingPage).toEqual([]);
  });

  it('the guard detects a new page, a new setting and a claim the phone does not render', async () => {
    const groups = [...settingSearchGroups, { id: 'appearance', settings: [['fake.newSetting', 'new'], ['fake.claimed', 'claimed']] }];
    const gaps = parityGaps(manifest({
      source: await phoneSource(),
      pageIds: [...allTabs.map((tab) => tab.id), 'fake-page'],
      groups,
      settings: { ...MOBILE_SETTINGS, 'fake.claimed': true },
    }));
    expect(gaps.undecidedPages).toEqual(['fake-page']);
    expect(gaps.undecided).toEqual(['fake.newSetting']);
    expect(gaps.notRendered.filter((key) => key.startsWith('fake.'))).toEqual(['fake.claimed']);
  });

  it('a blank reason is no decision', () => {
    const gaps = parityGaps(manifest({ source: '', pages: { ...MOBILE_PAGES, help: ' ' }, settings: { ...MOBILE_SETTINGS, 'settings.logs.clearLog2': '' } }));
    expect(gaps.undecidedPages).toEqual(['help']);
    expect(gaps.undecided).toEqual(['settings.logs.clearLog2']);
  });

  it('lists the engine gaps still to build', () => {
    const { engineGaps } = parityGaps(manifest({ source: '' }));
    // Visible in every run: the phone features waiting for the engine.
    console.info(`[settings parity] engine gaps:\n${Object.entries(engineGaps).map(([reason, items]) => `  ${reason}: ${items.join(', ')}`).join('\n')}`);
    expect(Object.keys(engineGaps).every((reason) => reason.startsWith('engine:'))).toBe(true);
    expect(engineGaps['engine: saved views']).toContain('page views');
  });
});
