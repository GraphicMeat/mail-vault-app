// @vitest-environment jsdom
//
// The Settings menu: four headed groups, a pinned footer, and host entries
// that fold related pages under one tab row. Every folded page keeps its own
// id as a destination (deep links, search, the detached window).
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useMailStore } from '../../../stores/mailStore';
import { IS_APPSTORE_BUILD } from '../../../utils/buildFlags';
import { SettingsPage } from '../../SettingsPage';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [], activeAccountId: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const nav = () => screen.getByRole('navigation', { name: 'Settings' });
const page = () => screen.getByTestId('settings-content').dataset.page;
const current = () => nav().querySelector('.settings-nav-item[aria-current="page"]')?.textContent;
const selectedTab = () => screen.getAllByRole('tab').filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent);

it('lists the groups, their entries in order, and the footer', () => {
  render(<SettingsPage onClose={() => {}} />);
  const groups = [...nav().querySelectorAll('.settings-nav-pages > *')]
    .map(el => el.matches('.settings-nav-heading') ? `# ${el.textContent}` : el.textContent);
  expect(groups).toEqual([
    '# General', 'Appearance', 'Mail preferences',
    '# Accounts & import', 'Accounts', 'Templates', 'Migration',
    '# Organize', 'Views', 'Auto Tags', 'AI', 'Unsubscribe', 'Email Cleanup',
    '# Vault & privacy', 'Storage', 'Backup & Restore', ...(IS_APPSTORE_BUILD ? [] : ['Portable']), 'Time Capsule', 'Privacy & security',
  ]);
  expect([...nav().querySelectorAll('.settings-nav-footer .settings-nav-item')].map(el => el.textContent))
    .toEqual(['Billing', 'Diagnostics', 'Help & Support']);
});

it('opens Privacy & security on its first tab and switches pages through its tab row', () => {
  render(<SettingsPage onClose={() => {}} />);
  fireEvent.click(within(nav()).getByRole('button', { name: 'Privacy & security' }));
  expect(screen.getByRole('tablist', { name: 'Privacy & security' })).toBeTruthy();
  expect(within(screen.getByRole('tablist', { name: 'Privacy & security' })).getAllByRole('tab').map(tab => tab.textContent))
    .toEqual(['Security', 'Tracker Blocking', 'Encryption']);
  expect(page()).toBe('security');
  expect(screen.getByRole('heading', { name: 'Privacy & security' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Encryption' }));
  expect(page()).toBe('encryption');
  expect(current()).toBe('Privacy & security');
});

it('opens a folded page id on its host with that tab selected', () => {
  render(<SettingsPage initialTab="tracking" onClose={() => {}} />);
  expect(current()).toBe('Privacy & security');
  expect(selectedTab()).toEqual(['Tracker Blocking']);
  expect(page()).toBe('tracking');
});

it('opens the old Language page as the last Appearance section', () => {
  render(<SettingsPage initialTab="language" onClose={() => {}} />);
  expect(current()).toBe('Appearance');
  expect(selectedTab()).toEqual(['Language']);
  expect(screen.getByRole('radiogroup', { name: 'App language' })).toBeTruthy();
});

it('opens Data Usage under Storage', () => {
  render(<SettingsPage initialTab="data-usage" onClose={() => {}} />);
  expect(current()).toBe('Storage');
  expect(selectedTab()).toEqual(['Data Usage']);
  expect(page()).toBe('data-usage');
  // The narrow-window menu names the host, not the folded page.
  expect(screen.getByRole('combobox', { name: 'Settings', exact: true }).value).toBe('storage');
});
