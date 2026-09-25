import React, { useEffect, useId, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { HardDrive, Unlock } from 'lucide-react';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui';
import { usePortableStore, initPortable } from '../stores/portableStore';
import { TRANSFER_INPUT } from './transfer/transferStyles';
import { useT } from '../i18n/index.js';

/**
 * A portable copy's accounts are sealed on the drive and locked at every
 * launch. Same corner and shape as KeychainUnlockCard, with no way to dismiss
 * it: mail already on the drive stays readable, sync and sending wait.
 */
export function PortableUnlockCard() {
  const t = useT();
  const titleId = useId();
  const locked = usePortableStore(s => s.status.portable && s.status.locked);
  const unlocking = usePortableStore(s => s.unlocking);
  const error = usePortableStore(s => s.error);
  const unlock = usePortableStore(s => s.unlock);
  const [passphrase, setPassphrase] = useState('');

  useEffect(() => { initPortable(); }, []);
  // Never keep the password around once the store is open.
  useEffect(() => { if (!locked) setPassphrase(''); }, [locked]);

  const submit = (e) => {
    e.preventDefault();
    if (passphrase) unlock(passphrase);
  };

  return (
    <AnimatePresence>
      {locked && (
        <ToastShell
          position="bottom-right"
          role="alert"
          aria-labelledby={titleId}
          bare
          className="w-80"
          data-testid="portable-unlock-card"
        >
          <form onSubmit={submit} className="px-4 py-3 bg-mail-surface border border-mail-border rounded-xl overflow-hidden">
            <div className="flex items-start gap-3">
              <HardDrive size={18} className="text-mail-warning flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-2">
                <div id={titleId} className="text-sm font-medium text-mail-text">{t('portable.unlock.title')}</div>
                <p className="text-xs text-mail-text-muted">{t('portable.unlock.body')}</p>
                <input
                  type="password"
                  autoComplete="current-password"
                  aria-label={t('settings.transfer.password')}
                  className={TRANSFER_INPUT}
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  data-testid="portable-unlock-input"
                />
                {error && (
                  <p className="text-xs text-mail-danger" data-testid="portable-unlock-error" data-error={error}>
                    {error === 'wrong' ? t('portable.passwordWrong') : t('portable.unlock.error')}
                  </p>
                )}
                <Button type="submit" variant="primary" size="sm" loading={unlocking} disabled={!passphrase} data-testid="portable-unlock">
                  {!unlocking && <Unlock size={12} aria-hidden="true" />}
                  {t('portable.unlock.button')}
                </Button>
              </div>
            </div>
          </form>
        </ToastShell>
      )}
    </AnimatePresence>
  );
}
