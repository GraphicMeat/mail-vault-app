// What every warning mark means, as a view both apps render (desktop's SafetyAlertLegend.jsx is its
// container: onboarding's compact card and Settings > Security; the phone's Security page).
// `shotUrl(shot)`: the screenshot of an alert, or null; without it no screenshots are shown (the
// phone bundles none).
import React from 'react';
import { SAFETY_ALERTS, TONE_CLASS } from '../../../data/safetyAlerts.js';
import { useT } from './viewContext';

/**
 * One component for two callers — the onboarding free step (compact, no
 * screenshots, four rows in a small card) and Settings → Security (full, with
 * the screenshot of each alert). Before this existed, Settings → Security
 * explained only the two LINK levels and did it in hardcoded English, and
 * onboarding invented four short labels that appear nowhere in the product.
 */
export function SafetyAlertLegendView({ compact = false, shotUrl = null }) {
  const t = useT();

  // Two entries share one screenshot; showing it twice is repetition, not
  // information, so the gallery keys on the shot and the list keys on the alert.
  const seenShots = new Set();

  return (
    <div className={compact ? 'space-y-0.5' : 'space-y-3'} data-testid="safety-legend">
      {SAFETY_ALERTS.map((a) => {
        const Icon = a.icon;
        // `count` only on the tracker pair — their strings are count-formatted
        // and a legend has no message to count.
        const vars = a.count === undefined ? undefined : { count: a.count };
        const url = shotUrl && !seenShots.has(a.shot) ? shotUrl(a.shot) : null;
        if (url) seenShots.add(a.shot);

        if (compact) {
          return (
            <div key={a.id} data-testid={`safety-alert-${a.id}`}
                 className="flex items-start gap-1.5 text-mail-text-muted min-w-0">
              <Icon size={11} className={`${TONE_CLASS[a.tone]} flex-shrink-0 mt-px`} />
              <span className="leading-tight" title={t(a.blurbKey, vars)}>{t(a.titleKey, vars)}</span>
            </div>
          );
        }

        return (
          <div key={a.id} data-testid={`safety-alert-${a.id}`}
               className="rounded-lg border border-mail-border bg-mail-surface p-3">
            <div className="flex items-start gap-2">
              <Icon size={14} className={`${TONE_CLASS[a.tone]} flex-shrink-0 mt-0.5`} />
              <div className="min-w-0">
                <div className="text-sm font-medium text-mail-text">{t(a.titleKey, vars)}</div>
                <p className="text-xs text-mail-text-muted leading-snug mt-0.5">{t(a.blurbKey, vars)}</p>
              </div>
            </div>
            {url && (
              <details className="mt-3">
                <summary className="text-xs text-mail-accent-text cursor-pointer w-fit rounded py-1">{t('safety.viewExample')}</summary>
              <img
                loading="lazy"
                src={url}
                alt={t(a.titleKey, vars)}
                data-testid={`safety-shot-${a.shot}`}
                className="w-full mt-2 rounded-lg border border-mail-border"
              />
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
