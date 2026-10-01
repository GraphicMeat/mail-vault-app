import { t } from '../../i18n/index.js';
import { usePrivacyStore } from '../../stores/privacyStore';
import { useMailStore } from '../../stores/mailStore';

/**
 * "Open in window" while privacy mode is on. The window loads from file:// and
 * is out of reach of the masking pass, so the message stays in the pane and a
 * notice says why. Returns true when it refused.
 */
export function refuseWindowUnderPrivacy() {
  if (!usePrivacyStore.getState().enabled) return false;
  const notice = t('privacy.windowBlocked');
  useMailStore.setState({ error: notice, errorType: 'warning', errorTypeFor: notice });
  return true;
}
