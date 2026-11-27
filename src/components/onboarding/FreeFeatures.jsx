import React from 'react';
import { ArrowRight, Inbox, MessagesSquare, Search, ShieldAlert } from 'lucide-react';
import { t as tr, useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { FREE_SAMPLES } from './FreeSamples.jsx';
import { OnboardingScreen } from './OnboardingScreen';

// The four that are worth knowing on day one and cost nothing. Everything here
// is free forever; the premium pitch is the next screen, not this one.
//
// Each carries a sample, because the two features that need explaining most —
// the vault marks and the safety warnings — are ICONS, and prose describing an
// icon is worse than showing it.
const FREE = () => ([
  { id: 'vault',       icon: Inbox,          title: tr('free.vault.title'),       blurb: tr('free.vault.blurb') },
  { id: 'chat',        icon: MessagesSquare, title: tr('free.chat.title'),        blurb: tr('free.chat.blurb') },
  { id: 'search',      icon: Search,         title: tr('free.search.title'),      blurb: tr('free.search.blurb') },
  { id: 'link-safety', icon: ShieldAlert,    title: tr('free.linkSafety.title'),  blurb: tr('free.linkSafety.blurb') },
]);

export function FreeFeatures({ onContinue }) {
  const t = useT();

  return (
    <OnboardingScreen className="onboarding-free" title={t('onboarding.freeTitle')} subtitle={t('onboarding.freeSubtitle')}
      primary={<Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">
        {t('common.continue')}
        <ArrowRight size={14} />
      </Button>}>
      <div className="onboarding-free-grid">
        {FREE().map((f) => {
          const Icon = f.icon;
          const Sample = FREE_SAMPLES[f.id];
          return (
            <div key={f.id} data-testid={`free-feature-${f.id}`}
                 className="onboarding-free-card rounded-lg border border-mail-border bg-mail-surface min-h-0 overflow-hidden">
              <div className="onboarding-free-head">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-7 h-7 rounded bg-mail-accent-tint flex items-center justify-center flex-shrink-0">
                    <Icon size={14} className="text-mail-accent-text" />
                  </div>
                  <h3 className="text-sm font-medium text-mail-text">{f.title}</h3>
                </div>
                <p className="text-xs text-mail-text-muted leading-snug">{f.blurb}</p>
              </div>
              {/* The card's second grid row: the samples of a row share one top
                  and one height whatever the blurbs' lengths, and each sample
                  fills its frame, content centred. */}
              <div className="onboarding-free-sample"><Sample /></div>
            </div>
          );
        })}
      </div>
    </OnboardingScreen>
  );
}
