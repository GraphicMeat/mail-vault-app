import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { parseAuthResults } from '../../utils/senderCheck';
import { daemonCall } from '../../services/daemonClient';

// Logo lookups for this session, so a thread or a list asks once per message.
// Keyed by domain AND the message's Authentication-Results: the daemon's check
// that the DMARC pass is for this From domain is per message, and a domain-only
// key would hand a cached logo to a message that never passed it. A "no logo"
// answer is kept too: a virtualized list remounts every row it scrolls back to,
// and most senders have none. A failed call is not an answer and is dropped.
const bimiLookups = new Map();

export function _resetBimiLookups() { bimiLookups.clear(); }

/**
 * The sender's BIMI logo: beside the SPF/DKIM/DMARC shield in the reader, after
 * the sender's name on a list row. Only asked for when the receiving server
 * says the message passed DMARC; the daemon (`bimi_logo`) checks that the pass
 * is for this From domain and that the domain's policy enforces, and returns an
 * SVG data URI. An `<img>` never runs an SVG's scripts.
 */
export function BimiLogo({ email, size = 20 }) {
  const t = useT();
  const domain = (email?.from?.address || '').split('@')[1]?.trim().toLowerCase() || '';
  const auth = email?.authenticationResults || '';
  const pass = !!domain && parseAuthResults(auth).dmarc === 'pass';
  const [logo, setLogo] = useState(null);
  useEffect(() => {
    setLogo(null);
    if (!pass) return undefined;
    let live = true;
    const key = `${domain}\n${auth}`;
    if (!bimiLookups.has(key)) {
      const lookup = daemonCall('bimi_logo', { domain, authenticationResults: auth })
        .then(result => result?.logo || null, () => { bimiLookups.delete(key); return null; });
      bimiLookups.set(key, lookup);
    }
    bimiLookups.get(key).then(found => { if (live) setLogo(found); });
    return () => { live = false; };
  }, [domain, auth, pass]);
  if (!logo || !logo.startsWith('data:image/svg+xml;base64,')) return null;
  return <img src={logo} alt={t('bimi.logoAlt', { domain })} data-testid="bimi-logo"
    style={{ width: size, height: size }} className="rounded flex-shrink-0 object-contain" />;
}
