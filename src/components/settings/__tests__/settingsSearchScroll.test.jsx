// @vitest-environment jsdom
//
// A settings search result opens its page AND lands on the setting itself:
// scrolled to the middle of the pane, briefly highlighted, focus on its
// control. A result behind a sub-tab (Backup's restore / settings / schedule)
// opens that sub-tab first.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Account settings stay real; reading cached folders is the disk boundary.
vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));
// Storage renders the search index panel; its daemon status is the boundary.
vi.mock('../../../services/searchIndex', async importOriginal => ({
  ...(await importOriginal()),
  status: () => Promise.resolve({ available: true, state: 'indexing', indexed: 12, total: 40, sizeBytes: 2048, complete: false }),
  rebuild: () => Promise.resolve(),
  destroy: () => Promise.resolve({ ok: true }),
  onProgress: () => Promise.resolve(() => {}),
  onDaemonReconnected: () => Promise.resolve(() => {}),
}));
// The per-account backup card has its own specs (see backupSchedule.test.jsx).
vi.mock('../BackupAccountCard', () => ({
  default: React.forwardRef(function StubCard({ account }, ref) {
    return <div ref={ref} data-testid="backup-account-card" data-account-id={account.id} />;
  }),
}));

const { SettingsPage, settingSearchGroups } = await import('../../SettingsPage');
const { useMailStore } = await import('../../../stores/mailStore');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { t } = await import('../../../i18n/index.js');

const ACCOUNT = { id: 'studio', name: 'Studio', email: 'studio@example.test', password: 'saved', imapHost: 'imap.example.test' };

let scrolled;
let reduceMotion;
let settingsSnapshot;
let mailSnapshot;
beforeEach(() => {
  scrolled = [];
  reduceMotion = false;
  // jsdom has no scrollIntoView: record which element asked to be shown.
  Element.prototype.scrollIntoView = vi.fn(function (options) { scrolled.push({ el: this, options }); });
  vi.stubGlobal('matchMedia', vi.fn(query => ({
    matches: reduceMotion && query.includes('prefers-reduced-motion'), media: query,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })));
  settingsSnapshot = useSettingsStore.getState();
  mailSnapshot = useMailStore.getState();
  useMailStore.setState({ accounts: [], activeAccountId: null });
  useSettingsStore.setState({
    billingProfile: { premiumAccess: true, clientAccessGranted: true, hasSubscription: true, status: 'active' },
    // A fresh price means no pricing request from the Premium hints.
    premiumPricing: { monthly: 400, yearly: 2500, currency: 'eur', fetchedAt: Date.now() },
    backupGlobalEnabled: true,
    backupGlobalConfig: { interval: 'daily', timeOfDay: '03:00', dayOfWeek: 1 },
  });
});
afterEach(() => {
  cleanup();
  delete Element.prototype.scrollIntoView;
  vi.unstubAllGlobals();
  useSettingsStore.setState(settingsSnapshot, true);
  useMailStore.setState(mailSnapshot, true);
});

const nav = () => within(screen.getByRole('navigation', { name: 'Settings' }));

/** Search for a setting by its own label and click its result. */
function openFromSearch(labelKey) {
  const label = t(labelKey);
  fireEvent.change(nav().getByRole('textbox', { name: 'Find a setting' }), { target: { value: label } });
  const result = nav().getAllByRole('button')
    .find(button => button.querySelector('.settings-search-result-copy > span')?.textContent === label);
  expect(result, `no search result labelled "${label}"`).toBeTruthy();
  fireEvent.click(result);
  return label;
}

/** The element shows the label as text, or carries it as a control's name. */
const hasLabel = (el, label) => el.textContent.includes(label)
  || [el, ...el.querySelectorAll('[aria-label]')].some(node => node.getAttribute('aria-label') === label);

const scrolledTo = label => scrolled.find(({ el }) => hasLabel(el, label));

