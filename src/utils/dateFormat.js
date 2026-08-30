import { format, isToday, isYesterday, isThisWeek } from 'date-fns';
import { useSettingsStore } from '../stores/settingsStore';
import { getLocale, t as tr } from '../i18n/index.js';

const DATE_PRESETS = {
  'MM/dd/yyyy': { withYear: 'MM/dd/yyyy', withoutYear: 'MM/dd' },
  'dd/MM/yyyy': { withYear: 'dd/MM/yyyy', withoutYear: 'dd/MM' },
  'yyyy-MM-dd': { withYear: 'yyyy-MM-dd', withoutYear: 'MM-dd' },
  'dd MMM yyyy': { withYear: 'dd MMM yyyy', withoutYear: 'dd MMM' },
};

/**
 * Locale for Intl, or undefined to let the runtime pick its default.
 *
 * The app's chosen language wins: someone reading MailVault in German wants
 * German dates. It is always one of our nine hardcoded codes, so it needs no
 * validation. Only the `navigator` fallback — which applies while the language
 * is still the default `en` — can carry junk.
 *
 * `navigator` is a browser global. Node exposes it from 21 onwards, so touching
 * it directly passed on a new local Node and threw `navigator is not defined`
 * on CI's Node 20.
 */
const _locale = () => {
  const chosen = getLocale();
  if (chosen && chosen !== 'en') return chosen;

  const lang = typeof navigator !== 'undefined' ? navigator.language : undefined;
  if (!lang) return undefined;
  // WebKitGTK reports the raw POSIX locale — "C" on systems without LANG set —
  // which is not a BCP 47 tag and makes every Intl constructor throw RangeError,
  // crashing the app into the error boundary. Fall back to the runtime default.
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([lang]).length ? lang : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Build Intl.DateTimeFormat options for time based on the timeFormat setting.
 * Returns { hour12 } or {} (auto = let the locale decide).
 */
function _timeFormatOptions() {
  const { timeFormat } = useSettingsStore.getState();
  if (timeFormat === '12h') return { hour12: true };
  if (timeFormat === '24h') return { hour12: false };
  return {}; // 'auto' — locale default
}

/**
 * Format a time-only string for the given date, respecting the timeFormat setting.
 * Used across email list (today's emails), chat bubbles, and detail views.
 */
export function formatTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '';

  const { timeFormat } = useSettingsStore.getState();

  // date-fns path for explicit 12h/24h (avoids locale ambiguity)
  if (timeFormat === '24h') return format(date, 'HH:mm');
  if (timeFormat === '12h') return format(date, 'h:mm a');

  // 'auto' — use Intl with the browser locale
  return new Intl.DateTimeFormat(_locale(), {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Format a full date + time string, respecting both dateFormat and timeFormat settings.
 * Used in email detail views, compose headers, etc.
 */
export function formatDateTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '';

  const { dateFormat, customDateFormat } = useSettingsStore.getState();

  let datePart;
  if (dateFormat === 'custom' && customDateFormat) {
    try { datePart = format(date, customDateFormat); } catch { datePart = format(date, 'MMM d, yyyy'); }
  } else if (dateFormat !== 'auto' && DATE_PRESETS[dateFormat]) {
    datePart = format(date, DATE_PRESETS[dateFormat].withYear);
  } else {
    datePart = new Intl.DateTimeFormat(_locale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  return `${datePart}, ${formatTime(date)}`;
}

/**
 * Format a date-only string (no time), respecting the dateFormat setting.
 * @param {Date|string|number} dateInput
 * @param {object} [opts]
 * @param {boolean} [opts.alwaysShowYear=false] — force year even for current-year dates
 */
export function formatDateOnly(dateInput, { alwaysShowYear = false } = {}) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '';

  const { dateFormat, customDateFormat } = useSettingsStore.getState();
  const isPreviousYear = date.getFullYear() !== new Date().getFullYear();
  const showYear = alwaysShowYear || isPreviousYear;

  if (dateFormat === 'custom' && customDateFormat) {
    try { return format(date, customDateFormat); } catch { return format(date, 'MMM d, yyyy'); }
  }

  if (dateFormat !== 'auto' && DATE_PRESETS[dateFormat]) {
    return format(date, showYear ? DATE_PRESETS[dateFormat].withYear : DATE_PRESETS[dateFormat].withoutYear);
  }

  // 'auto' — locale default
  const options = showYear
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(_locale(), options).format(date);
}

/**
 * Format a date-only string with long month (e.g. "January 5, 2026").
 * Respects dateFormat setting for preset/custom; uses long month only in auto mode.
 */
export function formatDateLong(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '';

  const { dateFormat, customDateFormat } = useSettingsStore.getState();

  if (dateFormat === 'custom' && customDateFormat) {
    try { return format(date, customDateFormat); } catch { return format(date, 'MMMM d, yyyy'); }
  }

  if (dateFormat !== 'auto' && DATE_PRESETS[dateFormat]) {
    return format(date, DATE_PRESETS[dateFormat].withYear);
  }

  return new Intl.DateTimeFormat(_locale(), { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

export function formatEmailDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const { dateFormat, customDateFormat } = useSettingsStore.getState();

  if (isToday(date)) return formatTime(date);
  if (isYesterday(date)) return tr('bulk.ops.yesterday');
  // This used the date-fns day-name pattern with no locale argument, which is
  // always English — an English weekday in the middle of a translated list.
  if (isThisWeek(date)) return new Intl.DateTimeFormat(_locale(), { weekday: 'long' }).format(date);

  const isPreviousYear = date.getFullYear() !== new Date().getFullYear();

  if (dateFormat === 'auto' || !dateFormat) {
    const options = isPreviousYear
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' };
    return new Intl.DateTimeFormat(_locale(), options).format(date);
  }

  if (dateFormat === 'custom' && customDateFormat) {
    try {
      return format(date, customDateFormat);
    } catch {
      return format(date, 'MMM d, yyyy');
    }
  }

  // Preset formats
  const preset = DATE_PRESETS[dateFormat];
  if (preset) {
    return format(date, isPreviousYear ? preset.withYear : preset.withoutYear);
  }

  // Unknown format — fallback
  return format(date, isPreviousYear ? 'MMM d, yyyy' : 'MMM d');
}
