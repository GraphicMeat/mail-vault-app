import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { KeyRound, X, RefreshCw } from 'lucide-react';
import * as keychainSession from '../services/keychainSession';

const MESSAGES = {
  denied: 'Keychain access was denied.',
  cancelled: 'Keychain prompt was dismissed.',
  timed_out: 'Keychain access timed out.',
  unavailable: 'Keychain service is unavailable.',
};

export function KeychainToast({ onRetry, onOpenAccounts }) {
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const check = (s) => {
      if (s === 'denied' || s === 'cancelled' || s === 'timed_out' || s === 'unavailable') {
        setStatus(s);
        setVisible(true);
      }
    };
    // Check current state on mount
    check(keychainSession.getStatus());
    // Subscribe to future changes
    return keychainSession.subscribe(check);
  }, []);

  if (!visible || !status) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className="fixed bottom-6 right-6 z-[70] w-80 bg-mail-surface border border-mail-border rounded-xl shadow-lg overflow-hidden"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <KeyRound size={18} className="text-mail-warning flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-mail-text">
                {MESSAGES[status] || 'Keychain access failed.'}
              </div>
              <div className="text-xs text-mail-text-muted mt-1">
                Cached and local emails are still available. Server actions need keychain access.
              </div>
              <div className="flex items-center gap-2 mt-2.5">
                <button
                  onClick={() => { setVisible(false); onRetry?.(); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-mail-accent/10 text-mail-accent hover:bg-mail-accent/20 rounded-lg transition-colors"
                >
                  <RefreshCw size={12} />
                  Retry
                </button>
                <button
                  onClick={() => { setVisible(false); onOpenAccounts?.(); }}
                  className="px-3 py-1.5 text-xs font-medium text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover rounded-lg transition-colors"
                >
                  Open Accounts
                </button>
              </div>
            </div>
            <button
              onClick={() => setVisible(false)}
              className="p-1 hover:bg-mail-surface-hover rounded transition-colors flex-shrink-0"
            >
              <X size={14} className="text-mail-text-muted" />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
