// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
vi.mock('../../../stores/settingsStore', async (orig) => ({ ...(await orig()), hasPremiumAccess: vi.fn(() => false) }));
import { hasPremiumAccess } from '../../../stores/settingsStore';
import { PrivacyModeButton } from '../PrivacyModeButton';
import { usePrivacyStore } from '../../../stores/privacyStore';

beforeEach(() => usePrivacyStore.setState({ enabled: false, peek: false }));
afterEach(cleanup);

describe('PrivacyModeButton', () => {
  it('opens the upsell instead of enabling without Premium', () => {
    render(<PrivacyModeButton onUpgrade={() => {}} />);
    fireEvent.click(screen.getByTestId('privacy-button'));
    expect(usePrivacyStore.getState().enabled).toBe(false);
    expect(screen.getByText(/Premium feature/)).toBeTruthy();
  });
  it('toggles with Premium and exposes the state', () => {
    hasPremiumAccess.mockReturnValue(true);
    render(<PrivacyModeButton onUpgrade={() => {}} />);
    const btn = screen.getByTestId('privacy-button');
    fireEvent.click(btn);
    expect(usePrivacyStore.getState().enabled).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
  it('turns off without Premium', () => {
    hasPremiumAccess.mockReturnValue(false);
    usePrivacyStore.setState({ enabled: true });
    render(<PrivacyModeButton onUpgrade={() => {}} />);
    fireEvent.click(screen.getByTestId('privacy-button'));
    expect(usePrivacyStore.getState().enabled).toBe(false);
  });
});
