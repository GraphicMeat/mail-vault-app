import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore } from '../../stores/settingsStore';
import * as api from '../../services/api';
import DataUsageAccountCard from './DataUsageAccountCard';
import { ToggleSwitch } from './ToggleSwitch';

const REFRESH_MS = 30_000;

export default function DataUsageSettings({ initialAccountId }) {
  const cardRefs = useRef({});
  const [highlightedId, setHighlightedId] = useState(null);
  const [stats, setStats] = useState(null); // { [accountId]: { days, today, week, month, year } }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const accounts = useAccountStore(s => s.accounts);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const transferHoverEnabled = useSettingsStore(s => s.transferHoverEnabled);
  const setTransferHoverEnabled = useSettingsStore(s => s.setTransferHoverEnabled);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const visibleAccounts = getOrderedAccounts(accounts || []).filter(a => !hiddenAccounts?.[a.id]);

  const refresh = useCallback(() => {
    api.getTransferStats()
      .then(res => { setStats(res?.accounts || {}); setError(null); })
      .catch(e => setError(typeof e === 'string' ? e : e.message || 'Could not load transfer stats'))
      .finally(() => setLoading(false));
  }, []);

  // Refresh every 30s while this page is visible (unmounts clear the interval)
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // Scroll to and highlight the account the sidebar bubble linked to
  useEffect(() => {
    if (!initialAccountId) return;
    const timer = setTimeout(() => {
      const el = cardRefs.current[initialAccountId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedId(initialAccountId);
        setTimeout(() => setHighlightedId(null), 2000);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [initialAccountId]);

  return (
    <div className="p-6 space-y-4">
      {error && (
        <div className="text-xs text-mail-warning bg-mail-warning/10 border border-mail-warning/20 rounded-lg p-3">
          {error}
        </div>
      )}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-mail-text">Show usage on hover</div>
          <div className="text-xs text-mail-text-muted mt-0.5">
            Hovering an account in the sidebar shows its last seven days of transfer. Turn this off to keep the sidebar quiet — the breakdowns below stay available either way.
          </div>
        </div>
        <ToggleSwitch active={transferHoverEnabled !== false} onClick={() => setTransferHoverEnabled(transferHoverEnabled === false)} />
      </div>

      {visibleAccounts.length > 0 ? (
        visibleAccounts.map(account => (
          <DataUsageAccountCard
            key={account.id}
            ref={el => { cardRefs.current[account.id] = el; }}
            account={account}
            stats={stats?.[account.id]}
            loading={loading}
            highlighted={highlightedId === account.id}
          />
        ))
      ) : (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5 text-center">
          <h4 className="font-semibold text-mail-text mb-2">No accounts configured</h4>
          <p className="text-sm text-mail-text-muted">Add an email account first to see its data usage.</p>
        </div>
      )}
    </div>
  );
}
