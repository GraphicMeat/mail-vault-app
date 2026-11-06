// The desktop list's date column (`formatEmailDate` in src/utils/dateFormat.js) at its default
// settings (`dateFormat: 'auto'`, `timeFormat: 'auto'`, language English). The desktop module
// reads the desktop settings store, which the mobile bundle must not reach; mobile has no date
// settings yet, so only the default branch exists here. A parity test compares the two.
import { isToday, isYesterday, isThisWeek } from 'date-fns';
import { t } from './i18n.js';

// Same rule as desktop `_locale()` while the app language is English: the runtime's language if
// Intl accepts it, else the runtime default.
function locale() {
  const lang = typeof navigator !== 'undefined' ? navigator.language : undefined;
  if (!lang) return undefined;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([lang]).length ? lang : undefined;
  } catch {
    return undefined;
  }
}

// Formatters are costly to build and a scrolling list asks for hundreds of dates.
const cache = new Map();
function fmt(options) {
  const key = JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale(), options);
    cache.set(key, f);
  }
  return f;
}

export function formatEmailDate(dateMs) {
  if (dateMs == null) return '';
  const date = new Date(dateMs);
  if (isNaN(date.getTime())) return '';
  if (isToday(date)) return fmt({ hour: 'numeric', minute: '2-digit' }).format(date);
  if (isYesterday(date)) return t('bulk.ops.yesterday');
  if (isThisWeek(date)) return fmt({ weekday: 'long' }).format(date);
  const isPreviousYear = date.getFullYear() !== new Date().getFullYear();
  return fmt(isPreviousYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }).format(date);
}
