import React from 'react';
import { ExternalLink } from 'lucide-react';
import { IS_APPSTORE_BUILD } from '../utils/buildFlags.js';
import { openInBrowser } from '../services/billingApi';

const FEATURES_URL = 'https://mailvaultapp.com/features.html#premium';

/**
 * "See everything in Premium" — the one link every premium gate shares, so a
 * locked surface can say what else the subscription covers without each gate
 * growing its own copy of the list.
 *
 * Hidden in App Store builds for the same reason the price blurb is: a page
 * that carries the web subscription's price is a path to an external purchase,
 * and MAS builds must not advertise one.
 */
export function PremiumFeaturesLink({ className = '' }) {
  if (IS_APPSTORE_BUILD) return null;

  return (
    <button
      type="button"
      onClick={() => openInBrowser(FEATURES_URL).catch(() => {})}
      className={`inline-flex items-center gap-1.5 text-xs text-mail-text-muted hover:text-mail-accent-text transition-colors ${className}`}
    >
      See everything in Premium
      <ExternalLink size={12} />
    </button>
  );
}
