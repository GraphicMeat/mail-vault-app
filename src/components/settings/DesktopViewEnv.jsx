// Desktop's side of views/viewContext.jsx: its translator and language (src/i18n, re-rendering on
// a language change), its date and size formatters (utils/dateFormat, which read the settings
// store; utils/formatBytes) and the privacy mask (privacy/Private, hooks/usePrivacy).
// Every desktop container renders its view inside this.
import React from 'react';
import { getLocale, useT } from '../../i18n';
import { formatDateOnly, formatDateTime, formatTime } from '../../utils/dateFormat';
import { formatBytes } from '../../utils/formatBytes';
import { Private } from '../privacy/Private';
import { usePrivateAttr, usePrivateInputClass } from '../../hooks/usePrivacy';
import { SettingsViewProvider } from './views/viewContext';

export function DesktopViewEnv({ children }) {
  const t = useT();
  const privateAttr = usePrivateAttr();
  const privateInputClass = usePrivateInputClass();
  return <SettingsViewProvider t={t} locale={getLocale()} formatTime={formatTime} formatDateOnly={formatDateOnly}
    formatDateTime={formatDateTime} formatBytes={formatBytes} Private={Private} privateAttr={privateAttr}
    privateInputClass={privateInputClass}>
    {children}
  </SettingsViewProvider>;
}

/** `View` inside the desktop context: an export that keeps working where it is used bare. */
export const withDesktopEnv = View => function DesktopView(props) {
  return <DesktopViewEnv><View {...props} /></DesktopViewEnv>;
};
