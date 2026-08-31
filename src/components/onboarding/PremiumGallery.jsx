import React, { useCallback, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react';
import { PREMIUM_FEATURES } from '../../data/premiumFeatures.js';
import { useT, getLocale } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { Dialog } from '../ui/Dialog';
import { Z } from '../ui/layers';
import { shotUrl } from './premiumShots.js';

/**
 * The premium pitch, and the same component Settings → Help reopens later so
 * the gallery is reachable without resetting onboarding.
 *
 * Tiles on the left, one screenshot and one paragraph on the right, and
 * previous/next so the ten features can be walked through without aiming at a
 * tile. The detail column is a fixed height on purpose: the blurbs differ by
 * several lines, and letting the column size to its content moved the Continue
 * button up and down under the pointer as you browsed.
 */

// Tall enough for the longest blurb at the narrowest column. A scrollbar on a
// two-line paragraph would be worse than the wasted pixels under a short one.
const BLURB_H = 'min-h-[3.5rem]';

// The captures' own aspect ratio (1440x932). The media slot is fixed at it so
// the image and the no-screenshot fallback occupy exactly the same box: pinning
// only the blurb still left the layout jumping 12px on `devices`, the one
// feature with no shot, because its placeholder was 16/10.
const MEDIA = 'w-full aspect-[1440/932] rounded-lg overflow-hidden border border-mail-border mb-3';

export function PremiumGallery() {
  const t = useT();
  // Subscribe to the epoch so a language switch re-resolves the screenshots too.
  useSettingsStore(s => s.localeEpoch);
  const locale = getLocale();
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);

  const count = PREMIUM_FEATURES.length;
  const feature = PREMIUM_FEATURES[index];
  const url = shotUrl(feature.shot, locale);
  const Icon = feature.icon;

  // Wraps, so neither arrow is ever a dead control.
  const step = useCallback((d) => setIndex(i => (i + d + count) % count), [count]);

  return (
    <div className="grid md:grid-cols-[200px_minmax(0,1fr)] gap-4 items-start">
      <div className="space-y-1 max-h-[340px] overflow-y-auto pr-1">
        {PREMIUM_FEATURES.map((f, i) => {
          const TileIcon = f.icon;
          const active = i === index;
          return (
            <button
              key={f.id}
              type="button"
              data-testid={`premium-tile-${f.id}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => setIndex(i)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border text-left text-xs
                          transition-colors
                          ${active
                            ? 'border-mail-accent bg-mail-accent/10 text-mail-accent-text'
                            : 'border-transparent text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
            >
              <TileIcon size={14} className="flex-shrink-0" />
              {/* Wraps rather than truncates: "Scheduled automatic backups" and
                  its translations do not fit one 200px line, and a clipped
                  feature name is a feature nobody can identify. */}
              <span className="text-mail-text leading-tight">{t(f.titleKey)}</span>
            </button>
          );
        })}
      </div>

      <div data-testid="premium-detail" data-feature={feature.id}
           className="rounded-xl border border-mail-border bg-mail-surface p-3">
        {url ? (
          <button
            type="button"
            data-testid="premium-shot-zoom"
            onClick={() => setZoomed(true)}
            aria-label={t('premium.viewLarger')}
            className={`group relative block ${MEDIA}`}
          >
            <img src={url} alt={t(feature.titleKey)} data-testid="premium-shot"
                 className="w-full h-full object-cover object-top block" />
            <span className="absolute top-1.5 right-1.5 p-1 rounded bg-black/50 text-white opacity-0
                             group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">
              <Maximize2 size={12} />
            </span>
          </button>
        ) : (
          <div className={`${MEDIA} bg-mail-bg flex items-center justify-center`}>
            <Icon size={28} className="text-mail-accent-text" />
          </div>
        )}

        <h3 className="text-sm font-semibold text-mail-text">{t(feature.titleKey)}</h3>
        <p className={`text-xs text-mail-text-muted leading-snug ${BLURB_H}`}>{t(feature.blurbKey)}</p>

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-mail-border">
          <Arrow testId="premium-prev" label={t('common.previous')} onClick={() => step(-1)}>
            <ChevronLeft size={16} />
          </Arrow>
          <span className="text-[10px] text-mail-text-muted tabular-nums" data-testid="premium-position">
            {index + 1} / {count}
          </span>
          <Arrow testId="premium-next" label={t('common.next')} onClick={() => step(1)}>
            <ChevronRight size={16} />
          </Arrow>
        </div>
      </div>

      {/* `custom` + unpadded: the panel is the picture, so the dialog must not
          wrap it in its own box, and no `title` — a titled Dialog puts its
          heading and close button at the panel's edges, which here is on top of
          the screenshot.
          Portalled and above `dialog`: Settings → Help renders this same gallery
          INSIDE the settings surface, and a lightbox that opens under its own
          host is the nested-dialog trap. */}
      <Dialog
        open={zoomed}
        onClose={() => setZoomed(false)}
        size="custom"
        padded={false}
        portal
        z={Z.alert}
        panelBg="bg-transparent"
        panelBorder="border-transparent"
        aria-label={t(feature.titleKey)}
        panelClassName="max-w-[92vw] max-h-[90vh]"
        data-testid="premium-lightbox"
      >
        {url && (
          <>
            <img src={url} alt={t(feature.titleKey)} data-testid="premium-lightbox-shot"
                 className="max-w-full max-h-[85vh] rounded-lg shadow-2xl" />
            <button
              type="button"
              onClick={() => setZoomed(false)}
              aria-label={t('common.close')}
              data-testid="premium-lightbox-close"
              className="absolute -top-3 -right-3 p-1.5 rounded-full bg-mail-surface border border-mail-border
                         text-mail-text-muted hover:text-mail-text transition-colors"
            >
              <X size={16} />
            </button>
          </>
        )}
      </Dialog>
    </div>
  );
}

function Arrow({ testId, label, onClick, children }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-label={label}
      className="p-1.5 rounded-lg text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text
                 transition-colors"
    >
      {children}
    </button>
  );
}
