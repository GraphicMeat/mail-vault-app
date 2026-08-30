// src/components/settings/__tests__/premiumFeatureList.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PREMIUM_FEATURES } from '../../../data/premiumFeatures.js';
import { PremiumFeatureList } from '../PremiumFeatureList';

afterEach(cleanup);

describe('PremiumFeatureList', () => {
  it('lists every premium feature, tracker removal included', () => {
    render(<PremiumFeatureList isPremium={false} onNavigate={() => {}} />);
    for (const f of PREMIUM_FEATURES) {
      expect(screen.getByTestId(`premium-feature-${f.id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('premium-feature-tracker-blocking').textContent)
      .toMatch(/Tracker removal/);
  });

  it('navigates to the feature\'s own settings tab', () => {
    const onNavigate = vi.fn();
    render(<PremiumFeatureList isPremium onNavigate={onNavigate} />);
    const row = screen.getByTestId('premium-feature-tracker-blocking');
    fireEvent.click(row.querySelector('button'));
    expect(onNavigate).toHaveBeenCalledWith('tracking');
  });

  it('offers no button for a feature with no settings surface', () => {
    render(<PremiumFeatureList isPremium onNavigate={() => {}} />);
    expect(screen.getByTestId('premium-feature-export-image').querySelector('button')).toBeNull();
  });

  it('marks rows locked without a subscription and included with one', () => {
    const { rerender } = render(<PremiumFeatureList isPremium={false} onNavigate={() => {}} />);
    expect(screen.getByTestId('premium-feature-cleanup').dataset.state).toBe('locked');
    rerender(<PremiumFeatureList isPremium onNavigate={() => {}} />);
    expect(screen.getByTestId('premium-feature-cleanup').dataset.state).toBe('included');
  });
});
