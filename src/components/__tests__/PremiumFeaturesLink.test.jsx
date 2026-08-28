// @vitest-environment jsdom
//
// Every premium gate links out to the same feature page — except in an App
// Store build, where a page carrying the web subscription's price is a path to
// an external purchase. Gating a surface without gating its copy is how that
// link survives into a MAS build, so the absence is asserted, not assumed.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const openInBrowser = vi.fn(() => Promise.resolve(true));
vi.mock('../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));

const buildFlags = { IS_APPSTORE_BUILD: false };
vi.mock('../../utils/buildFlags.js', () => ({
  get IS_APPSTORE_BUILD() { return buildFlags.IS_APPSTORE_BUILD; },
}));

import { PremiumFeaturesLink } from '../PremiumFeaturesLink';

beforeEach(() => { buildFlags.IS_APPSTORE_BUILD = false; });
afterEach(() => { cleanup(); openInBrowser.mockClear(); });

describe('PremiumFeaturesLink', () => {
  it('opens the premium section of the feature page', () => {
    render(<PremiumFeaturesLink />);
    fireEvent.click(screen.getByRole('button', { name: /see everything in premium/i }));
    expect(openInBrowser).toHaveBeenCalledWith('https://mailvaultapp.com/features.html#premium');
  });

  it('renders nothing in an App Store build', () => {
    buildFlags.IS_APPSTORE_BUILD = true;
    const { container } = render(<PremiumFeaturesLink />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('button', { name: /premium/i })).toBeNull();
  });
});
