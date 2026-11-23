// Settings > Privacy & security > Tracking as a view: the tracking-pixel switch (Premium), the
// upsell a free account sees, and what a tracking pixel is and costs.
//
// `isPremium`, `enabled`, `onToggle(next)`; `onUpgrade` (the Upgrade button, when the app sells
// Premium there) and `priceBlurb` (the price line, when it has one); `premiumLink`: the "what
// Premium includes" link every gate shares. `stats`: what this install has found
// (`{ messages, pixels, top: [[vendor, n]] }`), with `patterns` (the bundled table's size) and
// `onOpenLink(url)` for the list's sources; without `stats` that section is left out.
import React from 'react';
import { ExternalLink, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { Button } from '../../ui/Button';
import { SettingsCard, SettingsPageLayout } from '../../ui/SettingsForm';
import { useT } from './viewContext';

/** The beacon, exactly as senders ship it. Shown verbatim — this is the point. */
const TRACKER_SAMPLE = `<img src="https://mailer.example.com/o/open.php`
  + `?u=8f21c0&id=a91f&e=you%40yourdomain.com"
     width="1" height="1" border="0"
     style="display:none;height:1px;width:1px" alt="">`;

const CLEANED_SAMPLE = `<span data-mv-tracker-blocked="Mailchimp" title="…">🛡 Tracker blocked</span>`;

/** Where the bundled endpoint list comes from — the two upstreams named in
 *  src-core/src/body_scan/tracker_list.rs, in the order that table merges them. */
const SOURCES = [
  {
    labelKey: 'settings.tracking.uglyEmail',
    licence: 'MIT',
    url: 'https://github.com/OneClickLab/ugly-email-trackers',
  },
  {
    labelKey: 'settings.tracking.mailtrackerblocker',
    licenceKey: 'settings.tracking.bsd3Clause',
    url: 'https://github.com/apparition47/MailTrackerBlocker',
  },
];

/** What the sender learns when that one pixel loads. */
const LEAKED = () => ([
  'That you opened it, and every time you re-open it',
  'The minute you opened it, and your time zone',
  'Your IP address, so roughly where you were',
  'Your device and mail client, from the user agent',
]);

export function SampleMail({ blocked }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-mail-border bg-white overflow-hidden">
      {/* Fixed light colours, not app tokens: the card below is a PICTURE of an
          email, always rendered light, and a token that flips with the app
          theme washes out over it. Indigo rather than emerald for the cleared
          state — emerald is custody vocabulary and is not spent on decoration. */}
      <div className={`px-3 py-1.5 text-[11px] font-medium flex items-center gap-1.5 ${
        blocked ? 'bg-indigo-50 text-indigo-700' : 'bg-amber-50 text-amber-700'
      }`}>
        {blocked ? <EyeOff size={12} /> : <Eye size={12} />}
        {blocked ? t('settings.tracking.afterBeaconRemoved') : t('settings.tracking.beforeBeaconFiresOpen')}
      </div>
      <div className="p-3 text-[11px] leading-relaxed text-[#333] bg-white">
        <div className="font-semibold text-[12px] text-[#111]">{t('settings.tracking.weeklyDigest')}</div>
        <div className="text-[#666] mb-2">{t('settings.tracking.newsMailerExampleCom')}</div>
        <p className="m-0 mb-2">{t('settings.tracking.hiThereHereWhatMissed')}</p>
        <div className="h-6 rounded bg-[#eef1f6]" />
        {blocked ? (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-indigo-700">
            <ShieldCheck size={11} />
            {t('settings.tracking.onePixelRemovedBeforeRender')}
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
            <span className="inline-block w-[6px] h-[6px] rounded-full bg-red-500 animate-pulse" />
            {t('settings.tracking.pixelLoadingCaption')}
          </div>
        )}
      </div>
    </div>
  );
}

