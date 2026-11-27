import React, { useEffect, useState } from 'react';
import { ArrowRight, Moon, Sun } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { SIDEBAR_LAYOUTS } from '../../utils/sidebarLayouts';
import { useThemeStore, PALETTES } from '../../stores/themeStore';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { SettingsTabs } from '../ui/SettingsTabs';
import { QuickActionModeTiles, QuickActionPresets, QuickActionSample } from '../settings/QuickActionSamples';
import { TextSizeChoice } from '../settings/TextSettings';
import { AppearancePreview } from './AppearancePreview';
import { OnboardingScreen } from './OnboardingScreen';
import { NOTIFICATION_SOUNDS, normalizeNotificationSound } from '../../utils/notificationSounds';
import { previewNotificationSound } from '../../services/api';
import { DEFAULT_QUICK_ACTIONS, normalizeQuickActions, QUICK_ACTION_SURFACES } from '../../utils/quickActions';
import { useQuickActionSamples } from '../../hooks/useQuickActionSamples';
import { APP_FONTS, fontStack } from '../../utils/appFont';
import { googleFamilyOf, googleFontId } from '../../utils/googleFonts';
import { refreshFonts, useFontStore } from '../../services/fontService';

// The quick actions tab, for the row a pointer rests on: how its actions show,
// and whose set to start from. Each action is fine-tuned later in Settings.
// The sample is read when this tab opens, the last one, so a first run's new
// account has had the longest to cache some mail.
function QuickActionsSection() {
  const t = useT();
  const quickActions = useSettingsStore(state => state.quickActions);
  const setStyle = useSettingsStore(state => state.setQuickActionStyle);
  const config = normalizeQuickActions(quickActions).defaults.row;
  const rows = useQuickActionSamples();
  return <div className="onboarding-appearance-grid">
    <div className="onboarding-appearance-controls">
      <fieldset data-testid="appearance-control-quick-layout">
        <legend>{t('onboarding.quickActionsShows')}</legend>
        <QuickActionModeTiles value={config.mode} onChange={mode => setStyle('row', null, { mode })} />
      </fieldset>
      <fieldset data-testid="appearance-control-quick-presets">
        <QuickActionPresets scope={null} />
      </fieldset>
      <p className="onboarding-choice-hint">{t('onboarding.quick-actionsHint')}</p>
    </div>
    <div className="onboarding-appearance-example">
      <QuickActionSample surface="row" config={config} rows={rows} />
    </div>
  </div>;
}

function Choice({ id, active, value, onPick, disabled, className, children }) {
  return <button type="button" data-testid={id} onClick={() => onPick(value)} className={className}
    disabled={disabled} aria-pressed={active === value}>{children}</button>;
}

