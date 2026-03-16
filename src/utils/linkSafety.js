/**
 * Link Safety Scanner
 * Detects suspicious link mismatches in email HTML.
 * Uses DOMParser for safe, correct HTML parsing.
 */

// Known legitimate URL shorteners — exempt from YELLOW alerts
const SHORTENER_ALLOWLIST = new Set([
  'bit.ly', 't.co', 'goo.gl', 'tinyurl.com', 'lnkd.in',
  'ow.ly', 'buff.ly', 'is.gd', 'rb.gy', 'cutt.ly',
]);

// Patterns indicating URL redirect/tracking in query params
const REDIRECT_PARAMS = /[?&](url|redirect|goto|target|link|dest|destination)=/i;

// Cache scan results by email UID to avoid re-scanning
const _scanCache = new Map();
const MAX_CACHE = 500;

/**
 * Extract domain from a URL string. Returns lowercase domain or null.
 */
function extractDomain(urlStr) {
  try {
    const url = new URL(urlStr.startsWith('www.') ? `https://${urlStr}` : urlStr);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check if text content looks like a URL
 */
function looksLikeUrl(text) {
  const trimmed = text.trim();
  return trimmed.includes('://') || trimmed.startsWith('www.');
}

/**
 * Scan email HTML for suspicious links.
 * Returns { alerts, modifiedHtml, maxAlertLevel }.
 */
export function scanEmailLinks(html, uid) {
  if (!html) return { alerts: [], modifiedHtml: html, maxAlertLevel: null };

  // Check cache
  if (uid && _scanCache.has(uid)) return _scanCache.get(uid);

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const links = doc.querySelectorAll('a[href]');
  const alerts = [];
  let maxAlertLevel = null;

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const text = link.textContent?.trim() || '';

    // Skip safe link types
    if (!href || href.startsWith('#') || href.startsWith('cid:') ||
        href.startsWith('mailto:') || href.startsWith('tel:') ||
        (!href.includes('://') && !href.startsWith('javascript:') && !href.startsWith('data:'))) {
      continue;
    }

    // Set title on ALL links so hovering shows the actual destination
    if (!link.getAttribute('title')) {
      link.setAttribute('title', href);
    }

    let level = null;
    let reason = '';
    const actualDomain = extractDomain(href);
    const textDomain = looksLikeUrl(text) ? extractDomain(text) : null;

    // RED: javascript: or data: schemes
    if (href.startsWith('javascript:') || href.startsWith('data:')) {
      level = 'red';
      reason = `Link uses dangerous ${href.split(':')[0]}: scheme`;
    }
    // RED: Text looks like URL but domain doesn't match href
    else if (textDomain && actualDomain && textDomain !== actualDomain) {
      level = 'red';
      reason = `Link text shows ${textDomain} but goes to ${actualDomain}`;
    }
    // YELLOW: Redirect/tracking params in URL (skip shortener allowlist)
    else if (actualDomain && !SHORTENER_ALLOWLIST.has(actualDomain) && REDIRECT_PARAMS.test(href)) {
      const match = href.match(/[?&](?:url|redirect|goto|target|link|dest|destination)=([^&]+)/i);
      if (match) {
        try {
          const redirectUrl = decodeURIComponent(match[1]);
          const redirectDomain = extractDomain(redirectUrl);
          if (redirectDomain && redirectDomain !== actualDomain) {
            level = 'yellow';
            reason = `Link redirects through ${actualDomain} to ${redirectDomain}`;
          }
        } catch { /* ignore decode errors */ }
      }
    }

    if (level) {
      alerts.push({
        level,
        textContent: text,
        textDomain: textDomain || null,
        actualUrl: href,
        actualDomain,
        reason,
      });

      link.setAttribute('data-link-alert', level);
      link.setAttribute('title', reason);

      if (!maxAlertLevel || level === 'red') maxAlertLevel = level;
    }
  }

  // Inject CSS for warning indicators if any alerts found
  if (alerts.length > 0) {
    const style = doc.createElement('style');
    style.textContent = `
      a[data-link-alert]::before {
        display: inline;
        margin-right: 3px;
        font-size: 0.9em;
        cursor: help;
      }
      a[data-link-alert="red"]::before {
        content: "\\26A0";
        color: #ef4444;
      }
      a[data-link-alert="yellow"]::before {
        content: "\\26A0";
        color: #f59e0b;
      }
      a[data-link-alert="red"] {
        outline: 2px solid rgba(239, 68, 68, 0.3);
        outline-offset: 2px;
        border-radius: 2px;
      }
      a[data-link-alert="yellow"] {
        outline: 2px solid rgba(245, 158, 11, 0.3);
        outline-offset: 2px;
        border-radius: 2px;
      }
    `;
    doc.head.appendChild(style);
  }

  // Serialize back to HTML
  const modifiedHtml = new XMLSerializer().serializeToString(doc);
  const result = { alerts, modifiedHtml, maxAlertLevel };

  // Cache result
  if (uid) {
    if (_scanCache.size > MAX_CACHE) _scanCache.clear();
    _scanCache.set(uid, result);
  }

  return result;
}

/**
 * Check a single link element for alert status.
 * Used by click handlers to determine if modal should show.
 */
export function checkLinkAlert(linkElement) {
  const level = linkElement.getAttribute('data-link-alert');
  if (!level) return null;
  return {
    level,
    textContent: linkElement.textContent?.trim() || '',
    actualUrl: linkElement.href,
    reason: linkElement.getAttribute('title') || '',
  };
}

/**
 * Get the highest link alert level from an array of emails.
 * RED > YELLOW > null. Used by topic/thread rows to show aggregate alert.
 */
/**
 * Get cached scan alerts for an email UID. Returns alerts array or null.
 */
export function getCachedAlerts(uid) {
  if (!uid || !_scanCache.has(uid)) return null;
  return _scanCache.get(uid).alerts;
}

/**
 * Collect all cached alerts from an array of emails.
 */
export function getAlertsForEmails(emails) {
  if (!emails) return null;
  const all = [];
  for (const e of emails) {
    const cached = getCachedAlerts(e.uid);
    if (cached) all.push(...cached);
  }
  return all.length > 0 ? all : null;
}

export function getLinkAlertLevel(emails) {
  if (!emails || emails.length === 0) return null;
  let max = null;
  for (const e of emails) {
    if (e._linkAlert === 'red') return 'red';
    if (e._linkAlert === 'yellow') max = 'yellow';
  }
  return max;
}
