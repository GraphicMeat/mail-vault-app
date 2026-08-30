import React, { useState } from 'react';
import { PREMIUM_FEATURES } from '../../data/premiumFeatures.js';
import { useT, getLocale } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { shotUrl } from './premiumShots.js';

/**
 * The premium pitch, and the same component Settings → Help reopens later so
 * the gallery is reachable without resetting onboarding.
 *
 * Tiles on the left, one screenshot and one paragraph on the right.
 */
export function PremiumGallery() {
  const t = useT();
  // Subscribe to the epoch so a language switch re-resolves the screenshots too.
  useSettingsStore(s => s.localeEpoch);
  const locale = getLocale();
  const [selected, setSelected] = useState(PREMIUM_FEATURES[0].id);

  const feature = PREMIUM_FEATURES.find(f => f.id === selected) || PREMIUM_FEATURES[0];
  const url = shotUrl(feature.shot, locale);
  const Icon = feature.icon;

  return (
    <div className="grid md:grid-cols-[200px_minmax(0,1fr)] gap-4 items-start">
      <div className="space-y-1 max-h-[340px] overflow-y-auto pr-1">
        {PREMIUM_FEATURES.map((f) => {
          const TileIcon = f.icon;
          const active = f.id === selected;
          return (
            <button
              key={f.id}
              type="button"
              data-testid={`premium-tile-${f.id}`}
              onClick={() => setSelected(f.id)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border text-left text-xs
                          transition-colors
                          ${active
                            ? 'border-mail-accent bg-mail-accent/10 text-mail-accent-text'
                            : 'border-transparent text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
            >
              <TileIcon size={14} className="flex-shrink-0" />
              <span className="truncate text-mail-text">{t(f.titleKey)}</span>
            </button>
          );
        })}
      </div>

      <div data-testid="premium-detail" data-feature={feature.id}
           className="rounded-xl border border-mail-border bg-mail-surface p-3">
        {url ? (
          <img
            src={url}
            alt={t(feature.titleKey)}
            data-testid="premium-shot"
            className="w-full rounded-lg border border-mail-border mb-3"
          />
        ) : (
          <div className="w-full aspect-[16/10] rounded-lg border border-mail-border bg-mail-bg
                          flex items-center justify-center mb-3">
            <Icon size={28} className="text-mail-accent-text" />
          </div>
        )}
        <h3 className="text-sm font-semibold text-mail-text">{t(feature.titleKey)}</h3>
        <p className="text-xs text-mail-text-muted leading-snug">{t(feature.blurbKey)}</p>
      </div>
    </div>
  );
}
