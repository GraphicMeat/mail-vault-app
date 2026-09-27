import { detectReplyToMismatch } from '../../utils/replyToCheck';
import { emailScopeKey } from './unifiedHelpers';

/**
 * The safety verdicts a list row wears: persisted link and tracker verdicts,
 * an impersonating display name, a Reply-To that leads elsewhere. One pass for
 * every list that shows rows, the folder list and a search's results alike: a
 * hit the list derivation never saw used to wear none of them, so the same
 * message had its shields in the folder and none in the results.
 *
 * Writes onto the rows it is given (they are freshly derived by the caller)
 * and never overwrites a verdict a row already carries.
 */
export function annotateRowAlerts(rows, mailState, settings) {
  // Keyed by `accountId-mailbox-uid`: a bare UID is unique inside one mailbox
  // only, so keying by it painted account A's red flag on every account's UID 41.
  const { linkAlerts, trackerAlerts, linkSafetyEnabled } = settings || {};
  const hasLinks = linkAlerts && Object.keys(linkAlerts).length > 0;
  // The tracker scan needs the body, which only exists once a message has been
  // opened, so the row reads the persisted summary rather than re-deriving it.
  const hasTrackers = trackerAlerts && Object.keys(trackerAlerts).length > 0;
  for (const e of rows) {
    if (hasLinks || hasTrackers) {
      const key = emailScopeKey(e, mailState);
      if (key) {
        if (hasLinks && !e._linkAlert && linkAlerts[key]) e._linkAlert = linkAlerts[key];
        if (hasTrackers && !e._trackerInfo && trackerAlerts[key]) e._trackerInfo = trackerAlerts[key];
      }
    }
    if (!linkSafetyEnabled) continue;

    const addr = (e.from?.address || '').toLowerCase();
    const addrDomain = addr.split('@')[1] || '';

    // Sender impersonation (display name looks like email/domain)
    if (e._senderAlert === undefined && addr) {
      const name = (e.from?.name || '').replace(/^["\\]+|["\\]+$/g, '').replace(/\\"/g, '"').trim();
      if (name) {
        const nameLower = name.toLowerCase();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name) && nameLower !== addr) {
          const nameDomain = nameLower.split('@')[1] || '';
          if (nameDomain !== addrDomain && !addrDomain.endsWith('.' + nameDomain) && !nameDomain.endsWith('.' + addrDomain)) {
            e._senderAlert = 'red';
          }
        }
        else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(nameLower)) {
          if (nameLower !== addrDomain && !addrDomain.endsWith('.' + nameLower) && !nameLower.endsWith('.' + addrDomain)) {
            e._senderAlert = 'yellow';
          }
        }
      }
    }

    // Reply-To domain mismatch: common phishing signal — legit bulk senders
    // usually route replies to the same domain (or a subdomain) they send from.
    if (e._replyToMismatch === undefined) {
      const mismatch = detectReplyToMismatch(e);
      if (mismatch) e._replyToMismatch = mismatch;
    }
  }
  return rows;
}