// One setting from each kind of page: sectioned (Appearance, Mail
// preferences, Accounts), long single page (Storage), sub-tabbed (Backup).
const SAMPLE = [
  ['workspace.readingPane'],
  ['settings.appearance.threadMode'],
  ['settings.appearance.timeFormat'],
  ['settings.behavior.sendDelay'],
  ['settings.accounts.displayName', () => useMailStore.setState({ accounts: [ACCOUNT], activeAccountId: 'studio' })],
  ['settings.searchIndex.bodies'],
  ['settings.searchIndex.concurrency'],
  ['settings.backup.restore.exportBackup'],
  ['settings.backup.config.whatBackUp'],
  ['settings.mailLocation.whereMailStored'],
  ['settings.backup.schedule.backupFrequency'],
  ['settings.backup.schedule.mailboxConcurrency'],
];

describe('settings search lands on the setting', () => {
  it('samples only settings that search actually indexes', () => {
    const indexed = new Set(settingSearchGroups.flatMap(group => group.settings.map(([labelKey]) => labelKey)));
    expect(SAMPLE.map(([key]) => key).filter(key => !indexed.has(key))).toEqual([]);
  });

  it.each(SAMPLE)('scrolls %s into the middle of the pane and highlights it', async (labelKey, setup) => {
    setup?.();
    render(<SettingsPage onClose={() => {}} />);
    const label = openFromSearch(labelKey);
    await waitFor(() => expect(scrolledTo(label)).toBeTruthy());
    const { el, options } = scrolledTo(label);
    expect(options).toEqual({ block: 'center', behavior: 'smooth' });
    expect(el.classList.contains('settings-search-target')).toBe(true);
    expect(screen.getByTestId('settings-content').contains(el)).toBe(true);
  });

  it('moves focus to the setting\'s own control', async () => {
    render(<SettingsPage onClose={() => {}} />);
    openFromSearch('settings.behavior.sendDelay');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Send Delay' })));
  });

  it('jumps without animation when the user prefers reduced motion', async () => {
    reduceMotion = true;
    render(<SettingsPage onClose={() => {}} />);
    const label = openFromSearch('settings.appearance.timeFormat');
    await waitFor(() => expect(scrolledTo(label)).toBeTruthy());
    expect(scrolledTo(label).options).toEqual({ block: 'center', behavior: 'auto' });
  });

  it('lets the highlight go after a moment', async () => {
    render(<SettingsPage onClose={() => {}} />);
    const label = openFromSearch('settings.appearance.threadMode');
    await waitFor(() => expect(scrolledTo(label)).toBeTruthy());
    const { el } = scrolledTo(label);
    await waitFor(() => expect(el.classList.contains('settings-search-target')).toBe(false), { timeout: 3000 });
  });

  it('opens the Backup sub-tab that holds the setting, from any other sub-tab', async () => {
    render(<SettingsPage onClose={() => {}} />);
    for (const [labelKey, tab] of [
      ['settings.backup.schedule.backupFrequency', 'Backup Schedule'],
      ['settings.backup.restore.exportBackup', 'Backup & Restore'],
      ['settings.backup.config.whatBackUp', 'Backup Settings'],
      ['settings.backup.schedule.mailboxConcurrency', 'Backup Schedule'],
    ]) {
      const label = openFromSearch(labelKey);
      await waitFor(() => expect(screen.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected')).toBe('true'));
      await waitFor(() => expect(scrolledTo(label)).toBeTruthy());
      // Backup's "Settings" sub-tab is not the Cleanup-style settings sub-view.
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    }
  });

  it('returns to the searched Backup sub-tab after the user picked another one', async () => {
    render(<SettingsPage onClose={() => {}} />);
    openFromSearch('settings.backup.schedule.backupFrequency');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Backup Schedule' }).getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByRole('tab', { name: 'Backup & Restore', exact: true }));
    openFromSearch('settings.backup.schedule.backupFrequency');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Backup Schedule' }).getAttribute('aria-selected')).toBe('true'));
  });

  it('still opens the page when the setting is not on screen', async () => {
    // The timeline toggle lives in the view editor, not on the Views page.
    render(<SettingsPage onClose={() => {}} />);
    openFromSearch('views.showTimeline');
    expect(screen.getByRole('heading', { name: 'Views' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('settings-content').contains(document.activeElement)
      || document.activeElement === screen.getByTestId('settings-content')).toBe(true));
    expect(document.querySelector('.settings-search-target')).toBeNull();
  });
});
