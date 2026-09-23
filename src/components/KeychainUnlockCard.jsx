import React, { useEffect, useId, useRef, useState } from 'react';
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

  // Any click elsewhere in the window while the keychain is blocked shakes the
  // card, so the user sees why nothing syncs. The click itself still goes
  // through: mail already in the vault stays usable. `nudge` is a counter
  // used as a key, so a click during a running shake restarts it.
  const cardRef = useRef(null);
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (!blocked) return undefined;
    const onPointerDown = (e) => {
      if (!cardRef.current?.contains(e.target)) setNudge(n => n + 1);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [blocked]);

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
          className="w-80"
          data-testid="keychain-unlock-card"
        >
          <div
            ref={cardRef}
            key={nudge}
            data-nudge={nudge}
            className={`px-4 py-3 bg-mail-surface border border-mail-border rounded-xl overflow-hidden ${nudge ? 'animate-nudge' : ''}`}
          >
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
