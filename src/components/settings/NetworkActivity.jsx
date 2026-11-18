import React, { useEffect, useState } from 'react';
import { openInBrowser } from '../../services/billingApi';
import { useNetActivityStore, visibleEvents } from '../../stores/netActivityStore';
import { DesktopViewEnv } from './DesktopViewEnv';
import { NetworkActivityView } from './views/NetworkActivityView';

/**
 * Desktop's container: the daemon's live feed (stores/netActivityStore.js) over
 * NetworkActivityView, with pause, the remote-image counts and what the list
 * does not show.
 */
export function NetworkActivity() {
  const rows = useNetActivityStore(visibleEvents);
  const paused = useNetActivityStore(s => s.frozen !== null);
  const loadError = useNetActivityStore(s => s.loadError);
  const remoteImages = useNetActivityStore(s => s.remoteImages);
  const query = useNetActivityStore(s => s.query);
  const retention = useNetActivityStore(s => s.retention);
  const retentionError = useNetActivityStore(s => s.retentionError);
  const places = useNetActivityStore(s => s.places);
  const summary = useNetActivityStore(s => s.summary);
  // Protocol and purpose narrow the rows on screen; range, account and
  // country are the daemon's query, and the map and totals follow them too.
  const [filters, setFilters] = useState({ protocol: '', purpose: '' });

  // The stop function also ends a pause and clears the rows for the next visit.
  useEffect(() => useNetActivityStore.getState().start(), []);

  const store = () => useNetActivityStore.getState();
  return (
    <DesktopViewEnv>
      <NetworkActivityView rows={rows} summary={summary} places={places} query={query} onQuery={patch => store().setQuery(patch)}
        retention={retention} onRetention={value => { void store().setRetention(value); }} retentionError={retentionError}
        loadError={loadError} filters={filters} onFilter={(key, value) => setFilters(f => ({ ...f, [key]: value }))}
        remoteImages={remoteImages} paused={paused} onPause={() => store().pause()} onResume={() => store().resume()}
        notShown onOpenLink={url => openInBrowser(url).catch(() => {})} />
    </DesktopViewEnv>
  );
}
