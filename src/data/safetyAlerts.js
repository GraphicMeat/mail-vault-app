import { AlertTriangle, CornerUpLeft, Eye, EyeOff, ShieldAlert } from 'lucide-react';

/**
 * Every mark the app can put on a message, once — with the SAME title the alert
 * itself shows.
 *
 * The onboarding tour used to teach four labels of its own invention
 * ("Dangerous", "Suspicious", "Reply-To mismatch", "Tracking pixel"). None of
 * them is a string the app ever displays: the real dialogs say "Sender
 * impersonation detected", "Tracking blocked (4)", "Reply-To domain mismatch".
 * A legend that teaches different words than the screen it describes is worse
 * than no legend, so every `titleKey` and `blurbKey` below is the key the
 * component itself renders.
 *
 * Sources, so this can be checked rather than trusted:
 *   link-*     `LinkAlertIcon.jsx`     — level 'red' | 'yellow'
 *   sender-*   `SenderAlertIcon.jsx`   — level 'red' | 'yellow'
 *   reply-to   `ReplyToAlertIcon.jsx`  — `email._replyToMismatch`
 *   tracker-*  `TrackerAlertIcon.jsx`  — blocked vs loaded
 *
 * `count` is set on the two tracker entries because their strings are
 * count-formatted and a legend has no message to count. Four is the example
 * Rokas used verbatim ("Tracking blocked (4)"), and it is above the `_one`
 * threshold so the plural form is what gets shown.
 *
 * `shot` is the basename under `src/assets/safety/<locale>/`; two pairs share a
 * screenshot because one capture shows both severities of the same alert.
 * Three of the four already existed and are reused rather than re-shot:
 * `link-safety-modal` is the "Dangerous Link Detected" dialog and
 * `premium-tracker-blocking` is the blocking screen with its before/after
 * panels. The old `reply-to-mismatch` capture is deliberately NOT reused — it
 * shows the warning glyph but never opens the dialog that explains it, which is
 * the half a legend needs.
 * `blurbKey` for the link pair is new — those two explanations were hardcoded
 * English inside `SecuritySettings.jsx` and rendered untranslated in the other
 * eight locales.
 */
export const SAFETY_ALERTS = Object.freeze([
  {
    id: 'link-dangerous',
    icon: AlertTriangle,
    tone: 'danger',
    titleKey: 'alert.link.dangerousLinksDetected',
    blurbKey: 'safety.link.dangerous.blurb',
    shot: 'link-safety-modal',
  },
  {
    id: 'link-suspicious',
    icon: AlertTriangle,
    tone: 'warning',
    titleKey: 'alert.link.suspiciousLinksDetected',
    blurbKey: 'safety.link.suspicious.blurb',
    shot: 'link-safety-modal',
  },
  {
    id: 'sender-impersonation',
    icon: ShieldAlert,
    tone: 'danger',
    titleKey: 'alert.sender.senderImpersonationDetected',
    blurbKey: 'alert.sender.senderSDisplayNameShows',
    shot: 'safety-sender-impersonation',
  },
  {
    id: 'sender-suspicious-name',
    icon: ShieldAlert,
    tone: 'warning',
    titleKey: 'alert.sender.suspiciousSenderName',
    blurbKey: 'alert.sender.senderSDisplayNameLooks',
    shot: 'safety-sender-impersonation',
  },
  {
    id: 'reply-to-mismatch',
    icon: CornerUpLeft,
    tone: 'warning',
    titleKey: 'alert.replyTo.domainMismatch',
    blurbKey: 'alert.replyTo.repliesMessageWouldGoDifferent',
    shot: 'safety-reply-to-modal',
  },
  {
    id: 'tracker-blocked',
    icon: EyeOff,
    tone: 'ok',
    titleKey: 'alert.tracker.trackingBlocked',
    blurbKey: 'alert.tracker.removed',
    count: 4,
    shot: 'premium-tracker-blocking',
  },
  {
    id: 'tracker-loaded',
    icon: Eye,
    tone: 'warning',
    titleKey: 'alert.tracker.emailTracks',
    blurbKey: 'alert.tracker.loaded',
    count: 4,
    shot: 'premium-tracker-blocking',
  },
]);

/** Colour per tone. Kept here so the legend and the icons cannot disagree. */
export const TONE_CLASS = Object.freeze({
  danger: 'text-mail-danger',
  warning: 'text-mail-warning',
  ok: 'text-mail-text-muted',
});
