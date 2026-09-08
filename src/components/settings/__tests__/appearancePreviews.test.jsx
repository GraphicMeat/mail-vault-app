// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppearanceSettings } from '../AppearanceSettings';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useThemeStore } from '../../../stores/themeStore';
import { getEmailColors } from '../../../utils/mailChrome';
import { setLocale } from '../../../i18n';

const example = name => screen.getByRole('figure', { name: `Example: ${name}`, exact: true });
const select = (name, value) => fireEvent.change(screen.getByRole('combobox', { name, exact: true }), { target: { value } });

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
  useSettingsStore.setState({ viewStyle: 'list', layoutMode: 'three-column', sidebarStyle: 'list', emailListStyle: 'compact', threadMode: 'grouped', threadSortOrder: 'oldest-first', signatureDisplay: 'smart', emailRowHighlight: 'hover', actionButtonDisplay: 'icon-label', emailViewerTheme: 'system', dateFormat: 'auto', customDateFormat: 'yyyy.MM.dd', timeFormat: '24h' });
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await setLocale('en'); });

it('gives every Appearance preference a sample without adding mail actions to settings', () => {
  const { container } = render(<AppearanceSettings />);
  for (const section of ['Colors', 'Layout', 'Reading', 'Date & time']) {
    fireEvent.click(screen.getByRole('tab', { name: section, exact: true }));
    for (const row of container.querySelectorAll('.setting-row')) {
      expect(row.querySelector('figure, .color-option-preview, .sidebar-layout-sample')).not.toBeNull();
    }
    for (const figure of screen.getAllByRole('figure')) {
      expect(within(figure).queryByRole('button')).toBeNull();
      expect(within(figure).queryByRole('link')).toBeNull();
    }
  }
  expect(screen.getByText(/All messages below are samples/)).toBeTruthy();
});

it('compares unselected palettes and keeps dark email samples independent of a light app', () => {
  render(<AppearanceSettings />);
  const themeGroup = screen.getByRole('group', { name: 'Theme', exact: true });
  const paletteGroup = screen.getByRole('group', { name: 'Color palette' });
  const light = within(themeGroup).getByRole('button', { name: 'Light' });
  const graphite = within(paletteGroup).getByRole('button', { name: 'Graphite' });
  expect(light.querySelector('[data-theme="light"]')).not.toBeNull();
  expect(graphite.querySelector('[data-palette="graphite"]')).not.toBeNull();
  fireEvent.click(graphite);
  fireEvent.click(light);
  select('Email viewer theme', 'dark');
  const body = example('Email viewer theme').querySelector('[data-email-theme]');
  const expected = document.createElement('div');
  expected.style.backgroundColor = getEmailColors('dark', 'graphite').background;
  expect(body.style.backgroundColor).toBe(expected.style.backgroundColor);
  expect(body.dataset.emailTheme).toBe('dark');
  select('Email viewer theme', 'system');
  expect(body.dataset.emailTheme).toBe('light');
  expect(body.style.backgroundColor).toBe('rgb(255, 255, 255)');
});

