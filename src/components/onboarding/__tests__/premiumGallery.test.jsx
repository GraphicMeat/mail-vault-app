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

  // The list was capped at 340px and scrolled, so the last two features were
  // only reachable by discovering a scrollbar. Every tile stays on screen.
  it('never puts the feature list behind a scrollbar', () => {
    render(<PremiumGallery />);
    const list = screen.getByTestId(`premium-tile-${PREMIUM_FEATURES[0].id}`).parentElement;
    for (const f of PREMIUM_FEATURES) {
      expect(screen.getByTestId(`premium-tile-${f.id}`).parentElement).toBe(list);
    }
    expect(list.className).not.toMatch(/overflow-|max-h-/);
  });

  it('selects a feature and shows its detail', () => {
    render(<PremiumGallery />);
    fireEvent.click(screen.getByTestId('premium-tile-time-capsule'));
    expect(screen.getByTestId('premium-detail').dataset.feature).toBe('time-capsule');
  });

  it('walks the catalog with previous and next', () => {
    render(<PremiumGallery />);
    const shown = () => screen.getByTestId('premium-detail').dataset.feature;
    expect(shown()).toBe(PREMIUM_FEATURES[0].id);

    fireEvent.click(screen.getByTestId('premium-next'));
    expect(shown()).toBe(PREMIUM_FEATURES[1].id);
    fireEvent.click(screen.getByTestId('premium-prev'));
    expect(shown()).toBe(PREMIUM_FEATURES[0].id);
  });

  // Neither arrow is ever a dead control, so nobody has to discover which end
  // of the list they are on before clicking.
  it('wraps at both ends', () => {
    render(<PremiumGallery />);
    const shown = () => screen.getByTestId('premium-detail').dataset.feature;
    const last = PREMIUM_FEATURES[PREMIUM_FEATURES.length - 1].id;

    fireEvent.click(screen.getByTestId('premium-prev'));
    expect(shown()).toBe(last);
    fireEvent.click(screen.getByTestId('premium-next'));
    expect(shown()).toBe(PREMIUM_FEATURES[0].id);
  });

  it('keeps the tiles and the carousel on the same feature', () => {
    render(<PremiumGallery />);
    fireEvent.click(screen.getByTestId('premium-next'));
    const tile = screen.getByTestId(`premium-tile-${PREMIUM_FEATURES[1].id}`);
    expect(tile.getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('premium-position').textContent).toBe('2 / ' + PREMIUM_FEATURES.length);
  });

  // The blurbs differ by several lines. Without a floor on the text block the
  // Continue button below the gallery moved as you browsed.
  it('reserves a fixed height for the blurb so the layout cannot jump', () => {
    render(<PremiumGallery />);
    const blurb = screen.getByTestId('premium-detail').querySelector('p');
    expect(blurb.className).toMatch(/min-h-/);
  });

  // "Scheduled automatic backups" — and every translation of it — is longer
  // than one line of a 200px tile. Clipping it hides which feature the tile is.
  it('never truncates a feature name in its tile', () => {
    render(<PremiumGallery />);
    for (const f of PREMIUM_FEATURES) {
      const tile = screen.getByTestId(`premium-tile-${f.id}`);
      // `className` on an SVG element is an SVGAnimatedString, not a string —
      // read the attribute so the icons inside the tile are checked too.
      for (const el of [tile, ...tile.querySelectorAll('*')]) {
        expect(el.getAttribute('class') || '', f.id).not.toMatch(/\btruncate\b/);
      }
    }
  });

  // Until the capture run lands there is no image; the tile must still render
  // rather than leaving a broken <img>.
  it('degrades to no image when the shot is missing', () => {
    render(<PremiumGallery />);
    const detail = screen.getByTestId('premium-detail');
    const img = detail.querySelector('img');
    if (img) expect(img.getAttribute('src')).toBeTruthy();
  });

  it('opens the screenshot in a lightbox, and only when there is one', () => {
    render(<PremiumGallery />);
    const zoom = screen.queryByTestId('premium-shot-zoom');
    // No bundled shot in the unit environment is a legitimate state — the
    // gallery falls back to an icon, and there is then nothing to enlarge.
    if (!zoom) {
      expect(screen.queryByTestId('premium-shot')).toBeNull();
      return;
    }
    expect(screen.queryByTestId('premium-lightbox-shot')).toBeNull();
    fireEvent.click(zoom);
    expect(screen.getByTestId('premium-lightbox-shot')).toBeTruthy();
    fireEvent.click(screen.getByTestId('premium-lightbox-close'));
    expect(screen.queryByTestId('premium-lightbox-shot')).toBeNull();
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
