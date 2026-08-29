import React, { useCallback, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore';
import { usePremiumPriceBlurb } from '../hooks/usePremiumPricing.js';
import { IS_APPSTORE_BUILD } from '../utils/buildFlags';
import { t, useT  } from '../i18n/index.js';

/**
 * The dialog's contents, split into their own component on purpose:
 * `usePremiumPriceBlurb` fires a pricing request when it mounts, and the glyph
 * below is rendered by every row in the list. Mounting this only while the
 * dialog is open keeps that request on the one screen that shows a price.
 */
function TrackerDialogBody({ info, trackers, blocked, isPremium, onOpenFeaturePage }) {
  const t = useT();
  const priceBlurb = usePremiumPriceBlurb();
  const count = info.count;
  const vendors = info.vendors || [];

  return (
    <>
      <p className="text-sm text-mail-text-muted">
        {blocked
          ? t('alert.tracker.removed', { count })
          : t('alert.tracker.loaded', { count })}
      </p>

      <div className="space-y-2 max-h-[45vh] overflow-y-auto">
        {trackers && trackers.length > 0 ? trackers.map((tracker, i) => (
          <div key={i} className="p-3 rounded-lg bg-mail-surface border border-mail-border">
            <div className="text-sm font-medium text-mail-text">{tracker.vendor}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">{tracker.reason}</div>
            <div className="text-xs font-mono text-mail-text-muted break-all mt-1.5">{tracker.url}</div>
          </div>
        )) : vendors.map((v, i) => (
          <div key={i} className="p-3 rounded-lg bg-mail-surface border border-mail-border">
            <div className="text-sm font-medium text-mail-text">{v}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">{t('alert.tracker.openTrackingBeacon')}</div>
          </div>
        ))}
      </div>

      {!blocked && (
        <div className="p-3 rounded-lg border border-mail-border bg-mail-surface">
          <div className="text-sm font-medium text-mail-text">
            {isPremium ? t('alert.tracker.blockingSwitchedOff') : t('alert.tracker.trackerBlockingPremiumFeature')}
          </div>
          <p className="text-xs text-mail-text-muted mt-1">
            {isPremium
              ? t('alert.tracker.turnMailvaultStripsTheseBeacons')
              : t('alert.tracker.premiumStripsTheseBeaconsOut')}
          </p>
          {!isPremium && !IS_APPSTORE_BUILD && (
            <p className="text-xs text-mail-text-muted mt-1">{priceBlurb}</p>
          )}
          <Button variant="primary" size="sm" pill className="mt-3 text-xs" onClick={onOpenFeaturePage}>
            {isPremium ? t('alert.tracker.turnBlocking') : t('alert.tracker.seeHowBlockingWorks')}
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * The tracking glyph, on the same line as the domain-mismatch warnings.
 *
 * It says one of two things, never both:
 *   Eye    — this message tracks you, and the beacon fired.
 *   EyeOff — this message tracked you, and MailVault stripped it before render.
 *
 * `info` is the persisted summary `{ count, vendors }`; `trackers` is the full
 * per-beacon list when the body has been scanned this session (the dialog
 * falls back to vendor names when it hasn't).
 */
export function TrackerAlertIcon({ info, trackers, blocked, size = 14 }) {
  const t = useT();
  const [showModal, setShowModal] = useState(false);
  const billingProfile = useSettingsStore(s => s.billingProfile);

  const closeModal = useCallback(() => setShowModal(false), []);

  if (!info || !info.count) return null;

  const isPremium = hasPremiumAccess(billingProfile);
  const count = info.count;
  const title = blocked
    ? t('alert.tracker.trackingBlocked', { count })
    : t('alert.tracker.emailTracks', { count });
  const Glyph = blocked ? EyeOff : Eye;
  const tone = blocked ? 'text-mail-accent-text' : 'text-mail-warning';

  const openFeaturePage = () => {
    setShowModal(false);
    useMailStore.getState().requestSettingsTab('tracking');
  };

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
        className={`flex-shrink-0 ${tone} hover:opacity-80 transition-opacity`}
        aria-label={title}
        title={title}
        data-testid="tracker-alert-icon"
        data-blocked={blocked ? 'true' : 'false'}
      >
        <Glyph size={size} />
      </button>
      <Dialog
        open={showModal}
        onClose={closeModal}
        role="alertdialog"
        // Portal to body: virtualized list cells sit under an ancestor with a
        // `transform`, which becomes the containing block for `position: fixed`
        // and would clip this to the row.
        portal
        title={title}
        icon={
          <div className={`w-10 h-10 rounded-full ${blocked ? 'bg-mail-accent/10' : 'bg-mail-warning-tint'} flex items-center justify-center`}>
            <Glyph size={22} className={tone} />
          </div>
        }
      >
        {showModal && (
          <TrackerDialogBody
            info={info}
            trackers={trackers}
            blocked={blocked}
            isPremium={isPremium}
            onOpenFeaturePage={openFeaturePage}
          />
        )}
      </Dialog>
    </>
  );
}

/**
 * The thread's tracker summary: every beacon its messages carry, counted once.
 * A thread where one message was stripped and another was not still reports
 * "tracks you" — the glyph's blocked/not state is the live setting, and the
 * beacon that already fired is not undone by turning blocking on afterwards.
 */
export function getThreadTrackerInfo(emails) {
  if (!emails || emails.length === 0) return null;
  let merged = null;
  for (const e of emails) {
    const info = e._trackerInfo;
    if (!info?.count) continue;
    if (!merged) merged = { count: 0, vendors: [] };
    merged.count += info.count;
    for (const v of info.vendors || []) if (!merged.vendors.includes(v)) merged.vendors.push(v);
  }
  return merged;
}