it('shows workspace changes while clearly identifying saved email-only choices in Chat', () => {
  render(<AppearanceSettings initialSection="layout" />);
  fireEvent.click(screen.getByRole('button', { name: 'Below the list' }));
  expect(example('Reading pane').querySelector('.preview-mail-below')).not.toBeNull();
  expect(example('Mail view').querySelector('.preview-mail-below')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Bubbles' }));
  expect(example('Folder navigation').querySelector('.preview-navigation-bubbles')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Single line' }));
  expect(example('Message rows').querySelector('.preview-single-line')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
  expect(within(example('Mail view')).getByText('Two works for me.')).toBeTruthy();
  expect(within(example('Reading pane')).getByText('Saved layout · Email view')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Below the list' }).disabled).toBe(true);
  expect(useSettingsStore.getState().layoutMode).toBe('two-column');
});

it('shows grouped, expanded and separate messages, and reverses the sample reply order', () => {
  render(<AppearanceSettings initialSection="reading" />);
  expect(within(example('Conversations')).getByText('3')).toBeTruthy();
  select('Conversations', 'expandable');
  expect(within(example('Conversations')).getAllByText('Studio plans')).toHaveLength(4);
  select('Conversations', 'flat');
  expect(within(example('Conversations')).queryByText('3')).toBeNull();
  expect(within(example('Conversations')).getAllByText('Studio plans')).toHaveLength(3);
  const messages = () => [...example('Thread Sort Order').querySelectorAll('p')].map(p => p.textContent);
  expect(messages()).toEqual(['Shall we meet at two?', 'Two works for me.']);
  select('Thread Sort Order', 'newest-first');
  expect(messages()).toEqual(['Two works for me.', 'Shall we meet at two?']);
});

it('demonstrates signature deduplication, hiding, and disclosure for every signature choice', () => {
  render(<AppearanceSettings initialSection="reading" />);
  const signatures = () => within(example('Signature Display')).queryAllByText('Prime Cut Studio', { exact: false });
  const toggles = () => within(example('Signature Display')).queryAllByText(/Show signature/);
  expect(signatures()).toHaveLength(1);
  expect(toggles()).toHaveLength(1);
  select('Signature Display', 'always-show');
  expect(signatures()).toHaveLength(2);
  expect(toggles()).toHaveLength(0);
  select('Signature Display', 'always-hide');
  expect(signatures()).toHaveLength(0);
  expect(toggles()).toHaveLength(0);
  select('Signature Display', 'collapsed');
  expect(signatures()).toHaveLength(0);
  expect(toggles()).toHaveLength(2);
});

it('changes the sample row marking and the visible action labels', () => {
  render(<AppearanceSettings initialSection="reading" />);
  select('Highlighting', 'selection');
  expect(example('Highlighting').querySelector('.bg-mail-row-selected')).not.toBeNull();
  expect(example('Highlighting').querySelector('.bg-mail-surface-hover')).toBeNull();
  select('Highlighting', 'hover');
  expect(example('Highlighting').querySelector('.bg-mail-accent-tint')).not.toBeNull();
  expect(example('Highlighting').querySelector('.bg-mail-surface-hover')).not.toBeNull();
  select('Action button style', 'icon-only');
  expect(within(example('Action button style')).queryByText('Reply')).toBeNull();
  expect(example('Action button style').querySelectorAll('svg')).toHaveLength(2);
  select('Action button style', 'text-only');
  expect(within(example('Action button style')).getByText('Reply')).toBeTruthy();
  expect(example('Action button style').querySelectorAll('svg')).toHaveLength(0);
});

it('formats dates, custom patterns and times immediately using the reader formatters', () => {
  render(<AppearanceSettings initialSection="date-time" />);
  select('Date Format', 'dd/MM/yyyy');
  expect(within(example('Date Format')).getByText('25/02/2026')).toBeTruthy();
  select('Date Format', 'custom');
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom...' }), { target: { value: 'yyyy.MM.dd' } });
  expect(within(example('Custom...')).getByText('2026.02.25')).toBeTruthy();
  expect(within(example('Date Format')).getByText('2026.02.25')).toBeTruthy();
  expect(within(example('Time Format')).getByText('14:30')).toBeTruthy();
  select('Time Format', '12h');
  expect(within(example('Time Format')).getByText('2:30 PM')).toBeTruthy();
});

it('keeps unrelated preferences out of the current section and preserves saved choices across tabs', () => {
  render(<AppearanceSettings />);
  expect(screen.queryByRole('combobox', { name: 'Conversations' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Reading', exact: true }));
  select('Conversations', 'flat');
  fireEvent.click(screen.getByRole('tab', { name: 'Colors', exact: true }));
  expect(screen.queryByRole('combobox', { name: 'Conversations' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Reading', exact: true }));
  expect(screen.getByRole('combobox', { name: 'Conversations' }).value).toBe('flat');
});

it('translates sample content when the app language changes', async () => {
  await setLocale('de');
  render(<AppearanceSettings />);
  expect(screen.getByText(/Alle Nachrichten unten sind Beispiele/)).toBeTruthy();
  expect(screen.getAllByText('Studiopläne').length).toBeGreaterThan(0);
  expect(screen.queryByText('Studio plans')).toBeNull();
});
