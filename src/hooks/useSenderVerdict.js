import { useEffect, useState } from 'react';
import { cachedVerdict, verdictKey, verifySender } from '../services/senderVerdict';

/**
 * The daemon's verdict on `email`'s sender (services/senderVerdict.js), or
 * null until it answers. An answer already in hand is returned at once, so a
 * reopened message or a popover opened from its badge paints in one pass.
 * Pass null to ask nothing.
 */
export function useSenderVerdict(email) {
  const key = email ? verdictKey(email) : null;
  const [answer, setAnswer] = useState(() => ({ key, verdict: key ? cachedVerdict(key) ?? null : null }));
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    verifySender(email).then((verdict) => { if (live) setAnswer({ key, verdict }); });
    return () => { live = false; };
    // `key` is every field the verdict reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return null;
  return answer.key === key ? answer.verdict : cachedVerdict(key) ?? null;
}
