// src/components/onboarding/__tests__/premiumGallery.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PREMIUM_FEATURES } from '../../../data/premiumFeatures.js';
import { PremiumGallery } from '../PremiumGallery';
import { UpgradeCta } from '../UpgradeCta';

afterEach(cleanup);

describe('premium gallery', () => {
  it('shows every catalog feature', () => {
    render(<PremiumGallery />);
    for (const f of PREMIUM_FEATURES) {
      expect(screen.getByTestId(`premium-tile-${f.id}`)).toBeTruthy();
    }
  });

  it('selects a feature and shows its detail', () => {
    render(<PremiumGallery />);
    fireEvent.click(screen.getByTestId('premium-tile-time-capsule'));
    expect(screen.getByTestId('premium-detail').dataset.feature).toBe('time-capsule');
  });

  // Until the capture run lands there is no image; the tile must still render
  // rather than leaving a broken <img>.
  it('degrades to no image when the shot is missing', () => {
    render(<PremiumGallery />);
    const detail = screen.getByTestId('premium-detail');
    const img = detail.querySelector('img');
    if (img) expect(img.getAttribute('src')).toBeTruthy();
  });
});

describe('upgrade CTA', () => {
  it('offers upgrade, skip and the FAQ', () => {
    const onUpgrade = vi.fn(), onSkip = vi.fn(), onOpenFaq = vi.fn();
    render(<UpgradeCta onUpgrade={onUpgrade} onSkip={onSkip} onOpenFaq={onOpenFaq} />);
    fireEvent.click(screen.getByTestId('onboarding-upgrade'));
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    fireEvent.click(screen.getByTestId('onboarding-faq'));
    expect(onUpgrade).toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalled();
    expect(onOpenFaq).toHaveBeenCalled();
  });

  // No price anywhere in the tour: that is what keeps the whole flow shippable
  // in an App Store build without a second code path.
  it('quotes no price', () => {
    render(<UpgradeCta onUpgrade={() => {}} onSkip={() => {}} onOpenFaq={() => {}} />);
    expect(document.body.textContent).not.toMatch(/[$€£]\s?\d/);
  });
});
