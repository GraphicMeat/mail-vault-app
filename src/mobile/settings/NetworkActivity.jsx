// Settings > Privacy & security > Network Activity on the phone: desktop's view
// (src/components/settings/views/NetworkActivityView.jsx) over the engine's record. The engine
// keeps every connection it made (`mobile.netActivity.list`, engine `net_activity.rs`: core's
// store and its offline country lookup), for the period chosen here
// (`mobile.netActivity.setRetention`). Range, account and country are asked of the engine, which
// answers the rows, the countries and the totals; protocol and purpose narrow the rows on screen,
// as on desktop. Read again every few seconds while the page is open, so a connection that just
// closed appears (the phone has no live feed to pause). Desktop's remote-image counts and its
// list of what the helper does not record are not the phone's, so they are left out.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NetworkActivityView } from '../../components/settings/views/NetworkActivityView';
import { RANGES, rangesFor } from '../../utils/netActivity';
import { daemonCall } from '../transport.js';
import { useT } from '../i18n.js';
import { MobileViewEnv, openExternal } from './MobileViewEnv.jsx';

const REFRESH_MS = 5000;
const EMPTY_SUMMARY = { hosts: 0, sent: 0, received: 0, accounts: [] };

export default function NetworkActivity() {
  const t = useT();
  const [query, setQuery] = useState({ range: 'day', account: '', country: '' });
  const [filters, setFilters] = useState({ protocol: '', purpose: '' });
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [retentionFailed, setRetentionFailed] = useState(false);
  const retention = data?.retention || 'week';
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // The latest load wins: an older answer that lands later is dropped.
  const seq = useRef(0);
  // A load on its way (its seq), so the refresh never supersedes a slow list before it lands.
  const inFlight = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    inFlight.current = mine;
    try {
      const reply = await daemonCall('mobile.netActivity.list', {
        sinceMs: Date.now() - RANGES[query.range],
        ...(query.account ? { account: query.account } : {}),
        ...(query.country ? { country: query.country } : {}),
      });
      if (mounted.current && mine === seq.current) {
        setData(reply);
        setFailed(false);
      }
    } catch {
      if (mounted.current && mine === seq.current) setFailed(true);
    } finally {
      if (inFlight.current === mine) inFlight.current = 0;
    }
  }, [query]);

  useEffect(() => {
    load();
    // A tick while a load is on its way is skipped; a changed filter still loads at once.
    const timer = setInterval(() => { if (!inFlight.current) load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const setRetention = async (value) => {
    try {
      await daemonCall('mobile.netActivity.setRetention', { retention: value });
      setRetentionFailed(false);
      // A range longer than the history kept has nothing more to show.
      if (RANGES[query.range] > RANGES[value]) setQuery((q) => ({ ...q, range: rangesFor(value).at(-1) }));
      else load();
    } catch {
      if (mounted.current) setRetentionFailed(true);
    }
  };

  return (
    <MobileViewEnv>
      <NetworkActivityView rows={data?.events || []} summary={data?.summary || EMPTY_SUMMARY} places={data?.countries || []}
        query={query} onQuery={(patch) => setQuery((q) => ({ ...q, ...patch }))}
        retention={retention} onRetention={setRetention} retentionError={retentionFailed} loadError={failed}
        filters={filters} onFilter={(key, value) => setFilters((f) => ({ ...f, [key]: value }))}
        intro={t('mobile.netActivity.intro')} onOpenLink={openExternal} />
    </MobileViewEnv>
  );
}
