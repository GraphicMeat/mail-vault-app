import React from 'react';
import { openInBrowser } from '../../services/billingApi';

/**
 * A link to a page outside the app. The app window must never navigate away,
 * so the click opens the system browser (the Tauri shell, or a new tab on the
 * web) and the href stays only for hover, copy and assistive tech.
 */
export function ExternalLink({ href, children, onClick, ...rest }) {
  return (
    <a
      {...rest}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
        openInBrowser(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}
