import React, { useEffect, useMemo, useState } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { openInBrowser } from '../../services/billingApi';
import { usePremiumPriceBlurb } from '../../hooks/usePremiumPricing.js';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { trackerPatternCount } from '../../services/bodyScan';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { DesktopViewEnv } from './DesktopViewEnv';
import { TrackingView } from './views/TrackingView';

/** Desktop's container: the settings store, the daemon's table size and this install's findings over TrackingView. */
export function TrackerBlockingView({ onUpgrade }) {
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const trackerBlockingEnabled = useSettingsStore(s => s.trackerBlockingEnabled);
  const setTrackerBlockingEnabled = useSettingsStore(s => s.setTrackerBlockingEnabled);
  const trackerAlerts = useSettingsStore(s => s.trackerAlerts);
  const priceBlurb = usePremiumPriceBlurb();
  // The table is the daemon's (src-core body_scan); the line waits for its size.
  const [patterns, setPatterns] = useState(null);
  useEffect(() => {
    let live = true;
    trackerPatternCount().then(n => { if (live) setPatterns(n); });
    return () => { live = false; };
  }, []);

  // Counts describe what was FOUND, never what was blocked: a message opened
  // before the subscription started had its beacon fire, and a page that
  // counted it as blocked would be telling a comfortable lie.
  const stats = useMemo(() => {
    const entries = Object.values(trackerAlerts || {}).filter(e => e && e.count);
    const pixels = entries.reduce((n, e) => n + e.count, 0);
    const tally = new Map();
    for (const e of entries) for (const v of e.vendors || []) tally.set(v, (tally.get(v) || 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { messages: entries.length, pixels, top };
  }, [trackerAlerts]);

  return (
    <DesktopViewEnv>
      <TrackingView isPremium={hasPremiumAccess(billingProfile)} enabled={trackerBlockingEnabled} onToggle={setTrackerBlockingEnabled}
        onUpgrade={IS_APPSTORE_BUILD ? null : onUpgrade} priceBlurb={IS_APPSTORE_BUILD ? null : priceBlurb}
        premiumLink={<PremiumFeaturesLink />} stats={stats} patterns={patterns}
        onOpenLink={url => openInBrowser(url).catch(() => {})} />
    </DesktopViewEnv>
  );
}
