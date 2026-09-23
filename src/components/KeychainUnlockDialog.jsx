import React, { useEffect } from 'react';
import { KeyRound } from 'lucide-react';
import { Dialog, Button } from './ui';
import { useKeychainGateStore, initKeychainGate } from '../stores/keychainGateStore';
import { useT } from '../i18n/index.js';

/**
 * The daemon cannot read the keychain, so sync and scheduled sends are
 * stopped until the user unlocks it. Mounted once; the daemon's
 * `keychain-status` event opens it, and "Later" puts it off until the next
 * time the keychain blocks.
 */
export function KeychainUnlockDialog() {
  const t = useT();
  const blocked = useKeychainGateStore(s => s.blocked);
  const dismissed = useKeychainGateStore(s => s.dismissed);
  const unlocking = useKeychainGateStore(s => s.unlocking);
  const error = useKeychainGateStore(s => s.error);
  const dismiss = useKeychainGateStore(s => s.dismiss);
  const unlock = useKeychainGateStore(s => s.unlock);

  useEffect(() => { initKeychainGate(); }, []);

  const ERRORS = {
    timeout: t('keychainGate.error.timeout'),
    locked: t('keychainGate.error.locked'),
    denied: t('keychainGate.error.denied'),
    error: t('keychainGate.error.error'),
  };

  return (
    <Dialog
      open={blocked && !dismissed}
      onClose={dismiss}
      dismissable={!unlocking}
      portal
      size="md"
      role="alertdialog"
      title={t('keychainGate.title')}
      data-testid="keychain-unlock-dialog"
      icon={<KeyRound size={18} className="text-mail-warning" />}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={dismiss} disabled={unlocking}>{t('keychainGate.later')}</Button>
          <Button variant="primary" onClick={unlock} loading={unlocking} data-testid="keychain-unlock">
            {t('keychainGate.unlock')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-mail-text">
        <p>{t('keychainGate.body')}</p>
        <p className="text-mail-text-muted">{t('keychainGate.hint')}</p>
        {error && (
          <p className="text-mail-danger" role="alert" data-testid="keychain-unlock-error">
            {ERRORS[error] || ERRORS.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
