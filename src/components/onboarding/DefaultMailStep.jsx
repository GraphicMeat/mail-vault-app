import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { SegmentedChoice } from '../ui/SegmentedChoice';
import { ChoiceCards } from '../ui/ChoiceCards';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { DefaultMailApp } from '../settings/DefaultMailApp';
import { ComposeOpenMode } from '../settings/ComposeOpenMode';
import { OnboardingScreen } from './OnboardingScreen';
import { AppearancePreview, useAppearancePreviewProps } from './AppearancePreview';
import { useSettingsStore } from '../../stores/settingsStore';
import { afterDeleteRule } from '../../stores/slices/unifiedHelpers';
import { useT } from '../../i18n/index.js';

// What opens after the open email is deleted, each drawn as a short list: the
// deleted row dashed, the one that opens next filled. Settings has two more
// (the next or previous UNREAD email); they stay there.
const AFTER_DELETE = [
  ['next', 'settings.behavior.afterDeleteSelectNext', ['', 'gone', 'open', '']],
  ['previous', 'settings.behavior.afterDeleteSelectPrevious', ['', 'open', 'gone', '']],
  ['none', 'settings.behavior.afterDeleteSelectNothing', ['', 'gone', '', '']],
];

/**
 * How MailVault handles mail, in one screen: mail links, where Compose opens,
 * and deleting. The rows are the same components Settings shows (one place
 * decides what the OS allows), drawn one line each. An offer, never a gate:
 * Continue is always live, whatever the OS said.
 */
export function DefaultMailStep({ onContinue }) {
  const t = useT();
  const confirm = useSettingsStore(s => s.confirmBeforeDelete) !== false;
  const setConfirm = useSettingsStore(s => s.setConfirmBeforeDelete);
  const afterDelete = useSettingsStore(s => s.afterDeleteSelect) || 'none';
  const setAfterDelete = useSettingsStore(s => s.setAfterDeleteSelect);
  const sameAccount = useSettingsStore(s => !!s.afterDeleteSameAccount);
  const setSameAccount = useSettingsStore(s => s.setAfterDeleteSameAccount);
  const composeMode = useSettingsStore(s => s.composeOpenMode) || 'app';
  const previewProps = useAppearancePreviewProps();

  // The sample window shows the choice made last: Compose first, as the rows
  // are ordered; asking before a delete shows the question, deleting right
  // away (or an after-delete choice) shows what opens next.
  const [focus, setFocus] = useState('compose');
  const seen = useRef({ composeMode, confirm, afterDelete });
  useEffect(() => {
    const was = seen.current;
    if (was.composeMode !== composeMode) setFocus('compose');
    else if (was.confirm !== confirm) setFocus(confirm ? 'confirm' : 'result');
    else if (was.afterDelete !== afterDelete) setFocus('result');
    seen.current = { composeMode, confirm, afterDelete };
  }, [composeMode, confirm, afterDelete]);
  const scene = focus === 'compose' ? { kind: 'compose', mode: composeMode }
    : focus === 'confirm' ? { kind: 'confirm' } : { kind: 'result', afterDelete };

  return (
    <OnboardingScreen className="onboarding-habits" title={t('onboarding.habitsTitle')} subtitle={t('onboarding.habitsSubtitle')}
      primary={<Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">
        {t('common.continue')}<ArrowRight size={14} />
      </Button>}>
    <div className="onboarding-appearance-grid">
     <div className="onboarding-appearance-controls onboarding-habits-controls">
      <DefaultMailApp compact />
      <ComposeOpenMode compact />

      <section className="onboarding-habits-delete" aria-labelledby="onboarding-delete-heading">
        <div className="onboarding-habit-row">
          <div className="onboarding-habit-copy">
            <strong id="onboarding-delete-heading"><Trash2 size={15} aria-hidden="true" />{t('settings.behavior.confirmBeforeDelete')}</strong>
            <span>{t(confirm ? 'settings.behavior.confirmDeleteAskHint' : 'settings.behavior.confirmDeleteSkipHint')}</span>
          </div>
          <SegmentedChoice label={t('settings.behavior.confirmBeforeDelete')} value={confirm ? 'ask' : 'skip'}
            onChange={value => setConfirm(value === 'ask')}
            options={[
              { value: 'ask', label: t('settings.behavior.confirmDeleteAsk') },
              { value: 'skip', label: t('settings.behavior.confirmDeleteSkip') },
            ]} />
        </div>
        <p className="onboarding-habit-question">{t('settings.behavior.chooseWhatOpensAfterDelete')}</p>
        <ChoiceCards label={t('settings.behavior.whenAnEmailIsDeleted')} value={afterDelete} onChange={setAfterDelete}
          className="onboarding-after-delete"
          options={AFTER_DELETE.map(([value, key, rows]) => ({
            value,
            label: t(key),
            preview: <span className="onboarding-after-delete-picture" aria-hidden="true">
              {rows.map((state, i) => <i key={i} data-row={state || undefined} />)}
            </span>,
          }))} />
        {afterDeleteRule(afterDelete) && (
          <label className="onboarding-habit-switch">
            <ToggleSwitch label={t('settings.behavior.afterDeleteSameAccount')} active={sameAccount}
              onClick={() => setSameAccount(!sameAccount)} testId="after-delete-same-account" />
            <span>{t('settings.behavior.afterDeleteSameAccount')}</span>
          </label>
        )}
      </section>
     </div>
     <div className="onboarding-appearance-example"><AppearancePreview {...previewProps} scene={scene} /></div>
    </div>
    </OnboardingScreen>
  );
}
