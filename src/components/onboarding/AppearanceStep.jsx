import React, { useState } from 'react';
import { ArrowRight, Sun, Moon } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { SettingsTabs } from '../settings/SettingsTabs';
import { ColorOptionPreview } from '../settings/PreferencePreview';
import { AppearancePreview } from './AppearancePreview';

function Choice({ id, active, value, onPick, disabled, children }) {
  return <button type="button" data-testid={id} onClick={() => onPick(value)}
    disabled={disabled} aria-pressed={active === value}>{children}</button>;
}

// Tab changes only affect what is shown. Preferences keep using the same
// setters as Settings, and Continue never resets choices the user already made.
export function AppearanceStep({ onContinue }) {
  const t = useT();
  const [section, setSection] = useState('colors');
  const { theme, setTheme, palette, setPalette } = useThemeStore();
  const settings = useSettingsStore();
  const chat = settings.viewStyle === 'chat';
  const tabs = ['colors', 'layout', 'reading'].map(id => ({ id, label: t(`settings.appearance.section.${id}`) }));
  const groups = section === 'layout' ? [
    { id: 'view', key: 'viewStyle', setter: 'setViewStyle', label: 'workspace.mailExperience', options: [['list', 'workspace.emailView', 'workspace.emailViewHint'], ['chat', 'workspace.chatView', 'workspace.chatViewHint']] },
    { id: 'layout', key: 'layoutMode', setter: 'setLayoutMode', label: 'workspace.readingPane', disabled: chat, options: [['three-column', 'workspace.besideList', 'workspace.besideListHint'], ['two-column', 'workspace.belowList', 'workspace.belowListHint']] },
  ] : section === 'reading' ? [
    { id: 'density', key: 'emailListStyle', setter: 'setEmailListStyle', label: 'workspace.messageRows', disabled: chat, options: [['compact', 'workspace.twoLineRows', 'workspace.twoLineRowsHint'], ['default', 'workspace.singleLineRows', 'workspace.singleLineRowsHint']] },
    { id: 'threads', key: 'threadMode', setter: 'setThreadMode', label: 'settings.appearance.threadMode', disabled: chat, options: [['grouped', 'settings.appearance.threadModeGrouped', 'settings.appearance.threadModeGroupedHint'], ['expandable', 'settings.appearance.threadModeExpandable', 'settings.appearance.threadModeExpandableHint'], ['flat', 'onboarding.separateMessages', 'settings.appearance.threadModeFlatHint']] },
  ] : [];
  const applyRecommended = () => {
    setTheme('dark');
    setPalette('indigo');
    settings.setLayoutMode('three-column');
    settings.setSidebarStyle('list');
    settings.setSidebarLayout('stacked');
    settings.setViewStyle('list');
    settings.setEmailListStyle('compact');
    settings.setThreadMode('grouped');
    settings.setAfterDeleteSelect('none');
    settings.setEmailRowHighlight('hover');
  };

  return <div className="onboarding-appearance">
    <header className="onboarding-appearance-heading">
      <h2>{t('onboarding.appearanceTitle')}</h2>
      <p>{t('onboarding.appearanceSubtitle')}</p>
    </header>
    <SettingsTabs tabs={tabs} value={section} onChange={setSection} label={t('onboarding.appearanceTitle')}>
      <div className="onboarding-appearance-grid">
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
          {chat && section !== 'colors' && <p className="onboarding-choice-hint">{t('workspace.emailViewOnly')}</p>}
        </div>
        <div className="onboarding-appearance-example">
          <AppearancePreview layoutMode={settings.layoutMode} sidebarStyle={settings.sidebarStyle}
            viewStyle={settings.viewStyle} emailListStyle={settings.emailListStyle} threadMode={settings.threadMode}
            theme={theme} palette={palette} emailViewerTheme={settings.emailViewerTheme}
            highlight={settings.emailRowHighlight} actionButtonDisplay={settings.actionButtonDisplay} />
        </div>
      </div>
    </SettingsTabs>
    <footer className="onboarding-appearance-footer">
      <Button variant="ghost" size="sm" onClick={applyRecommended} data-testid="appearance-recommended">{t('onboarding.recommended')}</Button>
      <Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">{t('common.continue')}<ArrowRight size={14} /></Button>
    </footer>
    <p className="onboarding-appearance-note">{t('onboarding.moreInAppearance')}</p>
  </div>;
}
