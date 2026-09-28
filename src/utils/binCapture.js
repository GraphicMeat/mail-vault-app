import { t } from '../i18n/index.js';

// The daemon refuses a permanent (or local-only) delete it could not keep a
// deleted-mail bin copy of first, as `E_BIN_CAPTURE: <detail>`. The detail is
// for the logs; the user reads catalog copy.
const PREFIX = 'E_BIN_CAPTURE:';

export function binCaptureError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  if (typeof message !== 'string' || !message.startsWith(PREFIX)) return error;
  console.warn('[delete] refused, no copy could be kept first:', message);
  return new Error(t('errors.E_BIN_CAPTURE'));
}