// The app font as one menu: bundled faces, then any already downloaded. New
// downloads are a Settings matter (they reach Google Fonts, which says so there).
function FontMenu({ value, onChange }) {
  const t = useT();
  const installed = useFontStore(s => s.installed);
  useEffect(() => { void refreshFonts(); }, []);
  const current = googleFamilyOf(value);
  const downloaded = current && !installed.includes(current) ? [...installed, current] : installed;
  const fonts = [...APP_FONTS.map(font => ({ id: font.id, name: font.family || t('settings.text.systemFont') })),
    ...downloaded.map(family => ({ id: googleFontId(family), name: family }))];
  return <select className="onboarding-select" aria-label={t('settings.text.font')} value={value}
    onChange={event => onChange(event.target.value)} style={{ fontFamily: fontStack(value) }}>
    {fonts.map(font => <option key={font.id} value={font.id} style={{ fontFamily: fontStack(font.id) }}>{font.name}</option>)}
  </select>;
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
  // `pic`: the option drawn as a small picture of the window above its name.
  const groups = section === 'layout' ? [
    { id: 'layout', key: 'layoutMode', setter: 'setLayoutMode', label: 'workspace.readingPane', disabled: chat, pic: true, options: [['three-column', 'workspace.besideList', 'workspace.besideListHint'], ['two-column', 'workspace.belowList', 'workspace.belowListHint']] },
    { id: 'view', key: 'viewStyle', setter: 'setViewStyle', label: 'workspace.mailExperience', options: [['list', 'workspace.emailView', 'workspace.emailViewHint'], ['chat', 'workspace.chatView', 'workspace.chatViewHint']] },
    // Same choices as Settings; the sidebar works the same in the chat view.
    { id: 'sidebar-layout', key: 'sidebarLayout', setter: 'setSidebarLayout', label: 'workspace.sidebarLayout', wrap: true, options: SIDEBAR_LAYOUTS.map(value => {
      const suffix = value[0].toUpperCase() + value.slice(1);
      return [value, `workspace.sidebarLayout${suffix}`, `workspace.sidebarLayout${suffix}Hint`];
    }) },
  ] : section === 'reading' ? [
    { id: 'density', key: 'emailListStyle', setter: 'setEmailListStyle', label: 'workspace.messageRows', disabled: chat, pic: true, options: [['compact', 'workspace.twoLineRows', 'workspace.twoLineRowsHint'], ['default', 'workspace.singleLineRows', 'workspace.singleLineRowsHint']] },
    { id: 'threads', key: 'threadMode', setter: 'setThreadMode', label: 'settings.appearance.threadMode', disabled: chat, options: [['grouped', 'settings.appearance.threadModeGrouped', 'settings.appearance.threadModeGroupedHint'], ['expandable', 'settings.appearance.threadModeExpandable', 'settings.appearance.threadModeExpandableHint'], ['flat', 'onboarding.separateMessages', 'settings.appearance.threadModeFlatHint']] },
  ] : [];
  // Deleting has its own step: Use recommended never changes it from here.
  const applyRecommended = () => {
    setTheme('dark');
    setPalette('graphite');
    settings.setLayoutMode('three-column');
    settings.setSidebarStyle('list');
    settings.setSidebarLayout('stacked');
    settings.setViewStyle('list');
    settings.setEmailListStyle('compact');
    settings.setThreadMode('expandable');
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

  return <OnboardingScreen className="onboarding-appearance" title={t('onboarding.appearanceTitle')} subtitle={t('onboarding.appearanceSubtitle')}
    secondary={<Button variant="ghost" size="sm" onClick={applyRecommended} data-testid="appearance-recommended">{t('onboarding.recommended')}</Button>}
    primary={nextSection
      ? <Button variant="primary" size="lg" onClick={() => setSection(nextSection)} data-testid="appearance-next">{t('common.next')}<ArrowRight size={14} /></Button>
      : <Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">{t('common.continue')}<ArrowRight size={14} /></Button>}>
    <SettingsTabs tabs={tabs} value={section} onChange={setSection} label={t('onboarding.appearanceTitle')}>
      {section === 'quick-actions' ? <QuickActionsSection /> : <div className="onboarding-appearance-grid">
        <div className="onboarding-appearance-controls">
          {section === 'colors' && <>
            <fieldset data-testid="appearance-control-theme">
              <legend>{t('settings.appearance.theme')}</legend>
              <div className="onboarding-choices">
                {[[Sun, 'light'], [Moon, 'dark']].map(([Icon, value]) => <Choice key={value} id={`appearance-theme-${value}`} active={theme} value={value} onPick={setTheme}><Icon size={15} aria-hidden="true" />{t(`settings.colors.${value}`)}</Choice>)}
              </div>
            </fieldset>
            <fieldset data-testid="appearance-control-palette">
              <legend>{t('settings.colors.palette')}</legend>
              <div className="onboarding-swatches">
                {PALETTES.map(value => <Choice key={value} id={`appearance-palette-${value}`} active={palette} value={value} onPick={setPalette} className="onboarding-swatch">
                  <span className="onboarding-swatch-dot" data-palette={value} aria-hidden="true" />
                  <span className="onboarding-swatch-name">{t(`settings.colors.${value}`)}</span>
                </Choice>)}
              </div>
            </fieldset>
            <fieldset data-testid="appearance-control-font">
              <legend>{t('settings.text.font')}</legend>
              <FontMenu value={settings.appFont} onChange={settings.setAppFont} />
            </fieldset>
            <fieldset data-testid="appearance-control-text-size">
              <legend>{t('settings.text.size')}</legend>
              <TextSizeChoice label={t('settings.text.size')} value={settings.textScale} onChange={settings.setTextScale} />
            </fieldset>
          </>}
          {groups.map(({ id, key, setter, label, disabled, options, pic, wrap }) => {
            const value = key === 'emailListStyle' && settings[key] !== 'compact' ? 'default' : settings[key];
            const hint = options.find(([option]) => option === value)?.[2];
            return <fieldset key={id} data-testid={`appearance-control-${id}`}>
              <legend>{t(label)}</legend>
              <div className={`onboarding-choices${pic ? ' onboarding-pictures' : ''}${wrap ? ' onboarding-choices-wrap' : ''}`}>
                {options.map(([option, text]) => <Choice key={option} id={`appearance-${id}-${option}`} active={value} value={option} onPick={settings[setter]} disabled={disabled}>
                  {pic && <span className="onboarding-pic" data-pic={option} aria-hidden="true"><i /><i /><i /><i /></span>}
                  <span>{t(text)}</span>
                </Choice>)}
              </div>
              {!disabled && hint && <p className="onboarding-choice-hint">{t(hint)}</p>}
            </fieldset>;
          })}
          {/* Same gate as Settings: a sound with notifications off never plays.
              Picking one plays it, which is the preview. */}
          {section === 'reading' && isMac() && settings.notificationSettings?.enabled && <fieldset data-testid="appearance-control-sound">
            <legend>{t('settings.notifications.newEmailSound')}</legend>
            <select className="onboarding-select" data-testid="appearance-sound" aria-label={t('settings.notifications.newEmailSound')}
              value={normalizeNotificationSound(settings.notificationSettings.sound)}
              onChange={event => {
                const sound = event.target.value;
                settings.setNotificationSound(sound);
                if (sound !== 'none') previewNotificationSound(sound).catch(() => {});
              }}>
              {['none', ...NOTIFICATION_SOUNDS].map(value => <option key={value} value={value}>
                {value === 'none' ? t('settings.notifications.soundOff') : value}
              </option>)}
            </select>
          </fieldset>}
          {chat && ['layout', 'reading'].includes(section) && <p className="onboarding-choice-hint">{t('workspace.emailViewOnly')}</p>}
        </div>
        <div className="onboarding-appearance-example">
          <AppearancePreview layoutMode={settings.layoutMode} sidebarStyle={settings.sidebarStyle} sidebarLayout={settings.sidebarLayout}
            viewStyle={settings.viewStyle} emailListStyle={settings.emailListStyle} threadMode={settings.threadMode}
            theme={theme} palette={palette} emailViewerTheme={settings.emailViewerTheme}
            highlight={settings.emailRowHighlight} actionButtonDisplay={settings.actionButtonDisplay} appFont={settings.appFont} />
        </div>
      </div>}
    </SettingsTabs>
  </OnboardingScreen>;
}
