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

/** The viewer header's date: day and time in full, in the mobile language. */
export function formatFullDate(dateMs) {
  if (dateMs == null || !Number.isFinite(dateMs)) return '';
  return new Intl.DateTimeFormat(getMobileLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(dateMs);
}

const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];

/** An attachment size (1024-based), unit names from `Intl` in the mobile language. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < SIZE_UNITS.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = i === 0 || value >= 10 ? 0 : 1;
  return new Intl.NumberFormat(getMobileLocale(), {
    style: 'unit', unit: SIZE_UNITS[i], unitDisplay: 'short', maximumFractionDigits: digits,
  }).format(value);
}

/** A share of a download (0..1) as a whole percent in the mobile language. */
export function formatPercent(fraction) {
  const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return new Intl.NumberFormat(getMobileLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(value);
}
