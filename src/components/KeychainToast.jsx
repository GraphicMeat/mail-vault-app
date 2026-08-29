import { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ToastShell } from './ui/ToastShell';
import { KeyRound, X, RefreshCw } from 'lucide-react';
import * as keychainSession from '../services/keychainSession';
import { t as tr, useT  } from '../i18n/index.js';

// Each of these states has a different way out, and the toast has the two
// buttons to take it — the message used to name the failure and stop there.
const MESSAGES = () => ({
  denied: tr('keychain.keychainRefusedAccessPassword'),
  cancelled: tr('keychain.keychainPromptWasDismissed'),
  timed_out: tr('keychain.keychainDidAnswerTime'),
  unavailable: tr('keychain.keychainUnavailableRightNow'),
});

const RECOVERY = () => ({
  denied: tr('keychain.retryAllowPromptReEnter'),
  cancelled: tr('keychain.retryBringPromptBack'),
  timed_out: tr('keychain.retryUsuallyClearsSecondAttempt'),
  unavailable: tr('keychain.retryMomentReEnterPassword'),
});

export function KeychainToast({ onRetry, onOpenAccounts }) {
  const t = useT();
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
      {/* `bare`: this toast draws its own edge-to-edge action bar, so the
          shell's own padding would inset it. */}
      <ToastShell
        position="bottom-right"
        role="alert"
        bare
        className="w-80 bg-mail-surface border border-mail-border rounded-xl overflow-hidden"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <KeyRound size={18} className="text-mail-warning flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-mail-text">
                {MESSAGES()[status] || 'The keychain refused access to your password.'}
              </div>
              <div className="text-xs text-mail-text-muted mt-1">
                Everything already in your vault still opens. Reaching the server needs the password.
                {' '}{RECOVERY()[status] || 'Retry, or re-enter the password under Accounts.'}
              </div>
              <div className="flex items-center gap-2 mt-2.5">
                <button
                  onClick={() => { setVisible(false); onRetry?.(); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-mail-accent/10 text-mail-accent-text hover:bg-mail-accent/20 rounded-lg transition-colors"
                >
                  <RefreshCw size={12} />
                  {t('common.retry')}
                </button>
                <button
                  onClick={() => { setVisible(false); onOpenAccounts?.(); }}
                  className="px-3 py-1.5 text-xs font-medium text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover rounded-lg transition-colors"
                >
                  {t('keychain.reEnterPassword')}
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
      </ToastShell>
    </AnimatePresence>
  );
}
