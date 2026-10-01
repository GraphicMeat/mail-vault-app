import React, { useState } from 'react';
import { Shield, ShieldCheck } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { useT } from '../../i18n/index.js';
import { usePrivacyStore } from '../../stores/privacyStore';

/**
 * The sidebar footer toggle for privacy mode. Icon-only in both the collapsed
 * rail and the expanded footer: the footer row has no room for a label beside
 * the Focus button. ponytail: add a labelled shape if the footer ever does.
 *
 * Turning it on is Premium (the store says so); turning it off never is.
 */
export function PrivacyModeButton({ onUpgrade }) {
  const t = useT();
  const enabled = usePrivacyStore(s => s.enabled);
  const [upsell, setUpsell] = useState(false);
  const Icon = enabled ? ShieldCheck : Shield;

  return (
    <>
      <Button
        variant="ghost" icon size="sm"
        onClick={() => { if (usePrivacyStore.getState().setEnabled(!enabled) === 'premium') setUpsell(true); }}
        title={t('privacy.hint')}
        aria-label={t('privacy.title')}
        aria-pressed={enabled}
        data-testid="privacy-button"
      >
        <Icon size={15} className={enabled ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
      </Button>

      <Dialog
        open={upsell}
        onClose={() => setUpsell(false)}
        size="sm"
        portal
        title={t('privacy.upsellTitle')}
        icon={<Shield size={20} className="text-mail-accent-text" />}
        data-testid="privacy-upsell"
      >
        <p className="text-sm text-mail-text-muted">{t('privacy.upsellBody')}</p>
        <div className="flex flex-col gap-2">
          <Button
            variant="primary" size="lg" fullWidth
            onClick={() => { setUpsell(false); onUpgrade?.(); }}
          >
            {t('common.upgrade')}
          </Button>
          <PremiumFeaturesLink className="self-center mt-1" />
        </div>
      </Dialog>
    </>
  );
}
