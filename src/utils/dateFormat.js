import { useSettingsStore } from '../stores/settingsStore';
import { getLocale, t as tr } from '../i18n/index.js';
import { DATE_PRESETS, formatPattern, intlLocaleFor, formatTimeOf, formatEmailDateWith } from './emailDateCore.js';

// The store-free logic lives in emailDateCore.js (shared with the mobile shell); this module
// feeds it the settings store and the active app language.
const _fmt = (date, pattern) => formatPattern(date, pattern, getLocale());
const _locale = () => intlLocaleFor(getLocale());

/** The same locale every formatter here uses, for a component formatting its own. */
export const intlLocale = () => _locale();

/** Intl `hour12` for a timeFormat setting; undefined lets the locale decide ('auto'). */
export const hour12For = (timeFormat) => (timeFormat === '12h' ? true : timeFormat === '24h' ? false : undefined);

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
  return formatTimeOf(date, { timeFormat, appLocale: getLocale() });
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
    try { datePart = _fmt(date, customDateFormat); } catch { datePart = _fmt(date, 'MMM d, yyyy'); }
  } else if (dateFormat !== 'auto' && DATE_PRESETS[dateFormat]) {
    datePart = _fmt(date, DATE_PRESETS[dateFormat].withYear);
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
    try { return _fmt(date, customDateFormat); } catch { return _fmt(date, 'MMM d, yyyy'); }
  }

  if (dateFormat !== 'auto' && DATE_PRESETS[dateFormat]) {
    return _fmt(date, showYear ? DATE_PRESETS[dateFormat].withYear : DATE_PRESETS[dateFormat].withoutYear);
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
    try { return _fmt(date, customDateFormat); } catch { return _fmt(date, 'MMMM d, yyyy'); }
  }

  if (dateFormat !== 'auto' && DATE_PRESETS[dateFormat]) {
    return _fmt(date, DATE_PRESETS[dateFormat].withYear);
  }

  return new Intl.DateTimeFormat(_locale(), { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

/** Cached "March 2021" formatter in the app locale (one per locale). */
const _monthYearFmt = new Map();
export function monthYearFormatter() {
  const loc = _locale();
  let fmt = _monthYearFmt.get(loc);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' });
    _monthYearFmt.set(loc, fmt);
  }
  return fmt;
}

/** "March 2021" for month `m` (1-12) of year `y`. */
export function formatMonthYear(y, m) {
  return monthYearFormatter().format(new Date(y, m - 1, 1));
}

export function formatEmailDate(dateStr) {
  const { dateFormat, customDateFormat, timeFormat } = useSettingsStore.getState();
  return formatEmailDateWith(dateStr, { dateFormat, customDateFormat, timeFormat, appLocale: getLocale(), translate: tr });
}

/**
 * Short weekday name in the app's language. The chat list asked
 * `toLocaleDateString(undefined, …)` for this, which is the OPERATING SYSTEM's
 * language — so an app set to German still said "Mon" on a US Mac.
 */
export function formatWeekdayShort(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(_locale(), { weekday: 'short' }).format(date);
}
