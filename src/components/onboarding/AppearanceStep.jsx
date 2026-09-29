import React, { useState } from 'react';
import { ArrowRight, Moon, Sun } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { SettingsTabs } from '../ui/SettingsTabs';
import { SegmentedChoice } from '../ui/SegmentedChoice';
import { ColorOptionPreview } from '../settings/PreferencePreview';
import { QuickActionLayoutCards, QuickActionPresets, QuickActionSample } from '../settings/QuickActionSamples';
import { FontOptions, TextSizeChoice } from '../settings/TextSettings';
import { AppearancePreview } from './AppearancePreview';
import { NOTIFICATION_SOUNDS, normalizeNotificationSound } from '../../utils/notificationSounds';
import { previewNotificationSound } from '../../services/api';
import { DEFAULT_QUICK_ACTIONS, normalizeQuickActions, QUICK_ACTION_SURFACES } from '../../utils/quickActions';
import { useQuickActionSamples } from '../../hooks/useQuickActionSamples';

// The quick actions tab: Settings' action sets, layout cards and live sample,
// for All views. The samples are read when this tab opens, the last step, so a
// first run's new account has had the longest to cache some mail.
function QuickActionsSection() {
  const t = useT();
  const [surface, setSurface] = useState('row');
  const quickActions = useSettingsStore(state => state.quickActions);
  const setStyle = useSettingsStore(state => state.setQuickActionStyle);
  const config = normalizeQuickActions(quickActions).defaults[surface];
  const rows = useQuickActionSamples();
  return <div className="onboarding-appearance-grid onboarding-quick-actions-grid">
    <div className="onboarding-appearance-controls">
      <p className="onboarding-section-hint">{t('onboarding.quick-actionsHint')}</p>
      <QuickActionPresets scope={null} rows={rows} />
      <fieldset data-testid="appearance-control-quick-surface">
        <legend>{t('quickActions.surface')}</legend>
        <SegmentedChoice label={t('quickActions.surface')} value={surface} onChange={setSurface}
          options={QUICK_ACTION_SURFACES.map(value => ({ value, label: t(`quickActions.surface.${value}`) }))} />
      </fieldset>
      <fieldset data-testid="appearance-control-quick-layout">
        <legend>{t('quickActions.layout')}</legend>
        <QuickActionLayoutCards surface={surface} config={config} rows={rows} onChange={mode => setStyle(surface, null, { mode })} />
      </fieldset>
    </div>
    <div className="onboarding-appearance-example">
      <QuickActionSample key={surface} surface={surface} config={config} rows={rows} />
    </div>
  </div>;
}

function Choice({ id, active, value, onPick, disabled, children }) {
  return <button type="button" data-testid={id} onClick={() => onPick(value)}
    disabled={disabled} aria-pressed={active === value}>{children}</button>;
}

const SECTIONS = ['colors', 'layout', 'reading', 'quick-actions'];
// Built-in macOS sounds, as in Settings → Notifications.
const isMac = () => typeof navigator !== 'undefined' && !!navigator.platform?.startsWith('Mac');

