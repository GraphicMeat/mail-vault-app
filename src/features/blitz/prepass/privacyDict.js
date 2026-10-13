import { useEffect, useMemo, useState } from 'react';
import { usePrivacyActive } from '../../../hooks/usePrivacy';
import { usePrivacyDictStore, getPrivacyDictionary, isPrivacyDictionaryReady, collectPrivacyNames } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary, unionDictionaries } from '../../../utils/privacy/piiDetector';

// The privacy inputs for runPrepass, mirroring useBodyPrivacy: the global
// dictionary plus this message's own parties, held up to readyTimeoutMs while
// the contacts index loads. hold = draw nothing yet. Option-hold peek flips
// usePrivacyActive app-wide, so the body re-runs unmasked while held.
export function usePrivacyDict({ message = null, readyTimeoutMs = 3000 } = {}) {
  const active = usePrivacyActive();
  const version = usePrivacyDictStore(s => s.version);
  // Keyed by the names, not the object: callers often pass a fresh merge per render.
  const ownKey = useMemo(() => (message ? collectPrivacyNames({ emails: [message] }).join('\u0000') : ''), [message]);
  const ownDict = useMemo(() => (ownKey ? buildNameDictionary({ names: ownKey.split('\u0000') }) : null), [ownKey]);
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    setWaitedOut(false);
    if (!active) return undefined;
    const t = setTimeout(() => setWaitedOut(true), readyTimeoutMs);
    return () => clearTimeout(t);
  }, [active, readyTimeoutMs]);
  const hold = active && !waitedOut && !isPrivacyDictionaryReady();
  const dict = useMemo(() => (active ? unionDictionaries(getPrivacyDictionary(), ownDict) : null),
    [active, ownDict, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({ active, dict, hold }), [active, dict, hold]);
}
