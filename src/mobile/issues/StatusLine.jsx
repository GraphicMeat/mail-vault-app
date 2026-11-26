// The one quiet line under the list title: what the sync is doing or when it last finished, with
// the count of actions waiting to reach the server in the same line. Replaces the "Syncing" chip
// and the failed strip. A failed update is the whole line as one button: tap to try again.
// Nothing renders while there is nothing to say, so an idle, never-synced list keeps its height.
import React, { useEffect, useState } from 'react';
import { useT } from '../i18n.js';
import { statusLine } from './statusLine.js';

/** Re-renders every half minute, so "Updated 4 min ago" keeps up without a sync event. */
function useClock(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function StatusLine({ sync, pending = 0, accountCount = 1, onRetry }) {
  const t = useT();
  const now = useClock(sync?.state === 'idle');
  const line = statusLine(sync, { now, accountCount });
  if (!line && !pending) return null;
  const waiting = pending ? t('mobile.actions.waiting', { count: pending }) : null;
  return (
    <div className="mv-status-line" data-mv-status-line data-kind={line?.kind ?? 'pending'}>
      {line?.kind === 'syncing' && (
        <>
          <span className="mv-status-line__spinner" aria-hidden="true" />
          <span role="status">{t(line.key, line.params)}</span>
        </>
      )}
      {line?.kind === 'error' && (
        <button type="button" className="mv-status-line__retry" onClick={onRetry}>{t(line.key)}</button>
      )}
      {line?.kind === 'idle' && <span>{t(line.key, line.params)}</span>}
      {line && waiting && <span aria-hidden="true">{'·'}</span>}
      {waiting && <span>{waiting}</span>}
    </div>
  );
}

export default StatusLine;
