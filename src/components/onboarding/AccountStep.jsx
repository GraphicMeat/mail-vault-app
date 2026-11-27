import React, { useState } from 'react';
import { Key, Lock, EyeOff, HardDrive, Laptop, Server, X } from 'lucide-react';
import { AccountModal } from '../AccountModal';
import { Button } from '../ui/Button';
import { OnboardingScreen } from './OnboardingScreen';
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
 * Where the mail goes, drawn: the provider above, this computer below, the
 * line between them direct, and the MailVault server that is not on it set
 * aside and struck out. Only what the copy beside it already claims: mail
 * never passes through us (update checks and billing are not mail).
 * A drawing, not live components; smaller windows drop it.
 */
function DataMap() {
  const t = useT();
  return (
    <figure data-testid="onboarding-data-map" className="onboarding-data-map">
      <div className="onboarding-data-map-node" data-node="provider">
        <Server size={20} aria-hidden="true" />
        <strong>{t('onboarding.mapProvider')}</strong>
        <span>{t('onboarding.mapProviderDetail')}</span>
      </div>
      <div className="onboarding-data-map-link" aria-hidden="true">
        <i />
        <div className="onboarding-data-map-node" data-node="no-server">
          <X size={16} aria-hidden="true" />
          <strong>{t('onboarding.mapNoServer')}</strong>
          <span>{t('onboarding.mapNoServerDetail')}</span>
        </div>
      </div>
      <div className="onboarding-data-map-node" data-node="computer">
        <Laptop size={20} aria-hidden="true" />
        <strong>{t('onboarding.mapComputer')}</strong>
        <span>{t('onboarding.mapComputerDetail')}</span>
        <div className="onboarding-data-map-chips" aria-hidden="true">
          <HardDrive size={14} /><Key size={14} />
        </div>
      </div>
    </figure>
  );
}

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
export function AccountStep({ onAdded, onSkip }) {
  const t = useT();
  const [showModal, setShowModal] = useState(false);

  return (
    <OnboardingScreen className="onboarding-account" title={t('onboarding.privacyTitle')} subtitle={t('onboarding.privacySubtitle')}
      secondary={<Button variant="ghost" size="sm" onClick={onSkip} data-testid="onboarding-skip-account">
        {t('onboarding.skipAccount')}
      </Button>}
      primary={<Button variant="primary" size="lg" data-testid="onboarding-add-mailbox" onClick={() => setShowModal(true)}>
        {t('app.addFirstAccount')}
      </Button>}>
    <div className="onboarding-account-grid">
     <div className="onboarding-account-copy">

      <div data-testid="onboarding-mechanisms">
        {MECHANISMS().map((m) => {
          const Icon = m.icon;
          return (
            <div key={m.title} className="py-2.5 border-b border-mail-border flex items-start gap-2">
              <div className="w-7 h-7 rounded bg-mail-accent/10 flex items-center justify-center flex-shrink-0">
                <Icon size={14} className="text-mail-accent-text" />
              </div>
              <div className="min-w-0">
                <h3 className="font-medium text-sm text-mail-text leading-relaxed">{m.title}</h3>
                <p className="text-xs text-mail-text-muted leading-relaxed">{m.description}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div data-testid="onboarding-keychain-notice"
           className="bg-mail-warning/10 border border-mail-warning/20 rounded-lg p-3">
        <div className="flex items-start gap-2">
          <Key size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-medium text-sm text-mail-warning">{t('onboarding.keychainWillAskPermission')}</h4>
            <p className="text-xs text-mail-text-on-tint">{t('onboarding.chooseAlwaysAllow')}</p>
          </div>
        </div>
      </div>

     </div>

      <DataMap />

      {showModal && (
        <AccountModal onClose={() => setShowModal(false)} onSuccess={onAdded} />
      )}
    </div>
    </OnboardingScreen>
  );
}
