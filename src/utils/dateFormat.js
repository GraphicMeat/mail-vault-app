import { format, isToday, isYesterday, isThisWeek } from 'date-fns';
import { useSettingsStore } from '../stores/settingsStore';

const DATE_PRESETS = {
  'MM/dd/yyyy': { withYear: 'MM/dd/yyyy', withoutYear: 'MM/dd' },
  'dd/MM/yyyy': { withYear: 'dd/MM/yyyy', withoutYear: 'dd/MM' },
  'yyyy-MM-dd': { withYear: 'yyyy-MM-dd', withoutYear: 'MM-dd' },
  'dd MMM yyyy': { withYear: 'dd MMM yyyy', withoutYear: 'dd MMM' },
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
  return new Intl.DateTimeFormat(navigator.language, {
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
    datePart = new Intl.DateTimeFormat(navigator.language, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  return `${datePart}, ${formatTime(date)}`;
}

export function formatEmailDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const { dateFormat, customDateFormat } = useSettingsStore.getState();

  if (isToday(date)) return formatTime(date);
  if (isYesterday(date)) return 'Yesterday';
  if (isThisWeek(date)) return format(date, 'EEEE');

  const isPreviousYear = date.getFullYear() !== new Date().getFullYear();

  if (dateFormat === 'auto' || !dateFormat) {
    const options = isPreviousYear
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' };
    return new Intl.DateTimeFormat(navigator.language, options).format(date);
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
