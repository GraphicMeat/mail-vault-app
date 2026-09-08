// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsTabs } from '../SettingsTabs';
import { ColorSchemeSettings } from '../ColorSchemeSettings';
import { useThemeStore } from '../../../stores/themeStore';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { SettingsPage } from '../../SettingsPage';

// Account settings stay real; reading cached folders is the disk boundary.
vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [], activeAccountId: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses arrow keys and Home/End to navigate settings tabs', () => {
  function Example() {
    const [value, setValue] = useState('first');
    return <SettingsTabs label="Example" value={value} onChange={setValue}
      tabs={[{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]}>{value}</SettingsTabs>;
  }
  render(<Example />);
  const first = screen.getByRole('tab', { name: 'First' });
  const second = screen.getByRole('tab', { name: 'Second' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute('aria-selected')).toBe('true');
  expect(first.tabIndex).toBe(-1);
  expect(screen.getByRole('tabpanel', { name: 'Second' }).textContent).toBe('second');
  fireEvent.keyDown(second, { key: 'Home' });
  expect(document.activeElement).toBe(first);
});

it('applies the palette independently of light and dark mode', () => {
  useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
  render(<ColorSchemeSettings />);
  const graphite = screen.getByRole('button', { name: /Graphite/ });
  fireEvent.click(graphite);
  expect(document.documentElement.dataset.palette).toBe('graphite');
  expect(graphite.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Light', exact: true }));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(useThemeStore.getState().palette).toBe('graphite');
  useThemeStore.getState().initTheme();
  expect(document.documentElement.dataset.palette).toBe('graphite');
});

describe('settings page search', () => {
  it('opens a mail setting from its own label and lets the user change it', () => {
    render(<SettingsPage onClose={() => {}} />);
    const search = within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('textbox', { name: 'Find a setting' });
    fireEvent.change(search, { target: { value: 'send delay' } });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('button', { name: /Send Delay/ }));
    const delay = screen.getByRole('combobox', { name: 'Send Delay' });
    fireEvent.change(delay, { target: { value: '30' } });
    expect(useSettingsStore.getState().sendDelay).toBe(30);
    expect(search.value).toBe('');
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-selected')).toBe('true');
  });
  it('shows recovery copy for a search with no matching page', () => {
    render(<SettingsPage onClose={() => {}} />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
    fireEvent.change(nav.getByRole('textbox', { name: 'Find a setting' }), { target: { value: 'zzzzzz' } });
    expect(nav.getByRole('status').textContent).toBe('0 results');
    expect(nav.getByText(/Search by setting/)).toBeTruthy();
    fireEvent.click(nav.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: 'Accounts', exact: true })).toBeTruthy();
  });

  it.each([
    ['conversation', 'Conversations', 'Reading'],
    ['toolbar', 'Action button style', 'Reading'],
    ['date', 'Date Format', 'Date & time'],
    ['reading pane', 'Reading pane', 'Layout'],
    ['account switcher', 'Sidebar layout', 'Layout'],
  ])('finds %s and opens its Appearance section', (query, result, section) => {
    render(<SettingsPage onClose={() => {}} />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
    fireEvent.change(nav.getByRole('textbox', { name: 'Find a setting' }), { target: { value: query } });
    fireEvent.click(nav.getByRole('button', { name: new RegExp(`^${result}`) }));
    expect(screen.getByRole('tab', { name: section, exact: true }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('tabpanel', { name: section, exact: true }));
  });

  it('retains legacy General entry and remembers the Appearance section when returning from another page', () => {
    render(<SettingsPage initialTab="general" onClose={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Colors', exact: true }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Reading', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Mail preferences', exact: true }));
    expect(screen.getByRole('combobox', { name: 'Send Delay' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Appearance', exact: true }));
    expect(screen.getByRole('tab', { name: 'Reading', exact: true }).getAttribute('aria-selected')).toBe('true');
  });

  it('takes password and signature searches to the correct account sections', () => {
    useMailStore.setState({ accounts: [{ id: 'studio', name: 'Studio', email: 'studio@example.test', password: 'saved', imapHost: 'imap.example.test' }], activeAccountId: 'studio' });
    render(<SettingsPage onClose={() => {}} />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
    fireEvent.change(nav.getByRole('textbox', { name: 'Find a setting' }), { target: { value: 'password' } });
    fireEvent.click(nav.getByRole('button', { name: /^Password/ }));
    expect(screen.getByRole('tab', { name: 'Connection', exact: true }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Update', exact: true })).toBeTruthy();
    fireEvent.change(nav.getByRole('textbox', { name: 'Find a setting' }), { target: { value: 'signature' } });
    fireEvent.click(nav.getByRole('button', { name: /^Email Signature/ }));
    expect(screen.getByRole('tab', { name: 'Profile', exact: true }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Email Signature' })).toBeTruthy();
  });

  it('reopens the searched account section after manual tab changes, including repeated searches', () => {
    useMailStore.setState({ accounts: [{ id: 'studio', name: 'Studio', email: 'studio@example.test', password: 'saved', imapHost: 'imap.example.test' }], activeAccountId: 'studio' });
    render(<SettingsPage initialTab="accounts" onClose={() => {}} />);
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
    for (const [manualSection, query, result, targetSection] of [
      ['Advanced', 'signature', /^Email Signature/, 'Profile'],
      ['Advanced', 'signature', /^Email Signature/, 'Profile'],
      ['Advanced', 'password', /^Password/, 'Connection'],
      ['Profile', 'password', /^Password/, 'Connection'],
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: manualSection, exact: true }));
      fireEvent.change(nav.getByRole('textbox', { name: 'Find a setting' }), { target: { value: query } });
      fireEvent.click(nav.getByRole('button', { name: result }));
      expect(screen.getByRole('tab', { name: targetSection, exact: true }).getAttribute('aria-selected')).toBe('true');
    }
  });

  it('changes pages through the narrow-window navigation and searches there too', () => {
    const { container } = render(<SettingsPage onClose={() => {}} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Settings', exact: true }), { target: { value: 'mail-preferences' } });
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-selected')).toBe('true');
    const mobileSearch = within(container.querySelector('.settings-mobile-search'));
    fireEvent.change(mobileSearch.getByRole('textbox', { name: 'Find a setting' }), { target: { value: 'toolbar' } });
    fireEvent.click(mobileSearch.getByRole('button', { name: /^Action button style/ }));
    expect(screen.getByRole('combobox', { name: 'Action button style' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Settings', exact: true }).value).toBe('appearance');
  });
});
