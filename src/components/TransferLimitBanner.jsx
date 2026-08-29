import { Button } from './ui/Button';
import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useAccountStore } from '../stores/accountStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as api from '../services/api';
import { isGmailAccount, resolveDailyLimitBytes } from '../utils/transferLimits';
import { useT } from '../i18n/index.js';

const DISMISS_KEY = 'mailvault-transfer-warn-dismissed';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadDismissed() {
  try { return JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '{}'); } catch { return {}; }
}

/**
 * Shown across the top of the main view when an account has crossed 80% of
 * its daily transfer limit (explicit or Gmail's provider default) and
 * warnEnabled hasn't been turned off for it. Dismissing hides it for that
 * account until the next UTC day.
 */
export function TransferLimitBanner({ onOpenDataUsage }) {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const transferLimits = useSettingsStore(s => s.transferLimits);
  const [warnings, setWarnings] = useState([]);
  const [dismissed, setDismissed] = useState(loadDismissed);

  const check = useCallback(async () => {
    if (!accounts?.length) { setWarnings([]); return; }
    try {
      const res = await api.getTransferStats();
      const today = utcDateKey();
      const next = [];
      for (const account of accounts) {
        if (dismissed[account.id] === today) continue;
        const entry = transferLimits[account.id];
        const warnEnabled = entry?.warnEnabled !== false; // missing entry = warn on
        if (!warnEnabled) continue;
        const todayStats = res?.accounts?.[account.id]?.today;
        if (!todayStats) continue;
        const gmail = isGmailAccount(account);
        const down = resolveDailyLimitBytes(entry, gmail, 'down');
        const up = resolveDailyLimitBytes(entry, gmail, 'up');
        let worst = null;
        if (down.limitBytes) {
          const pct = todayStats.down / down.limitBytes;
          if (pct >= 0.8) worst = { pct, direction: 'download' };
        }
        if (up.limitBytes) {
          const pct = todayStats.up / up.limitBytes;
          if (pct >= 0.8 && (!worst || pct > worst.pct)) worst = { pct, direction: 'upload' };
        }
        if (worst) {
          next.push({ accountId: account.id, email: account.email, pct: worst.pct, direction: worst.direction });
        }
      }
      setWarnings(next);
    } catch (e) {
      console.warn('[TransferLimitBanner] stats check failed:', e);
    }
  }, [accounts, transferLimits, dismissed]);

  // Check on app start + every 5 minutes
  useEffect(() => {
    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [check]);

  const dismiss = (accountId) => {
    const next = { ...dismissed, [accountId]: utcDateKey() };
    setDismissed(next);
    try { sessionStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch {}
    setWarnings(w => w.filter(x => x.accountId !== accountId));
  };

  if (warnings.length === 0) return null;
  // ponytail: one banner at a time (worst account first); the rest surface once this one is dismissed.
  const w = [...warnings].sort((a, b) => b.pct - a.pct)[0];

  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-mail-warning/10 border-b border-mail-warning/30">
      <AlertTriangle size={16} className="text-mail-warning flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-mail-warning font-medium truncate">
          {w.email} has used {Math.round(w.pct * 100)}% of its daily {w.direction} limit
        </p>
      </div>
      <Button variant="ghost" size="sm" className="bg-mail-warning/20 text-mail-warning hover:bg-mail-warning/30 font-medium text-xs whitespace-nowrap"
        onClick={() => onOpenDataUsage?.(w.accountId)}
      >
        {t('transferLimit.view')}
      </Button>
      <button
        onClick={() => dismiss(w.accountId)}
        className="p-1 hover:bg-mail-warning/20 rounded transition-colors flex-shrink-0"
        title={t('transferLimit.dismissUntilTomorrow')}
      >
        <X size={14} className="text-mail-warning" />
      </button>
    </div>
  );
}
