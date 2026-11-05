// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../SafetyAlertLegend.jsx', () => ({ SafetyAlertLegend: () => null }));

const { useSettingsStore } = await import('../../../stores/settingsStore');
const { SecuritySettings } = await import('../SecuritySettings');
const { t } = await import('../../../i18n/index.js');

afterEach(() => { cleanup(); useSettingsStore.setState({ holdExternalContent: false, billingProfile: null }); });

describe('the external content switch', () => {
  it('turns the setting on and off, on a free account too', () => {
    useSettingsStore.setState({ holdExternalContent: false, billingProfile: { hasSubscription: false } });
    render(<SecuritySettings />);
    const toggle = screen.getByRole('switch', { name: t('settings.security.askBeforeExternalContent') });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().holdExternalContent).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().holdExternalContent).toBe(false);
  });

  it('says what it does, and that it is not tracker blocking', () => {
    render(<SecuritySettings />);
    expect(screen.getByText(t('settings.security.askBeforeExternalContentHint'))).toBeTruthy();
  });
});
