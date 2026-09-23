import React, { useEffect, useId } from 'react';
import { AnimatePresence } from 'framer-motion';
import { KeyRound, Unlock } from 'lucide-react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui';
import { useKeychainGateStore, initKeychainGate } from '../stores/keychainGateStore';
import { useT } from '../i18n/index.js';

/**
 * The daemon cannot read the keychain, so sync and scheduled sends are
 * stopped until it can. A corner card rather than a modal, so the mail
 * already in the vault stays usable, and with no way to dismiss it: it leaves
 * when the daemon reports the keychain readable again, however that happened.
 */
export function KeychainUnlockCard() {
  const t = useT();
  const titleId = useId();
  const blocked = useKeychainGateStore(s => s.blocked);
  const unlocking = useKeychainGateStore(s => s.unlocking);
  const error = useKeychainGateStore(s => s.error);
  const unlock = useKeychainGateStore(s => s.unlock);

  useEffect(() => { initKeychainGate(); }, []);

  const ERRORS = {
    timeout: t('keychainGate.error.timeout'),
    locked: t('keychainGate.error.locked'),
    denied: t('keychainGate.error.denied'),
    error: t('keychainGate.error.error'),
  };

  return (
    <AnimatePresence>
      {blocked && (
        <ToastShell
          position="bottom-right"
          role="alert"
          aria-labelledby={titleId}
          bare
          className="w-80 bg-mail-surface border border-mail-border rounded-xl overflow-hidden"
          data-testid="keychain-unlock-card"
        >
          <div className="px-4 py-3">
            <div className="flex items-start gap-3">
              <KeyRound size={18} className="text-mail-warning flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div id={titleId} className="text-sm font-medium text-mail-text">{t('keychainGate.title')}</div>
                <p className="text-xs text-mail-text-muted">{t('keychainGate.body')}</p>
                <p className="text-xs text-mail-text-muted">{t('keychainGate.hint')}</p>
                {error && (
                  <p className="text-xs text-mail-danger" data-testid="keychain-unlock-error">
                    {ERRORS[error] || ERRORS.error}
                  </p>
                )}
                <div className="pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={unlock}
                    loading={unlocking}
                    data-testid="keychain-unlock"
                  >
                    {!unlocking && <Unlock size={12} aria-hidden="true" />}
                    {t('keychainGate.unlock')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </ToastShell>
      )}
    </AnimatePresence>
  );
}
