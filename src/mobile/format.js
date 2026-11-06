// The list's date column on mobile: the shared core (`src/utils/emailDateCore.js`) with mobile's
// defaults. Mobile has no date settings yet, so it uses desktop's defaults ('auto' date and time)
// and the mobile language picked at launch.
import { formatEmailDateWith } from '../utils/emailDateCore.js';
import { t, getMobileLocale } from './i18n.js';

export const MOBILE_DATE_SETTINGS = Object.freeze({ dateFormat: 'auto', customDateFormat: '', timeFormat: 'auto' });

/** `dateMs` from the engine; a missing value is an empty column, not 1 January 1970. */
export function formatEmailDate(dateMs, now = new Date()) {
  if (dateMs == null) return '';
  return formatEmailDateWith(dateMs, { ...MOBILE_DATE_SETTINGS, appLocale: getMobileLocale(), translate: t, now });
}
