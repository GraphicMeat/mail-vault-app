import { useEffect, useMemo, useState } from 'react';
import { usePrivacyActive } from '../../../hooks/usePrivacy';
import { usePrivacyDictStore, getPrivacyDictionary, isPrivacyDictionaryReady, collectPrivacyNames } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary, unionDictionaries } from '../../../utils/privacy/piiDetector';

// The privacy inputs for runPrepass, mirroring useBodyPrivacy: the global
// dictionary plus this message's own parties, held up to readyTimeoutMs while
// the contacts index loads. hold = draw nothing yet. Option-hold peek flips
// usePrivacyActive app-wide, so the body re-runs unmasked while held.
export function usePrivacyDict({ message = null, messageKey = null, readyTimeoutMs = 3000 } = {}) {
  const active = usePrivacyActive();
  const version = usePrivacyDictStore(s => s.version);
  // Keyed by the names, not the object: callers often pass a fresh merge per render.
  const ownKey = useMemo(() => (message ? collectPrivacyNames({ emails: [message] }).join('\u0000') : ''), [message]);
  const ownDict = useMemo(() => (ownKey ? buildNameDictionary({ names: ownKey.split('\u0000') }) : null), [ownKey]);
  // The hold is per message, like useBodyPrivacy's per-frame clock: the key that
  // was waited out is stored and compared in render, so the render a new message
  // arrives in is already held (an effect reset would leave one render unheld).
  const [waitedFor, setWaitedFor] = useState(null); // { key }
  useEffect(() => {
    if (!active) { setWaitedFor(null); return undefined; }
    const timer = setTimeout(() => setWaitedFor({ key: messageKey }), readyTimeoutMs);
    return () => clearTimeout(timer);
  }, [active, messageKey, readyTimeoutMs]);
  const waitedOut = waitedFor != null && waitedFor.key === messageKey;
  const hold = active && !waitedOut && !isPrivacyDictionaryReady();
  const dict = useMemo(() => (active ? unionDictionaries(getPrivacyDictionary(), ownDict) : null),
    [active, ownDict, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({ active, dict, hold }), [active, dict, hold]);
}
