import { usePrivacyStore } from '../stores/privacyStore';
import { useMailStore } from '../stores/mailStore';
import { isCaptureTarget } from '../utils/captureTarget';

/**
 * True while a social capture wants this message's sender-details popover open
 * (privacyStore.captureSenderDetails names the message). The header that owns
 * the message renders the real popover inline for the shot.
 */
export function useCaptureSenderDetails(email) {
  const target = usePrivacyStore(s => s.captureSenderDetails);
  return !!target && isCaptureTarget(email, target, useMailStore.getState());
}
