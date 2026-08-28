import React, { useMemo } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { usePremiumPriceBlurb } from '../../hooks/usePremiumPricing.js';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { TRACKER_PATTERNS } from '../../utils/trackerList';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { ToggleSwitch } from './ToggleSwitch';
import { Button } from '../ui/Button';

/** The beacon, exactly as senders ship it. Shown verbatim — this is the point. */
const TRACKER_SAMPLE = `<img src="https://mailer.example.com/o/open.php`
  + `?u=8f21c0&id=a91f&e=you%40yourdomain.com"
     width="1" height="1" border="0"
     style="display:none;height:1px;width:1px" alt="">`;

const CLEANED_SAMPLE = `<span data-mv-tracker-blocked="Mailchimp" hidden></span>`;

/** What the sender learns when that one pixel loads. */
const LEAKED = [
  'That you opened it — and every time you re-open it',
  'The minute you opened it, and your time zone',
  'Your IP address, so roughly where you were',
  'Your device and mail client, from the user agent',
];

function SampleMail({ blocked }) {
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
        {blocked ? 'After — beacon removed' : 'Before — beacon fires on open'}
      </div>
      <div className="p-3 text-[11px] leading-relaxed text-[#333] bg-white">
        <div className="font-semibold text-[12px] text-[#111]">Your weekly digest</div>
        <div className="text-[#666] mb-2">news@mailer.example.com</div>
        <p className="m-0 mb-2">Hi there — here is what you missed this week.</p>
        <div className="h-6 rounded bg-[#eef1f6]" />
        {blocked ? (
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-indigo-700">
            <ShieldCheck size={11} />
            1 tracking pixel removed before render
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-red-600">
            <span className="inline-block w-[6px] h-[6px] rounded-full bg-red-500 animate-pulse" />
            1×1 pixel loading from mailer.example.com
          </div>
        )}
      </div>
    </div>
  );
}

export function TrackerBlockingView({ onUpgrade }) {
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const trackerBlockingEnabled = useSettingsStore(s => s.trackerBlockingEnabled);
  const setTrackerBlockingEnabled = useSettingsStore(s => s.setTrackerBlockingEnabled);
  const trackerAlerts = useSettingsStore(s => s.trackerAlerts);
  const priceBlurb = usePremiumPriceBlurb();

  const isPremium = hasPremiumAccess(billingProfile);
  const active = isPremium && trackerBlockingEnabled;

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
    <div className="p-6 space-y-6 overflow-y-auto h-full" data-testid="settings-tracker-blocking">
      {/* Header + the switch itself */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-mail-text flex items-center gap-2">
              <EyeOff size={16} className="text-mail-accent-text" />
              Block tracking pixels
            </h4>
            <p className="text-xs text-mail-text-muted mt-1 max-w-xl">
              Marketing mail hides a 1×1 image in the body. Loading it tells the sender you opened
              the message. MailVault strips those beacons out of the HTML before the message is
              rendered, so nothing is ever requested.
            </p>
          </div>
          {isPremium ? (
            <ToggleSwitch
              active={trackerBlockingEnabled}
              onClick={() => setTrackerBlockingEnabled(!trackerBlockingEnabled)}
            />
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-mail-text-muted shrink-0">
              <Lock size={13} />
              Premium
            </div>
          )}
        </div>

        <div className={`mt-4 text-xs flex items-center gap-1.5 ${active ? 'text-mail-accent-text' : 'text-mail-text-muted'}`}>
          {active ? <ShieldCheck size={13} /> : <Eye size={13} />}
          {active
            ? 'Blocking is on. Every message you open is cleared before it renders.'
            : 'Blocking is off. Detection still runs — the glyph on a message tells you it tracked you.'}
        </div>
      </div>

      {/* The upsell. Free users get the whole demonstration, not a locked box. */}
      {!isPremium && (
        <div className="border border-mail-accent/30 bg-mail-accent/5 rounded-xl p-5" data-testid="tracker-upsell">
          <h4 className="text-sm font-semibold text-mail-text">Tracker Blocking is a Premium Feature</h4>
          <p className="text-xs text-mail-text-muted mt-1 max-w-xl">
            Detection is free — you can always see that a message tracked you and which company sent
            the beacon. Premium is what removes it before the request goes out.
          </p>
          {!IS_APPSTORE_BUILD && <p className="text-xs text-mail-text-muted mt-2">{priceBlurb}</p>}
          {!IS_APPSTORE_BUILD && onUpgrade && (
            <Button variant="primary" size="sm" pill className="mt-3 text-xs" onClick={onUpgrade}>
              Upgrade
            </Button>
          )}
          {/* The one link every premium gate shares — this gate is not an
              exception to it just because its demonstration is longer. */}
          <PremiumFeaturesLink className="mt-4 block" />
        </div>
      )}

      {/* Before / after */}
      <div>
        <h4 className="text-sm font-medium text-mail-text mb-2">Before and after</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SampleMail blocked={false} />
          <SampleMail blocked />
        </div>
      </div>

      {/* The code itself */}
      <div>
        <h4 className="text-sm font-medium text-mail-text mb-2">What a tracking pixel looks like</h4>
        <div className="space-y-2">
          <div>
            <div className="text-xs text-mail-text-muted mb-1">In the email you received:</div>
            <pre className="p-3 rounded-lg bg-mail-surface border border-mail-border text-[11px] font-mono text-mail-text whitespace-pre-wrap break-all overflow-x-auto">{TRACKER_SAMPLE}</pre>
          </div>
          <div>
            <div className="text-xs text-mail-text-muted mb-1">After MailVault clears it:</div>
            <pre className="p-3 rounded-lg bg-mail-surface border border-mail-border text-[11px] font-mono text-mail-text whitespace-pre-wrap break-all overflow-x-auto">{CLEANED_SAMPLE}</pre>
          </div>
        </div>
      </div>

      {/* What it costs you to load one */}
      <div>
        <h4 className="text-sm font-medium text-mail-text mb-2">What that one pixel tells the sender</h4>
        <ul className="space-y-1">
          {LEAKED.map((line, i) => (
            <li key={i} className="text-xs text-mail-text-muted flex items-start gap-2">
              <span className="text-mail-warning mt-[3px]">•</span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      {/* What this install has actually seen */}
      <div className="pt-4 border-t border-mail-border">
        <h4 className="text-sm font-medium text-mail-text mb-2">In your mail</h4>
        {stats.messages > 0 ? (
          <>
            <p className="text-xs text-mail-text-muted">
              {stats.pixels} tracking {stats.pixels === 1 ? 'pixel' : 'pixels'} found across{' '}
              {stats.messages} {stats.messages === 1 ? 'message' : 'messages'} you have opened.
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
            Nothing found yet. Messages are scanned as you open them — scanning runs entirely on this
            device, and no part of an email is sent anywhere.
          </p>
        )}
        <p className="text-[11px] text-mail-text-muted/70 mt-3">
          {TRACKER_PATTERNS.length} known open-tracking endpoints are bundled with the app, merged
          from the MailTrackerBlocker and Ugly Email lists. The list ships in the app and is updated
          with each release — MailVault never fetches one at runtime.
        </p>
      </div>
    </div>
  );
}
