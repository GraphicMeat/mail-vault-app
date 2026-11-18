// Desktop's side of views/viewContext.jsx: its translator and language (src/i18n, re-rendering on
// a language change) and its date formatters (utils/dateFormat, which read the settings store).
// Every desktop container renders its view inside this.
import React from 'react';
import { getLocale, useT } from '../../i18n';
import { formatDateOnly, formatTime } from '../../utils/dateFormat';
import { SettingsViewProvider } from './views/viewContext';

export function DesktopViewEnv({ children }) {
  const t = useT();
  return <SettingsViewProvider t={t} locale={getLocale()} formatTime={formatTime} formatDateOnly={formatDateOnly}>
    {children}
  </SettingsViewProvider>;
}

/** `View` inside the desktop context: an export that keeps working where it is used bare. */
export const withDesktopEnv = View => function DesktopView(props) {
  return <DesktopViewEnv><View {...props} /></DesktopViewEnv>;
};
