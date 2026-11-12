import { useCallback, useState } from 'react';
import { useSettingsStore, isTrackerBlockingActive } from '../stores/settingsStore';
import { useBodyScan } from '../services/bodyScan';
import { activateEmailLink, openExternalUrl } from '../utils/emailLinkActivation';
import { openMailtoCompose } from '../utils/mailto';

const noCompose = () => {};

/**
 * One reader's body scan and link handling: the reading pane, a thread
 * message, a chat bubble and the full view each draw a message body, and each
 * must run the same link rule (utils/emailLinkActivation) under the same
 * settings. Returns:
 * - `scan`: the daemon's scan of `body` (useBodyScan), with flagged links
 *   marked whenever link safety is on;
 * - `onLink(link)`: what the alternative renderer calls with a clicked link;
 * - `onFrameClick(event)`: the iframe document's click listener;
 * - `linkSafetyModal`: the props for this reader's <LinkSafetyModal>.
 * `composeDisabled` (a read-only copy in the compose pane) makes a mailto:
 * link do nothing instead of opening a second compose.
 */
export function useEmailLinks(body, { key = null, accountId, composeDisabled = false } = {}) {
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  // Effective state, not the raw flag: a stale `true` left behind by a lapsed
  // subscription must not render as protection. See isTrackerBlockingActive.
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  const scan = useBodyScan(body, { key, blocking: trackerBlocking, links: linkSafetyEnabled });
  const [alert, setAlert] = useState(null);

  const onLink = useCallback(link => activateEmailLink(link, {
    accountId, linkSafetyEnabled, linkSafetyClickConfirm,
    openMailtoCompose: composeDisabled ? noCompose : openMailtoCompose,
    setLinkSafetyAlert: setAlert, openUrl: openExternalUrl,
  }), [accountId, linkSafetyEnabled, linkSafetyClickConfirm, composeDisabled]);

  const onFrameClick = useCallback((event) => {
    const link = event.target.closest?.('a');
    if (!link || !link.href) return;
    const result = onLink({ href: link.href, alert: link.getAttribute('data-link-alert'), title: link.getAttribute('title'), text: link.textContent });
    if (result !== 'ignored') { event.preventDefault(); event.stopPropagation(); }
  }, [onLink]);

  const linkSafetyModal = {
    alert,
    onCancel: () => setAlert(null),
    onOpenAnyway: () => {
      const url = alert.actualUrl;
      setAlert(null);
      openExternalUrl(url);
    },
  };

  return { scan, trackerBlocking, onLink, onFrameClick, linkSafetyModal };
}
