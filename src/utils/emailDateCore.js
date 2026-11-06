// The pure half of the list's date column: no settings store, no locale state. The caller passes
// the date settings, the app language, a `translate(key)` for the one label, and `now`. Desktop
// `src/utils/dateFormat.js` supplies them from the settings store and the active catalog; the
// mobile shell (`src/mobile/format.js`) supplies its defaults.
import { format, isSameDay, isSameWeek, subDays } from 'date-fns';
import { es, fr, it as itIT, de, ptBR, ja, ko, zhCN } from 'date-fns/locale';

/**
 * date-fns writes month names and AM/PM in English unless it is handed a locale object. The
 * `EEEE` weekday branch was moved to Intl, but `MMM`, `MMMM` and the `a` of `h:mm a` still came
 * out English from every preset and from any custom pattern the user typed. `undefined` is the
 * right value for `en`: date-fns falls back to its own en-US default.
 */
const DFNS = { es, fr, it: itIT, de, 'pt-BR': ptBR, ja, ko, 'zh-Hans': zhCN };

export const DATE_PRESETS = {
  'MM/dd/yyyy': { withYear: 'MM/dd/yyyy', withoutYear: 'MM/dd' },
  'dd/MM/yyyy': { withYear: 'dd/MM/yyyy', withoutYear: 'dd/MM' },
  'yyyy-MM-dd': { withYear: 'yyyy-MM-dd', withoutYear: 'MM-dd' },
  'dd MMM yyyy': { withYear: 'dd MMM yyyy', withoutYear: 'dd MMM' },
};

/** A date-fns pattern in the app language (`appLocale` is one of the nine app codes). */
export function formatPattern(date, pattern, appLocale) {
  return format(date, pattern, { locale: DFNS[appLocale] });
}

/**
 * Locale for Intl, or undefined to let the runtime pick its default.
 *
 * The app's chosen language wins: someone reading MailVault in German wants German dates. It is
 * always one of our nine hardcoded codes, so it needs no validation. Only the `navigator`
 * fallback, which applies while the language is still the default `en`, can carry junk.
 *
 * `navigator` is a browser global. Node exposes it from 21 onwards, so touching it directly
 * passed on a new local Node and threw `navigator is not defined` on CI's Node 20.
 */
export function intlLocaleFor(appLocale) {
  if (appLocale && appLocale !== 'en') return appLocale;

  const lang = typeof navigator !== 'undefined' ? navigator.language : undefined;
  if (!lang) return undefined;
  // WebKitGTK reports the raw POSIX locale ("C" on systems without LANG set), which is not a
  // BCP 47 tag and makes every Intl constructor throw RangeError, crashing the app into the error
  // boundary. Fall back to the runtime default.
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([lang]).length ? lang : undefined;
  } catch {
    return undefined;
  }
}

/** Time of day for a valid Date, per the timeFormat setting ('auto' | '12h' | '24h'). */
export function formatTimeOf(date, { timeFormat, appLocale }) {
  // date-fns path for explicit 12h/24h (avoids locale ambiguity)
  if (timeFormat === '24h') return formatPattern(date, 'HH:mm', appLocale);
  if (timeFormat === '12h') return formatPattern(date, 'h:mm a', appLocale);

  // 'auto': use Intl with the browser locale
  return new Intl.DateTimeFormat(intlLocaleFor(appLocale), {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * The list's date column for `dateInput`: time today, "Yesterday", the weekday this week, then a
 * date per the dateFormat setting. `translate` turns the "Yesterday" key into text; `now` is the
 * reference instant (the current time unless a caller pins it).
 */
export function formatEmailDateWith(dateInput, { dateFormat, customDateFormat, timeFormat, appLocale, translate, now = new Date() }) {
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return '';
  const fmt = (pattern) => formatPattern(date, pattern, appLocale);

  if (isSameDay(date, now)) return formatTimeOf(date, { timeFormat, appLocale });
  if (isSameDay(date, subDays(now, 1))) return translate('bulk.ops.yesterday');
  // This used the date-fns day-name pattern with no locale argument, which is always English:
  // an English weekday in the middle of a translated list.
  if (isSameWeek(date, now)) return new Intl.DateTimeFormat(intlLocaleFor(appLocale), { weekday: 'long' }).format(date);

  const isPreviousYear = date.getFullYear() !== now.getFullYear();

  if (dateFormat === 'auto' || !dateFormat) {
    const options = isPreviousYear
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' };
    return new Intl.DateTimeFormat(intlLocaleFor(appLocale), options).format(date);
  }

  if (dateFormat === 'custom' && customDateFormat) {
    try {
      return fmt(customDateFormat);
    } catch {
      return fmt('MMM d, yyyy');
    }
  }

  // Preset formats
  const preset = DATE_PRESETS[dateFormat];
  if (preset) {
    return fmt(isPreviousYear ? preset.withYear : preset.withoutYear);
  }

  // Unknown format: fallback
  return fmt(isPreviousYear ? 'MMM d, yyyy' : 'MMM d');
}
