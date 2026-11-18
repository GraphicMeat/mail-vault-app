import React from 'react';
import { safetyShotUrl } from './onboarding/safetyShots.js';
import { DesktopViewEnv } from './settings/DesktopViewEnv';
import { SafetyAlertLegendView } from './settings/views/SafetyAlertLegendView';

/**
 * What every warning mark means, in the app's own words: the shared view
 * (settings/views/SafetyAlertLegendView.jsx) in the desktop context, with the
 * locale's screenshots when `showShots`.
 */
export function SafetyAlertLegend({ compact = false, locale, showShots = false }) {
  return <DesktopViewEnv>
    <SafetyAlertLegendView compact={compact} shotUrl={showShots ? shot => safetyShotUrl(shot, locale) : null} />
  </DesktopViewEnv>;
}
