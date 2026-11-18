// @vitest-environment node
// Every desktop settings page and every searchable setting carries a phone decision: on the
// phone, or the reason it is not. A new page or setting without one turns this red.
import { describe, it, expect } from 'vitest';
import {
  allTabs, settingSearchGroups, settingsSections, footerIds, settingsHosts,
  MOBILE_PAGES, MOBILE_SETTINGS, MOBILE_SETTINGS_DUPLICATES, MOBILE_LABELS, mobileSearchPages, onPhone,
  onPhoneNotice, navEntryOnPhone, DESKTOP_NOTICE,
} from '../settingsManifest';

const decided = (value) => value === true || (typeof value === 'string' && value.trim().length > 0);

describe('settings manifest', () => {
  it('every page has a phone decision', () => {
    // Portable is left out of the App Store build, so the map may name it while allTabs does not.
    expect(allTabs.filter((tab) => !decided(MOBILE_PAGES[tab.id])).map((tab) => tab.id)).toEqual([]);
  });

  it('every searchable setting has a phone decision, exactly once', () => {
    const keys = settingSearchGroups.flatMap((group) => group.settings.map(([key]) => key));
    expect(keys.filter((key) => !decided(MOBILE_SETTINGS[key]))).toEqual([]);
    expect(MOBILE_SETTINGS_DUPLICATES).toEqual([]);
    // No decision for a key search does not have: a rename leaves no stale entry behind.
    const known = new Set(keys);
    expect(Object.keys(MOBILE_SETTINGS).filter((key) => !known.has(key) && !key.startsWith('portable.') && key !== 'settings.transfer.confirmPassword')).toEqual([]);
  });

  it('a setting on a page the phone lacks is not on the phone either', () => {
    const wrong = settingSearchGroups.filter((group) => !onPhone(MOBILE_PAGES[group.id]))
      .flatMap((group) => group.settings.map(([key]) => key)).filter((key) => onPhone(MOBILE_SETTINGS[key]));
    expect(wrong).toEqual([]);
  });

  it('every nav id is a page or a host', () => {
    const ids = [...settingsSections.flatMap((s) => s.ids), ...footerIds];
    const pages = new Set(allTabs.map((tab) => tab.id));
    // Portable is absent from the App Store build only.
    expect(ids.filter((id) => !pages.has(id) && !settingsHosts[id] && id !== 'portable')).toEqual([]);
  });

  it('phone search offers only what the phone has, and the desktop-notice pages by name', () => {
    expect(mobileSearchPages.length).toBeGreaterThan(10);
    expect(mobileSearchPages.filter((p) => !onPhone(MOBILE_PAGES[p.id]) && (p.keywords || !onPhoneNotice(MOBILE_PAGES[p.id])))).toEqual([]);
    expect(mobileSearchPages.filter((p) => p.keywords && !onPhone(MOBILE_SETTINGS[p.settingKey || p.labelKey]))).toEqual([]);
    expect(mobileSearchPages.filter((p) => onPhoneNotice(MOBILE_PAGES[p.id])).map((p) => p.id).sort())
      .toEqual(['backup', 'cleanup', 'migration', 'time-capsule']);
  });

  it('a desktop-notice page is in the phone navigation, not a phone feature, and its settings are desktop features', () => {
    const notice = Object.keys(MOBILE_PAGES).filter((id) => MOBILE_PAGES[id] === DESKTOP_NOTICE).sort();
    expect(notice).toEqual(['backup', 'cleanup', 'migration', 'time-capsule']);
    for (const id of notice) {
      expect(onPhone(MOBILE_PAGES[id]), id).toBe(false);
      expect(navEntryOnPhone({ id }), id).toBe(true);
    }
    const settings = settingSearchGroups.filter((g) => notice.includes(g.id)).flatMap((g) => g.settings.map(([key]) => key));
    expect(settings.length).toBeGreaterThan(5);
    expect(settings.filter((key) => MOBILE_SETTINGS[key] !== 'desktop feature')).toEqual([]);
    for (const key of ['settings.storage.addCleanupRule', 'settings.notifications.backupNotifications', 'workspace.backupStatusLocation']) {
      expect(MOBILE_SETTINGS[key], key).toBe('desktop feature');
    }
  });

  it('a setting the phone words its own way is found under the phone\'s label', () => {
    for (const [desktopKey, phoneKey] of Object.entries(MOBILE_LABELS)) {
      expect(onPhone(MOBILE_SETTINGS[desktopKey]), desktopKey).toBe(true);
      expect(mobileSearchPages.filter((p) => p.settingKey === desktopKey).map((p) => p.labelKey)).toEqual([phoneKey]);
      expect(mobileSearchPages.some((p) => p.keywords && p.labelKey === desktopKey)).toBe(false);
    }
  });
});
