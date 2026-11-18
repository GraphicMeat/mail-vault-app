// What a settings view needs from its app, without importing either app: the translator, the
// language, and the date formatters the previews draw with. Desktop containers provide them from
// src/i18n and utils/dateFormat; the phone's from src/mobile/i18n.js and src/mobile/format.js.
// A view never imports a store, a service, src/i18n/index.js or a Tauri module
// (views/__tests__/viewsPurity.test.js): it is rendered by both apps.
//
// The default is English with plain Intl formatting, so a view renders bare in a test.
import React, { createContext, useContext } from 'react';
import en from '../../../i18n/locales/en.json';
import { translate } from '../../../i18n/core.js';

const english = (key, vars) => translate(en, en, 'en', key, vars);
const DEFAULT = Object.freeze({
  t: english,
  locale: 'en',
  formatTime: (date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date),
  formatDateOnly: (date) => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date),
});

const ViewContext = createContext(DEFAULT);

/**
 * Provides the app's `t`, `locale`, `formatTime(date)` and `formatDateOnly(date, opts)` to the
 * views under it. A container re-renders on a language or format change (its own hooks), and the
 * value is rebuilt each render, so every view under it follows.
 */
export function SettingsViewProvider({ t, locale, formatTime, formatDateOnly, children }) {
  const value = {
    t: t || DEFAULT.t,
    locale: locale || DEFAULT.locale,
    formatTime: formatTime || DEFAULT.formatTime,
    formatDateOnly: formatDateOnly || DEFAULT.formatDateOnly,
  };
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

/** The translator of the app rendering this view. */
export const useViewT = () => useContext(ViewContext).t;
/** The whole context: `{ t, locale, formatTime, formatDateOnly }`. */
export const useViewEnv = () => useContext(ViewContext);
