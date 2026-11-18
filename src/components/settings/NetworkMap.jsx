import React from 'react';
import { getLocale } from '../../i18n/index.js';
import { openInBrowser } from '../../services/billingApi';
import { DesktopViewEnv } from './DesktopViewEnv';
import { NetworkMapView, countryName as countryNameIn } from './views/NetworkMapView';

// Network Activity's map: the shared view (views/NetworkMapView.jsx) in the desktop context,
// opening its attribution in the browser.

export const countryName = code => countryNameIn(code, getLocale());

export function NetworkMap(props) {
  return <DesktopViewEnv><NetworkMapView {...props} onOpenLink={url => openInBrowser(url).catch(() => {})} /></DesktopViewEnv>;
}
