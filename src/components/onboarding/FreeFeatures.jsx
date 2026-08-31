import React from 'react';
import { ArrowRight, Inbox, MessagesSquare, Search, ShieldAlert } from 'lucide-react';
import { t as tr, useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { FREE_SAMPLES } from './FreeSamples.jsx';

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
    <div className="max-w-3xl w-full">
      <h2 className="text-lg font-semibold text-mail-text mb-1">{t('onboarding.freeTitle')}</h2>
      <p className="text-xs text-mail-text-muted mb-4">{t('onboarding.freeSubtitle')}</p>

      <div className="grid grid-cols-2 gap-2 mb-4">
        {FREE().map((f) => {
          const Icon = f.icon;
          const Sample = FREE_SAMPLES[f.id];
          return (
            <div key={f.id} data-testid={`free-feature-${f.id}`}
                 className="p-3 rounded-lg border border-mail-border bg-mail-surface flex flex-col gap-2">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-7 h-7 rounded bg-mail-accent/10 flex items-center justify-center flex-shrink-0">
                    <Icon size={14} className="text-mail-accent-text" />
                  </div>
                  <h3 className="text-sm font-medium text-mail-text">{f.title}</h3>
                </div>
                <p className="text-xs text-mail-text-muted leading-snug">{f.blurb}</p>
              </div>
              {/* Pushed to the bottom so the four samples line up across the
                  grid even though the blurbs are different lengths. */}
              <div className="mt-auto"><Sample /></div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">
          {t('common.continue')}
          <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}
