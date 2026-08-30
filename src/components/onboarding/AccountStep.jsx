import React, { useState } from 'react';
import { Key, Lock, EyeOff, HardDrive } from 'lucide-react';
import { AccountModal } from '../AccountModal';
import { Button } from '../ui/Button';
import { t as tr, useT } from '../../i18n/index.js';

// Each card names a mechanism rather than restating a reassurance — the
// product's voice is what actually happens, not that it is safe.
const MECHANISMS = () => ([
  { icon: Key,       title: tr('onboarding.systemKeychain'),    description: tr('onboarding.passwordHeldOsMailvault') },
  { icon: Lock,      title: tr('onboarding.nothingPlainFile'),  description: tr('onboarding.noPasswordEverWrittenDisk') },
  { icon: EyeOff,    title: tr('onboarding.noAccountNoTelemetry'), description: tr('onboarding.thereNoMailvaultServerSend') },
  { icon: HardDrive, title: tr('onboarding.vault2'),            description: tr('onboarding.eachEmailArchiveStandardEml') },
]);

/**
 * Credentials, with the trust claims read before the form ever appears.
 *
 * AccountModal is a portalled Dialog with its own backdrop
 * (AccountModal.jsx:516-524), so it cannot sit beside these cards in a
 * two-column layout — the backdrop would cover them. Instead this step shows
 * the cards and the keychain notice in normal flow, and only mounts the
 * modal once "Add Mailbox" has actually been pressed. Closing without
 * success just unmounts it and returns here; only a real success advances
 * the tour.
 */
export function AccountStep({ onAdded }) {
  const t = useT();
  const [showModal, setShowModal] = useState(false);

  return (
    <div className="max-w-lg w-full">
      <h2 className="text-sm font-semibold text-mail-text mb-3">{t('onboarding.whereDataLives')}</h2>

      <div data-testid="onboarding-mechanisms" className="space-y-2 mb-3">
        {MECHANISMS().map((m) => {
          const Icon = m.icon;
          return (
            <div key={m.title} className="p-2 rounded-lg border border-mail-border bg-mail-bg flex items-start gap-2">
              <div className="w-7 h-7 rounded bg-mail-accent/10 flex items-center justify-center flex-shrink-0">
                <Icon size={14} className="text-mail-accent-text" />
              </div>
              <div className="min-w-0">
                <h3 className="font-medium text-xs text-mail-text leading-tight">{m.title}</h3>
                <p className="text-[10px] text-mail-text-muted leading-tight">{m.description}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div data-testid="onboarding-keychain-notice"
           className="bg-mail-warning/10 border border-mail-warning/20 rounded-lg p-2 mb-4">
        <div className="flex items-start gap-2">
          <Key size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-xs text-mail-warning">{t('onboarding.keychainWillAskPermission')}</h4>
            <p className="text-[10px] text-mail-text-muted">{t('onboarding.chooseAlwaysAllow')}</p>
          </div>
        </div>
      </div>

      <Button variant="primary" size="lg" fullWidth
              data-testid="onboarding-add-mailbox"
              onClick={() => setShowModal(true)}>
        {t('app.addFirstAccount')}
      </Button>

      {showModal && (
        <AccountModal onClose={() => setShowModal(false)} onSuccess={onAdded} />
      )}
    </div>
  );
}