export function TrackingView({ isPremium, enabled: trackerBlockingEnabled, onToggle, onUpgrade = null, priceBlurb = null,
  premiumLink = null, stats = null, patterns = null, onOpenLink = () => {} }) {
  const t = useT();
  const active = isPremium && trackerBlockingEnabled;

  return (
    <SettingsPageLayout data-testid="settings-tracker-blocking">
      {/* Header + the switch itself */}
      <div className="settings-section">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-mail-text flex items-center gap-2">
              <EyeOff size={16} className="text-mail-accent-text" />
              {t('settings.tracking.blockTrackingPixels')}
            </h4>
            <p className="text-xs text-mail-text-muted mt-1 max-w-xl">
              {t('settings.tracking.marketingMailHidesPixel')}
            </p>
          </div>
          {isPremium ? (
            <ToggleSwitch
              label={t('settings.tracking.blockTrackingPixels')} active={trackerBlockingEnabled}
              onClick={() => onToggle(!trackerBlockingEnabled)}
            />
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-mail-text-muted shrink-0">
              <Lock size={13} />
              {t('common.premium')}
            </div>
          )}
        </div>

        <div className={`mt-4 text-xs flex items-center gap-1.5 ${active ? 'text-mail-accent-text' : 'text-mail-text-muted'}`}>
          {active ? <ShieldCheck size={13} /> : <Eye size={13} />}
          {active
            ? t('settings.tracking.blockingEveryMessageOpenCleared')
            : t('settings.tracking.blockingOffDetectionStillRuns')}
        </div>
      </div>

      {/* The upsell. Free users get the whole demonstration, not a locked box. */}
      {!isPremium && (
        <div className="border border-mail-accent/30 bg-mail-accent/5 rounded-xl p-5" data-testid="tracker-upsell">
          <h4 className="text-sm font-semibold text-mail-text">{t('settings.tracking.trackerBlockingPremiumFeature')}</h4>
          <p className="text-xs text-mail-text-muted mt-1 max-w-xl">
            {t('settings.tracking.detectionIsFreeBlockingIsPremium')}
          </p>
          {priceBlurb != null && <p className="text-xs text-mail-text-muted mt-2">{priceBlurb}</p>}
          {onUpgrade && (
            <Button variant="primary" size="sm" pill className="mt-3 text-xs" onClick={onUpgrade}>
              {t('common.upgrade')}
            </Button>
          )}
          {/* The one link every premium gate shares — this gate is not an
              exception to it just because its demonstration is longer. */}
          {premiumLink && <div className="mt-3">{premiumLink}</div>}
        </div>
      )}

      {/* Before / after */}
      <SettingsCard>
        <h4 className="text-sm font-medium text-mail-text mb-2">{t('settings.tracking.beforeAfter')}</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SampleMail blocked={false} />
          <SampleMail blocked />
        </div>
      </SettingsCard>

      {/* The code itself */}
      <SettingsCard>
        <h4 className="text-sm font-medium text-mail-text mb-2">{t('settings.tracking.whatTrackingPixelLooksLike')}</h4>
        <div className="space-y-2">
          <div>
            <div className="text-xs text-mail-text-muted mb-1">{t('settings.tracking.emailReceived')}</div>
            <pre className="p-3 rounded-lg bg-mail-surface border border-mail-border text-[11px] font-mono text-mail-text whitespace-pre-wrap break-all overflow-x-auto">{TRACKER_SAMPLE}</pre>
          </div>
          <div>
            <div className="text-xs text-mail-text-muted mb-1">{t('settings.tracking.afterMailvaultClears')}</div>
            <pre className="p-3 rounded-lg bg-mail-surface border border-mail-border text-[11px] font-mono text-mail-text whitespace-pre-wrap break-all overflow-x-auto">{CLEANED_SAMPLE}</pre>
          </div>
        </div>
      </SettingsCard>

      {/* What it costs you to load one */}
      <SettingsCard>
        <h4 className="text-sm font-medium text-mail-text mb-2">{t('settings.tracking.whatOnePixelTellsSender')}</h4>
        <ul className="space-y-1">
          {LEAKED().map((line, i) => (
            <li key={i} className="text-xs text-mail-text-muted flex items-start gap-2">
              <span className="text-mail-warning mt-[3px]">•</span>
              {line}
            </li>
          ))}
        </ul>
      </SettingsCard>

      {/* What this install has actually seen */}
      {stats && <SettingsCard>
        <h4 className="text-sm font-medium text-mail-text mb-2">{t('settings.tracking.mail')}</h4>
        {stats.messages > 0 ? (
          <>
            <p className="text-xs text-mail-text-muted">
              {t('settings.tracking.pixelsFound', { count: stats.pixels })}{' '}
              {t('settings.tracking.messagesOpened', { count: stats.messages })}
            </p>
            {stats.top.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {stats.top.map(([vendor, n]) => (
                  <span key={vendor} className="px-2 py-1 rounded-full text-[11px] bg-mail-surface border border-mail-border text-mail-text-muted">
                    {vendor} · {n}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-mail-text-muted">
            {t('settings.tracking.nothingFoundYetScanIsLocal')}
          </p>
        )}
        {patterns != null && (
          <p className="text-[11px] text-mail-text-muted/70 mt-3">
            {t('settings.tracking.knownEndpointsBundled', { count: patterns })}
          </p>
        )}
        {/* Named upstreams, linked. A blocklist whose provenance is a sentence
            is a claim; one you can open and read is a citation. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          {SOURCES.map(source => (
            <button
              key={source.url}
              type="button"
              onClick={() => onOpenLink(source.url)}
              className="inline-flex items-center gap-1 text-[11px] text-mail-text-muted hover:text-mail-accent-text transition-colors"
            >
              {t(source.labelKey)}
              <span className="text-mail-text-muted/60">· {source.licenceKey ? t(source.licenceKey) : source.licence}</span>
              <ExternalLink size={10} />
            </button>
          ))}
        </div>
      </SettingsCard>}
    </SettingsPageLayout>
  );
}
