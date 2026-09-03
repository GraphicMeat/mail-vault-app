import React from 'react';
import { ArrowRight, Sun, Moon, Wand2 } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { AppearancePreview } from './AppearancePreview';

/**
 * Six controls, chosen because the preview can prove each one. Date and time
 * format, action button style, signature display, thread sort and the viewer
 * theme all stay in Settings — none of them is a first-run decision.
 *
 * Writes land on the live stores immediately: the preview reads the same values
 * the app will, so Continue merely advances. No staging buffer to get wrong.
 */
function Choice({ id, active, value, onPick, children }) {
  return (
    <button
      type="button"
      data-testid={id}
      onClick={() => onPick(value)}
      className={`flex-1 px-2 py-1.5 rounded-lg border text-xs transition-colors
                  ${active === value
                    ? 'border-mail-accent bg-mail-accent/10 text-mail-accent-text'
                    : 'border-mail-border text-mail-text-muted hover:border-mail-accent/50'}`}
    >
      {children}
    </button>
  );
}

export function AppearanceStep({ onContinue }) {
  const t = useT();
  const theme = useThemeStore(s => s.theme);
  const toggleTheme = useThemeStore(s => s.toggleTheme);
  const setTheme = useThemeStore(s => s.setTheme);

  const layoutMode = useSettingsStore(s => s.layoutMode);
  const setLayoutMode = useSettingsStore(s => s.setLayoutMode);
  const sidebarStyle = useSettingsStore(s => s.sidebarStyle);
  const setSidebarStyle = useSettingsStore(s => s.setSidebarStyle);
  const viewStyle = useSettingsStore(s => s.viewStyle);
  const setViewStyle = useSettingsStore(s => s.setViewStyle);
  const emailListStyle = useSettingsStore(s => s.emailListStyle);
  const setEmailListStyle = useSettingsStore(s => s.setEmailListStyle);
  const threadMode = useSettingsStore(s => s.threadMode);
  const setThreadMode = useSettingsStore(s => s.setThreadMode);

  // The six values the app is actually designed around — the same set every
  // marketing screenshot is shot in. Written through the same setters the
  // controls use, so the preview and the persisted settings follow along.
  const applyRecommended = () => {
    setTheme('dark');
    setLayoutMode('three-column');
    setSidebarStyle('tagcloud');
    setViewStyle('list');
    setEmailListStyle('compact');
    setThreadMode('grouped');
  };

  return (
    <div className="max-w-4xl w-full">
      <h2 className="text-lg font-semibold text-mail-text mb-1">{t('onboarding.appearanceTitle')}</h2>
      <p className="text-xs text-mail-text-muted mb-4">{t('onboarding.appearanceSubtitle')}</p>

      <div className="grid md:grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
        <div className="space-y-3">
          <div data-testid="appearance-control-theme">
            <div className="text-xs font-medium text-mail-text mb-1">{t('settings.appearance.theme')}</div>
            <button type="button" data-testid="appearance-theme-toggle" onClick={toggleTheme}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-mail-border text-xs text-mail-text hover:border-mail-accent/50">
              {theme === 'dark' ? <Moon size={14} className="text-mail-accent-text" /> : <Sun size={14} className="text-mail-accent-text" />}
              {theme === 'dark' ? t('settings.appearance.alwaysDark') : t('settings.appearance.alwaysLight')}
            </button>
          </div>

          <div data-testid="appearance-control-layout">
            <div className="text-xs font-medium text-mail-text mb-1">{t('settings.appearance.layout')}</div>
            <div className="flex gap-1.5">
              <Choice id="appearance-layout-three-column" active={layoutMode} value="three-column" onPick={setLayoutMode}>{t('settings.appearance.threeColumns')}</Choice>
              <Choice id="appearance-layout-two-column" active={layoutMode} value="two-column" onPick={setLayoutMode}>{t('settings.appearance.twoColumns')}</Choice>
            </div>
          </div>

          <div data-testid="appearance-control-sidebar">
            <div className="text-xs font-medium text-mail-text mb-1">{t('settings.appearance.sidebarStyle')}</div>
            <div className="flex gap-1.5">
              <Choice id="appearance-sidebar-list" active={sidebarStyle} value="list" onPick={setSidebarStyle}>{t('settings.appearance.list')}</Choice>
              <Choice id="appearance-sidebar-tagcloud" active={sidebarStyle} value="tagcloud" onPick={setSidebarStyle}>{t('settings.appearance.tagCloud')}</Choice>
            </div>
          </div>

          <div data-testid="appearance-control-view">
            <div className="text-xs font-medium text-mail-text mb-1">{t('settings.appearance.viewStyle')}</div>
            <div className="flex gap-1.5">
              <Choice id="appearance-view-list" active={viewStyle} value="list" onPick={setViewStyle}>{t('settings.appearance.list')}</Choice>
              <Choice id="appearance-view-chat" active={viewStyle} value="chat" onPick={setViewStyle}>{t('settings.appearance.chatView')}</Choice>
            </div>
          </div>

          <div data-testid="appearance-control-density">
            <div className="text-xs font-medium text-mail-text mb-1">{t('onboarding.density')}</div>
            <div className="flex gap-1.5">
              <Choice id="appearance-density-compact" active={emailListStyle} value="compact" onPick={setEmailListStyle}>{t('onboarding.densityCompact')}</Choice>
              <Choice id="appearance-density-default" active={emailListStyle} value="default" onPick={setEmailListStyle}>{t('onboarding.densityDefault')}</Choice>
              <Choice id="appearance-density-comfortable" active={emailListStyle} value="comfortable" onPick={setEmailListStyle}>{t('onboarding.densityComfortable')}</Choice>
            </div>
          </div>

          <div data-testid="appearance-control-threads">
            <div className="text-xs font-medium text-mail-text mb-1">{t('settings.appearance.threadMode')}</div>
            <div className="flex gap-1.5">
              <Choice id="appearance-threads-grouped" active={threadMode} value="grouped" onPick={setThreadMode}>{t('settings.appearance.threadModeGrouped')}</Choice>
              <Choice id="appearance-threads-expandable" active={threadMode} value="expandable" onPick={setThreadMode}>{t('settings.appearance.threadModeExpandable')}</Choice>
              <Choice id="appearance-threads-flat" active={threadMode} value="flat" onPick={setThreadMode}>{t('settings.appearance.threadModeFlat')}</Choice>
            </div>
          </div>

          <p className="text-[10px] text-mail-text-muted">{t('onboarding.moreInAppearance')}</p>
        </div>

        <div>
          <AppearancePreview
            layoutMode={layoutMode}
            sidebarStyle={sidebarStyle}
            viewStyle={viewStyle}
            emailListStyle={emailListStyle}
          />
          <div className="flex items-center justify-between gap-2 mt-3">
            <Button variant="accentTint" size="lg" onClick={applyRecommended}
                    data-testid="appearance-recommended">
              <Wand2 size={14} />
              {t('onboarding.recommended')}
            </Button>
            <Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">
              {t('common.continue')}
              <ArrowRight size={14} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
