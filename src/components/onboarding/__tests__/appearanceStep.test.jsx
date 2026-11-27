// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useThemeStore } from '../../../stores/themeStore';
import { useMailStore } from '../../../stores/mailStore';
import { t } from '../../../i18n';
import { AppearanceStep } from '../AppearanceStep';
import { DEFAULT_QUICK_ACTIONS, normalizeQuickActions } from '../../../utils/quickActions';
import { QUICK_ACTION_PRESETS } from '../../../utils/quickActionPresets';
import { previewNotificationSound } from '../../../services/api';
import '../../../services/workflows/bindStoreActions';

vi.mock('../../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  previewNotificationSound: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
  useSettingsStore.setState({ layoutMode: 'three-column', sidebarStyle: 'list', sidebarLayout: 'stacked', viewStyle: 'list', emailListStyle: 'compact', threadMode: 'grouped', afterDeleteSelect: 'none', emailRowHighlight: 'hover', emailViewerTheme: 'system', actionButtonDisplay: 'icon-label', quickActions: normalizeQuickActions(DEFAULT_QUICK_ACTIONS) });
});
afterEach(cleanup);
const tab = name => screen.getByRole('tab', { name: t(`settings.appearance.section.${name}`) });

describe('appearance step', () => {
  it('shows the color and text choices groups, with secondary preferences kept out of initial setup', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getAllByTestId(/^appearance-control-/).map(group => group.dataset.testid))
      .toEqual(['appearance-control-theme', 'appearance-control-palette', 'appearance-control-font', 'appearance-control-text-size']);
    expect(screen.getByTestId('appearance-control-palette')).toBeTruthy();
    expect(screen.queryByTestId('appearance-control-after-delete')).toBeNull();
    expect(screen.queryByTestId('appearance-control-sidebar')).toBeNull();
  });

  it('lets the keyboard move between focused sections without losing the preview', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.keyDown(tab('colors'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('layout'));
    expect(screen.getByTestId('appearance-control-layout')).toBeTruthy();
    expect(screen.queryByTestId('appearance-control-theme')).toBeNull();
    fireEvent.keyDown(tab('layout'), { key: 'End' });
    expect(screen.getByTestId('appearance-control-quick-layout')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Preview' })).toBeTruthy();
  });

  it('updates the sample and persisted choices across tabs', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId('appearance-theme-light'));
    fireEvent.click(screen.getByTestId('appearance-palette-graphite'));
    fireEvent.click(tab('layout'));
    fireEvent.click(screen.getByTestId('appearance-layout-two-column'));
    fireEvent.click(tab('reading'));
    fireEvent.click(screen.getByTestId('appearance-threads-flat'));
    expect(useSettingsStore.getState()).toMatchObject({ layoutMode: 'two-column', threadMode: 'flat' });
    expect(useThemeStore.getState()).toMatchObject({ theme: 'light', palette: 'graphite' });
    expect(screen.getByTestId('preview-panes').dataset.layout).toBe('two-column');
    expect(screen.getByTestId('appearance-preview').dataset).toMatchObject({ theme: 'light', palette: 'graphite' });
    fireEvent.click(tab('colors'));
    expect(screen.getByTestId('appearance-palette-graphite').getAttribute('aria-pressed')).toBe('true');
  });

  it('preserves email preferences and explains unavailable controls in Chat', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('layout'));
    fireEvent.click(screen.getByTestId('appearance-layout-two-column'));
    fireEvent.click(screen.getByTestId('appearance-view-chat'));
    expect(screen.getByTestId('preview-chat')).toBeTruthy();
    for (const button of within(screen.getByTestId('appearance-control-layout')).getAllByRole('button')) expect(button.disabled).toBe(true);
    fireEvent.click(tab('reading'));
    for (const id of ['density', 'threads']) for (const button of within(screen.getByTestId(`appearance-control-${id}`)).getAllByRole('button')) expect(button.disabled).toBe(true);
    expect(screen.getByText(t('workspace.emailViewOnly'))).toBeTruthy();
    fireEvent.click(tab('layout'));
    fireEvent.click(screen.getByTestId('appearance-view-list'));
    expect(screen.getByTestId('preview-panes').dataset.layout).toBe('two-column');
  });

  it('picks the app font from one menu and the text size on the colors tab, and the sample shows the font', () => {
    useSettingsStore.setState({ appFont: 'instrument-sans', textScale: 1 });
    render(<AppearanceStep onContinue={() => {}} />);
    const font = within(screen.getByTestId('appearance-control-font')).getByRole('combobox', { name: t('settings.text.font') });
    expect([...font.options].map(o => o.value)).toEqual(expect.arrayContaining(['system', 'atkinson', 'jetbrains-mono']));
    fireEvent.change(font, { target: { value: 'atkinson' } });
    expect(useSettingsStore.getState().appFont).toBe('atkinson');
    expect(screen.getByTestId('appearance-preview').style.fontFamily).toContain('Atkinson Hyperlegible Next');
    fireEvent.click(within(screen.getByTestId('appearance-control-text-size')).getByRole('radio', { name: '110%' }));
    expect(useSettingsStore.getState().textScale).toBe(1.1);
  });
  it('applies current recommended defaults, including Follow the pointer', () => {
    useThemeStore.setState({ theme: 'light', palette: 'indigo' });
    useSettingsStore.setState({ layoutMode: 'two-column', sidebarStyle: 'tagcloud', sidebarLayout: 'switcher', viewStyle: 'chat', emailListStyle: 'default', threadMode: 'flat', afterDeleteSelect: 'next', emailRowHighlight: 'selection' });
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByTestId('appearance-recommended'));
    expect(useThemeStore.getState()).toMatchObject({ theme: 'dark', palette: 'graphite' });
    expect(useSettingsStore.getState()).toMatchObject({ layoutMode: 'three-column', sidebarStyle: 'list', sidebarLayout: 'stacked', viewStyle: 'list', emailListStyle: 'compact', threadMode: 'expandable', afterDeleteSelect: 'next', emailRowHighlight: 'hover' });
    expect(useSettingsStore.getState().quickActions.styleLinks.global).toBe(false);
  });

  it('picks how a hovered row shows its actions from four tiles, and keeps it through Continue', () => {
    const onContinue = vi.fn();
    render(<AppearanceStep onContinue={onContinue} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Quick actions' }));
    const layout = within(screen.getByTestId('appearance-control-quick-layout')).getByRole('radiogroup', { name: 'Layout' });
    expect(within(layout).getByRole('radio', { name: 'Radial' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(layout).getByRole('radio', { name: 'Menu' }));
    expect(useSettingsStore.getState().quickActions.defaults).toMatchObject({ row: { mode: 'menu' }, reader: { mode: 'inline' }, selection: { mode: 'inline' } });
    fireEvent.click(tab('colors'));
    fireEvent.click(screen.getByRole('tab', { name: 'Quick actions' }));
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().quickActions.defaults.row.mode).toBe('menu');
  });
  it('offers the other apps\' action sets, and one click sets all three surfaces', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Quick actions' }));
    const sets = screen.getByRole('group', { name: 'Action sets' });
    const names = () => within(sets).getAllByRole('button').filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.textContent.trim());
    expect(within(sets).getAllByRole('button').map(button => button.textContent.trim())).toEqual(['MailVault', 'Gmail', 'Outlook', 'Thunderbird']);
    expect(names()).toEqual(['MailVault']);
    fireEvent.click(within(sets).getByRole('button', { name: 'Thunderbird' }));
    const { surfaces } = QUICK_ACTION_PRESETS.find(preset => preset.id === 'thunderbird');
    const { defaults } = useSettingsStore.getState().quickActions;
    for (const surface of ['row', 'selection', 'reader']) {
      expect(defaults[surface].entries.map(entry => entry.action)).toEqual(surfaces[surface].entries.map(entry => entry.action));
      expect(defaults[surface].mode).toBe(surfaces[surface].mode);
    }
    expect(names()).toEqual(['Thunderbird']);
  });

  it('draws the sample from previewMail\'s cast before there is any mail, and nothing in it acts', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Quick actions' }));
    const frame = document.querySelector('.quick-actions-sample-frame');
    expect(frame.hasAttribute('data-quick-actions-preview')).toBe(true);
    const rows = within(frame).getAllByTestId('email-row');
    expect(rows.map(row => row.querySelector('[data-testid="row-subject"]').textContent))
      .toEqual([t('preview.row1.subject'), t('preview.row2.subject'), t('preview.row3.subject')]);
    fireEvent.click(rows[1]);
    fireEvent.click(within(rows[1]).getByTestId('star-toggle'));
    fireEvent.click(within(rows[2]).getByRole('checkbox'));
    const mail = useMailStore.getState();
    expect(mail.selectedEmailIds.size).toBe(0);
    expect(mail.selectedEmail).toBeFalsy();
    expect(mail.emails).toEqual([]);
  });

  it('restores One ring with the recommended settings, keeping the actions', () => {
    useSettingsStore.getState().setQuickActionStyle('row', null, { radialLayout: 'categories' });
    useSettingsStore.getState().setQuickActionSurface('row', null, {
      ...useSettingsStore.getState().quickActions.defaults.row, entries: [{ id: 'reply', action: 'reply' }, { id: 'forward', action: 'forward' }],
    });
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Quick actions' }));
    // The sample's wheel opens from its row's trigger, as in the list.
    const sampleWheel = () => {
      const open = () => document.querySelector('.quick-actions-radial[data-surface="row"][data-quick-actions-preview]');
      if (!open()) fireEvent.click(document.querySelector('.quick-actions-sample-frame .quick-actions-trigger'));
      return open();
    };
    expect(sampleWheel().dataset.radialLayout).toBe('categories');
    fireEvent.click(screen.getByTestId('appearance-recommended'));
    expect(useSettingsStore.getState().quickActions.defaults.row.radialLayout).toBe('flat');
    expect(useSettingsStore.getState().quickActions.defaults.row.entries.map(entry => entry.id)).toEqual(['reply', 'forward']);
    expect(sampleWheel().dataset.radialLayout).toBeUndefined();
  });

  it('picks and plays the new email sound on the reading tab, on a Mac with notifications on', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    useSettingsStore.setState(s => ({ notificationSettings: { ...s.notificationSettings, enabled: true, sound: 'Glass' } }));
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('reading'));
    const sound = within(screen.getByTestId('appearance-control-sound')).getByRole('combobox');
    expect(sound.value).toBe('Glass');
    fireEvent.change(sound, { target: { value: 'Pop' } });
    expect(useSettingsStore.getState().notificationSettings.sound).toBe('Pop');
    expect(previewNotificationSound).toHaveBeenCalledWith('Pop');
    fireEvent.change(sound, { target: { value: 'none' } });
    expect(useSettingsStore.getState().notificationSettings.sound).toBe('none');
    expect(previewNotificationSound).toHaveBeenCalledTimes(1);
    cleanup();

    // Notifications off: a sound would never play, so no picker.
    useSettingsStore.setState(s => ({ notificationSettings: { ...s.notificationSettings, enabled: false } }));
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('reading'));
    expect(screen.queryByTestId('appearance-control-sound')).toBeNull();
    delete navigator.platform;
  });
  it('makes Next the default and walks every tab before Continue', () => {
    const onContinue = vi.fn();
    useSettingsStore.setState({ sidebarStyle: 'tagcloud', afterDeleteSelect: 'next', emailRowHighlight: 'selection' });
    render(<AppearanceStep onContinue={onContinue} />);
    for (const name of ['colors', 'layout', 'reading']) {
      expect(tab(name).getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByTestId('onboarding-continue')).toBeNull();
      fireEvent.click(screen.getByTestId('appearance-next'));
    }
    expect(screen.getByRole('tab', { name: 'Quick actions' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('appearance-next')).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState()).toMatchObject({ sidebarStyle: 'tagcloud', afterDeleteSelect: 'next', emailRowHighlight: 'selection' });
  });
  it('offers every sidebar layout on the Layout tab, folders under the account included', () => {
    useSettingsStore.setState({ viewStyle: 'chat' });
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('layout'));
    const group = screen.getByTestId('appearance-control-sidebar-layout');
    expect(within(group).getAllByRole('button').map(b => b.dataset.testid))
      .toEqual(['appearance-sidebar-layout-stacked', 'appearance-sidebar-layout-split', 'appearance-sidebar-layout-switcher', 'appearance-sidebar-layout-nested']);
    for (const button of within(group).getAllByRole('button')) expect(button.disabled).toBe(false);
    fireEvent.click(screen.getByTestId('appearance-sidebar-layout-nested'));
    expect(useSettingsStore.getState().sidebarLayout).toBe('nested');
    expect(screen.getByTestId('appearance-sidebar-layout-nested').getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByText(t('workspace.sidebarLayoutNestedHint'))).toBeTruthy();
    fireEvent.click(screen.getByTestId('appearance-recommended'));
    expect(useSettingsStore.getState().sidebarLayout).toBe('stacked');
  });

  it('redraws the preview sidebar when a sidebar layout is picked', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('layout'));
    const sidebar = () => screen.getByTestId('preview-pane-sidebar');
    expect(sidebar().dataset.layout).toBe('stacked');
    for (const value of ['split', 'switcher', 'nested', 'stacked']) {
      fireEvent.click(screen.getByTestId(`appearance-sidebar-layout-${value}`));
      expect(useSettingsStore.getState().sidebarLayout).toBe(value);
      expect(sidebar().dataset.layout).toBe(value);
    }
  });

  // The demo window is the same box on every tab: Quick actions draws its
  // live rows inside it instead of swapping the window for a bare strip.
  it('keeps the demo window on the quick actions tab, with the live rows inside it', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Quick actions' }));
    const preview = screen.getByTestId('appearance-preview');
    expect(within(preview).getByTestId('preview-pane-sidebar')).toBeTruthy();
    const sample = preview.querySelector('[data-quick-actions-preview]');
    expect(sample).toBeTruthy();
    const layout = within(screen.getByTestId('appearance-control-quick-layout')).getByRole('radiogroup', { name: 'Layout' });
    fireEvent.click(within(layout).getByRole('radio', { name: 'Menu' }));
    expect(screen.getByTestId('appearance-preview').querySelector('[data-quick-actions-preview]')).toBeTruthy();
    expect(useSettingsStore.getState().quickActions.defaults.row.mode).toBe('menu');
  });
});