// Tab changes only affect what is shown. Preferences keep using the same
// setters as Settings, and Continue never resets choices the user already made.
// The primary button walks the tabs (Next) and only the last one offers Continue.
export function AppearanceStep({ onContinue }) {
  const t = useT();
  const [section, setSection] = useState('colors');
  const { theme, setTheme, palette, setPalette } = useThemeStore();
  const settings = useSettingsStore();
  const chat = settings.viewStyle === 'chat';
  const nextSection = SECTIONS[SECTIONS.indexOf(section) + 1];
  const tabs = SECTIONS.map(id => ({ id, label: id === 'quick-actions' ? t('quickActions.title') : t(`settings.appearance.section.${id}`) }));
  const groups = section === 'layout' ? [
    { id: 'view', key: 'viewStyle', setter: 'setViewStyle', label: 'workspace.mailExperience', options: [['list', 'workspace.emailView', 'workspace.emailViewHint'], ['chat', 'workspace.chatView', 'workspace.chatViewHint']] },
    { id: 'layout', key: 'layoutMode', setter: 'setLayoutMode', label: 'workspace.readingPane', disabled: chat, options: [['three-column', 'workspace.besideList', 'workspace.besideListHint'], ['two-column', 'workspace.belowList', 'workspace.belowListHint']] },
  ] : section === 'reading' ? [
    { id: 'density', key: 'emailListStyle', setter: 'setEmailListStyle', label: 'workspace.messageRows', disabled: chat, options: [['compact', 'workspace.twoLineRows', 'workspace.twoLineRowsHint'], ['default', 'workspace.singleLineRows', 'workspace.singleLineRowsHint']] },
    { id: 'threads', key: 'threadMode', setter: 'setThreadMode', label: 'settings.appearance.threadMode', disabled: chat, options: [['grouped', 'settings.appearance.threadModeGrouped', 'settings.appearance.threadModeGroupedHint'], ['expandable', 'settings.appearance.threadModeExpandable', 'settings.appearance.threadModeExpandableHint'], ['flat', 'onboarding.separateMessages', 'settings.appearance.threadModeFlatHint']] },
  ] : [];
  const applyRecommended = () => {
    setTheme('dark');
    setPalette('graphite');
    settings.setLayoutMode('three-column');
    settings.setSidebarStyle('list');
    settings.setSidebarLayout('stacked');
    settings.setViewStyle('list');
    settings.setEmailListStyle('compact');
    settings.setThreadMode('expandable');
    settings.setAfterDeleteSelect('none');
    settings.setConfirmBeforeDelete(true);
    settings.setEmailRowHighlight('hover');
    settings.setQuickActionStyleLink(null, false, 'row');
    // The look only, not the MailVault set: a replay keeps the actions chosen.
    QUICK_ACTION_SURFACES.forEach(surface => {
      const defaults = DEFAULT_QUICK_ACTIONS.defaults[surface];
      settings.setQuickActionStyle(surface, null, {
        mode: defaults.mode,
        palette: defaults.palette,
        radialPagination: defaults.radialPagination,
        radialLayout: defaults.radialLayout,
      });
    });
  };

  return <div className="onboarding-appearance">
    <header className="onboarding-appearance-heading">
      <h2>{t('onboarding.appearanceTitle')}</h2>
      <p>{t('onboarding.appearanceSubtitle')}</p>
    </header>
    <SettingsTabs tabs={tabs} value={section} onChange={setSection} label={t('onboarding.appearanceTitle')}>
      {section === 'quick-actions' ? <QuickActionsSection /> : <div className="onboarding-appearance-grid">
        <div className="onboarding-appearance-controls">
          <p className="onboarding-section-hint">{t(`onboarding.${section}Hint`)}</p>
          {section === 'colors' && <>
            <fieldset data-testid="appearance-control-theme">
              <legend>{t('settings.appearance.theme')}</legend>
              <div className="onboarding-choices">
                {[[Sun, 'light'], [Moon, 'dark']].map(([Icon, value]) => <Choice key={value} id={`appearance-theme-${value}`} active={theme} value={value} onPick={setTheme}><Icon size={15} aria-hidden="true" />{t(`settings.colors.${value}`)}</Choice>)}
              </div>
            </fieldset>
            <fieldset data-testid="appearance-control-palette">
              <legend>{t('settings.colors.palette')}</legend>
              <div className="settings-visual-options">
                {['indigo', 'graphite'].map(value => <Choice key={value} id={`appearance-palette-${value}`} active={palette} value={value} onPick={setPalette}>
                  <ColorOptionPreview theme={theme} palette={value} />
                  <span className="settings-visual-option-label">{t(`settings.colors.${value}`)}</span>
                </Choice>)}
              </div>
            </fieldset>
            <fieldset data-testid="appearance-control-font">
              <legend>{t('settings.text.font')}</legend>
              <FontOptions value={settings.appFont} onChange={settings.setAppFont} />
            </fieldset>
            <fieldset data-testid="appearance-control-text-size">
              <legend>{t('settings.text.size')}</legend>
              <TextSizeChoice label={t('settings.text.size')} value={settings.textScale} onChange={settings.setTextScale} />
            </fieldset>
          </>}
          {groups.map(({ id, key, setter, label, disabled, options }) => {
            const value = key === 'emailListStyle' && settings[key] !== 'compact' ? 'default' : settings[key];
            const hint = options.find(([option]) => option === value)?.[2];
            return <fieldset key={id} data-testid={`appearance-control-${id}`}>
              <legend>{t(label)}</legend>
              <div className="onboarding-choices">
                {options.map(([option, text]) => <Choice key={option} id={`appearance-${id}-${option}`} active={value} value={option} onPick={settings[setter]} disabled={disabled}>{t(text)}</Choice>)}
              </div>
              {!disabled && hint && <p className="onboarding-choice-hint">{t(hint)}</p>}
            </fieldset>;
          })}
          {/* Its own fieldset rather than a `groups` entry: this one preference
              is a boolean, and the group map reads `settings[key]` as the
              option value. Never disabled — deleting works the same in the
              chat view. */}
          {section === 'reading' && <fieldset data-testid="appearance-control-delete-confirm">
            <legend>{t('settings.behavior.confirmBeforeDelete')}</legend>
            <div className="onboarding-choices">
              {[['ask', true], ['skip', false]].map(([id, value]) => <Choice key={id} id={`appearance-delete-confirm-${id}`}
                active={settings.confirmBeforeDelete !== false} value={value} onPick={settings.setConfirmBeforeDelete}>
                {t(value ? 'settings.behavior.confirmDeleteAsk' : 'settings.behavior.confirmDeleteSkip')}
              </Choice>)}
            </div>
            <p className="onboarding-choice-hint">{t(settings.confirmBeforeDelete !== false
              ? 'settings.behavior.confirmDeleteAskHint'
              : 'settings.behavior.confirmDeleteSkipHint')}</p>
          </fieldset>}
          {/* Same gate as Settings: a sound with notifications off never plays.
              Picking one plays it, which is the preview. */}
          {section === 'reading' && isMac() && settings.notificationSettings?.enabled && <fieldset data-testid="appearance-control-sound">
            <legend>{t('settings.notifications.newEmailSound')}</legend>
            <div className="onboarding-choices onboarding-sound-choices">
              {['none', ...NOTIFICATION_SOUNDS].map(value => <Choice key={value} id={`appearance-sound-${value}`}
                active={normalizeNotificationSound(settings.notificationSettings.sound)} value={value}
                onPick={sound => { settings.setNotificationSound(sound); if (sound !== 'none') previewNotificationSound(sound).catch(() => {}); }}>
                {value === 'none' ? t('settings.notifications.soundOff') : value}
              </Choice>)}
            </div>
          </fieldset>}
          {chat && ['layout', 'reading'].includes(section) && <p className="onboarding-choice-hint">{t('workspace.emailViewOnly')}</p>}
        </div>
        <div className="onboarding-appearance-example">
          <AppearancePreview layoutMode={settings.layoutMode} sidebarStyle={settings.sidebarStyle}
            viewStyle={settings.viewStyle} emailListStyle={settings.emailListStyle} threadMode={settings.threadMode}
            theme={theme} palette={palette} emailViewerTheme={settings.emailViewerTheme}
            highlight={settings.emailRowHighlight} actionButtonDisplay={settings.actionButtonDisplay} appFont={settings.appFont} />
        </div>
      </div>}
    </SettingsTabs>
    <footer className="onboarding-appearance-footer">
      <Button variant="ghost" size="sm" onClick={applyRecommended} data-testid="appearance-recommended">{t('onboarding.recommended')}</Button>
      {nextSection
        ? <Button variant="primary" size="lg" onClick={() => setSection(nextSection)} data-testid="appearance-next">{t('common.next')}<ArrowRight size={14} /></Button>
        : <Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">{t('common.continue')}<ArrowRight size={14} /></Button>}
    </footer>
    <p className="onboarding-appearance-note">{t('onboarding.moreInAppearance')}</p>
  </div>;
}
