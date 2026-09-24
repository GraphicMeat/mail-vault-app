import React from 'react';
import { PenSquare } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../i18n/index.js';

const MODES = ['app', 'window'];

/**
 * Where a new compose opens: over the main window, or in a window of its own.
 * One row for Settings and the onboarding tour, like DefaultMailApp.
 */
export function ComposeOpenMode({ standalone = false }) {
  const t = useT();
  const Heading = standalone ? 'h2' : 'h4';
  const mode = useSettingsStore(s => s.composeOpenMode) || 'app';
  const setMode = useSettingsStore(s => s.setComposeOpenMode);

  return (
    <div className="settings-section" data-testid="compose-open-mode">
      <Heading className={`${standalone ? 'text-lg ' : ''}font-semibold text-mail-text mb-4 flex items-center gap-2`}>
        <PenSquare size={18} className="text-mail-accent-text" />
        {t('settings.behavior.composeOpen.title')}
      </Heading>
      <p className="text-sm text-mail-text-muted mb-4">{t('settings.behavior.composeOpen.description')}</p>
      <div role="radiogroup" aria-label={t('settings.behavior.composeOpen.title')} className="flex gap-2 flex-wrap">
        {MODES.map(value => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            data-testid={`compose-open-${value}`}
            onClick={() => setMode(value)}
            className={`px-4 py-2 rounded-lg border text-sm transition-colors ${mode === value
              ? 'border-mail-accent bg-mail-accent/10 text-mail-text font-medium'
              : 'border-mail-border text-mail-text hover:bg-mail-surface-hover'}`}
          >
            {t(`settings.behavior.composeOpen.${value}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
