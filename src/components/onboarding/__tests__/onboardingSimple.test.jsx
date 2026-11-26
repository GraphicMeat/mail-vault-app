// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useThemeStore } from '../../../stores/themeStore';
import { t } from '../../../i18n';
import { DEFAULT_QUICK_ACTIONS, normalizeQuickActions } from '../../../utils/quickActions';
import '../../../services/workflows/bindStoreActions';

const invoke = vi.fn(() => Promise.resolve({ isDefault: false, canSet: true, hint: '' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));

const { AppearanceStep } = await import('../AppearanceStep');
const { DefaultMailStep } = await import('../DefaultMailStep');
const { FreeFeatures } = await import('../FreeFeatures');

beforeEach(() => {
  useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
  useSettingsStore.setState({ layoutMode: 'three-column', viewStyle: 'list', emailListStyle: 'compact', threadMode: 'grouped',
    afterDeleteSelect: 'none', confirmBeforeDelete: true, afterDeleteSameAccount: false, appFont: 'instrument-sans',
    quickActions: normalizeQuickActions(DEFAULT_QUICK_ACTIONS) });
});
afterEach(cleanup);

// Every step is one screen: its content, then one footer with the way on.
const footer = () => document.querySelector('.onboarding-screen > .onboarding-footer');

describe('onboarding screens', () => {
  it('pins Continue in the shared footer on the mail, free and appearance steps', async () => {
    render(<DefaultMailStep onContinue={() => {}} />);
    expect(footer().contains(await screen.findByTestId('onboarding-continue'))).toBe(true);
    cleanup();
    render(<FreeFeatures onContinue={() => {}} />);
    expect(footer().contains(screen.getByTestId('onboarding-continue'))).toBe(true);
    cleanup();
    render(<AppearanceStep onContinue={() => {}} />);
    expect(footer().contains(screen.getByTestId('appearance-next'))).toBe(true);
    expect(footer().contains(screen.getByTestId('appearance-recommended'))).toBe(true);
  });
});

describe('mail habits step', () => {
  it('asks whether to confirm a delete', () => {
    render(<DefaultMailStep onContinue={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: t('settings.behavior.confirmBeforeDelete') });
    expect(within(group).getByRole('radio', { name: t('settings.behavior.confirmDeleteAsk') }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: t('settings.behavior.confirmDeleteSkip') }));
    expect(useSettingsStore.getState().confirmBeforeDelete).toBe(false);
  });

  it('picks what opens after a delete from three pictured cards, with the same-account switch for a move', () => {
    render(<DefaultMailStep onContinue={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: t('settings.behavior.whenAnEmailIsDeleted') });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map(r => r.textContent.trim())).toEqual([
      t('settings.behavior.afterDeleteSelectNext'), t('settings.behavior.afterDeleteSelectPrevious'), t('settings.behavior.afterDeleteSelectNothing'),
    ].map(s => expect.stringContaining(s)));
    expect(screen.queryByRole('switch', { name: t('settings.behavior.afterDeleteSameAccount') })).toBeNull();
    fireEvent.click(radios[0]);
    expect(useSettingsStore.getState().afterDeleteSelect).toBe('next');
    const same = screen.getByRole('switch', { name: t('settings.behavior.afterDeleteSameAccount') });
    fireEvent.click(same);
    expect(useSettingsStore.getState().afterDeleteSameAccount).toBe(true);
  });
});

describe('appearance step, simplified', () => {
  const tab = name => screen.getByRole('tab', { name: name === 'quick-actions' ? 'Quick actions' : t(`settings.appearance.section.${name}`) });

  it('leaves deleting to the mail step, and Use recommended leaves it alone', () => {
    useSettingsStore.setState({ afterDeleteSelect: 'next', confirmBeforeDelete: false });
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('reading'));
    expect(screen.queryByTestId('appearance-control-delete-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('appearance-recommended'));
    expect(useSettingsStore.getState()).toMatchObject({ afterDeleteSelect: 'next', confirmBeforeDelete: false });
  });

  it('picks the font from one menu', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    const font = screen.getByRole('combobox', { name: t('settings.text.font') });
    fireEvent.change(font, { target: { value: 'atkinson' } });
    expect(useSettingsStore.getState().appFont).toBe('atkinson');
  });

  it('draws the palettes as swatches', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    const swatch = screen.getByTestId('appearance-palette-graphite');
    expect(swatch.classList.contains('onboarding-swatch')).toBe(true);
    expect(swatch.querySelector('[data-testid="email-row"], .settings-color-option-preview')).toBeNull();
  });

  it('sets how a hovered row shows its actions from four light tiles', () => {
    render(<AppearanceStep onContinue={() => {}} />);
    fireEvent.click(tab('quick-actions'));
    expect(screen.queryByRole('radiogroup', { name: t('quickActions.surface') })).toBeNull();
    const layout = screen.getByRole('radiogroup', { name: 'Layout' });
    expect(within(layout).getAllByRole('radio')).toHaveLength(4);
    expect(layout.querySelector('[data-testid="email-row"]')).toBeNull();
    fireEvent.click(within(layout).getByRole('radio', { name: 'Menu' }));
    const { defaults } = useSettingsStore.getState().quickActions;
    expect(defaults.row.mode).toBe('menu');
    expect(defaults.reader.mode).toBe(DEFAULT_QUICK_ACTIONS.defaults.reader.mode);
    expect(screen.getByRole('group', { name: 'Action sets' }).querySelector('.quick-actions-card-sample')).toBeNull();
  });
});
