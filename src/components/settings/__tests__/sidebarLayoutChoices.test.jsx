// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { WorkspaceSettings } from '../WorkspaceSettings';
import { useSettingsStore } from '../../../stores/settingsStore';

// Keep this structural test independent of asynchronously loaded catalogs.

vi.mock('../../../i18n/index.js', async importOriginal => ({ ...(await importOriginal()), useT: () => key => key }));

beforeEach(() => {
  useSettingsStore.setState({ sidebarLayout: 'stacked', sidebarStyle: 'list', viewStyle: 'list', layoutMode: 'three-column', emailListStyle: 'compact' });
});
afterEach(cleanup);

it('shows all three structural examples before any choice is changed', () => {
  render(<WorkspaceSettings windowIsNarrow={false} />);
  const group = screen.getByRole('group', { name: 'workspace.sidebarLayout' });
  const buttons = within(group).getAllByRole('button');
  expect(buttons).toHaveLength(3);
  for (const layout of ['stacked', 'split', 'switcher']) {
    const sample = group.querySelector(`[data-sidebar-layout-preview="${layout}"]`);
    expect(sample).not.toBeNull();
    expect(sample.querySelectorAll('.sidebar-layout-sample-row').length).toBeGreaterThan(3);
  }
  expect(within(group).getByRole('button', { name: 'workspace.sidebarLayoutStacked' }).getAttribute('aria-pressed')).toBe('true');
});

it('changes the saved layout while leaving folder style and reading preferences alone', () => {
  render(<WorkspaceSettings windowIsNarrow={false} />);
  const group = screen.getByRole('group', { name: 'workspace.sidebarLayout' });
  for (const [name, value] of [['workspace.sidebarLayoutSplit', 'split'], ['workspace.sidebarLayoutSwitcher', 'switcher'], ['workspace.sidebarLayoutStacked', 'stacked']]) {
    fireEvent.click(within(group).getByRole('button', { name }));
    expect(useSettingsStore.getState().sidebarLayout).toBe(value);
    expect(within(group).getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
    expect(useSettingsStore.getState().sidebarStyle).toBe('list');
    expect(useSettingsStore.getState().layoutMode).toBe('three-column');
  }
  fireEvent.click(screen.getByRole('button', { name: 'workspace.navigationBubbles' }));
  expect(useSettingsStore.getState().sidebarStyle).toBe('tagcloud');
  expect(useSettingsStore.getState().sidebarLayout).toBe('stacked');
});

it('keeps sidebar alternatives usable in Chat and explains every option', () => {
  useSettingsStore.setState({ viewStyle: 'chat' });
  render(<WorkspaceSettings windowIsNarrow />);
  const group = screen.getByRole('group', { name: 'workspace.sidebarLayout' });
  for (const label of ['Stacked', 'Split', 'Switcher']) {
    const button = within(group).getByRole('button', { name: `workspace.sidebarLayout${label}` });
    expect(button.disabled).toBe(false);
    const hint = document.getElementById(button.getAttribute('aria-describedby'));
    expect(hint?.textContent).toBe(`workspace.sidebarLayout${label}Hint`);
  }
});
