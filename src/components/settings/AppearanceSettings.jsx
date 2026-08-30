import React from 'react';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatEmailDate } from '../../utils/dateFormat';
import { ToggleSwitch } from './ToggleSwitch';
import {
  Sun,
  Moon,
  Palette,
  ChevronUp,
  ChevronDown,
  LayoutGrid,
  Columns,
  Rows,
  MessageSquare,
  List,
  PenTool,
} from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';

// The shell forces the stacked layout below 768px (App.jsx). Without this the
// three-column card would take a click and change nothing — a control that
// names an action it cannot perform.
const STACKED_BELOW = '(max-width: 767px)';
function useWindowIsNarrow() {
  const [narrow, setNarrow] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(STACKED_BELOW).matches,
  );
  React.useEffect(() => {
    const mq = window.matchMedia(STACKED_BELOW);
    const onChange = (e) => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    setNarrow(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export function AppearanceSettings() {
  const t = useT();
  const windowIsNarrow = useWindowIsNarrow();
  const { theme, toggleTheme } = useThemeStore();
  const {
    layoutMode,
    setLayoutMode,
    sidebarStyle,
    setSidebarStyle,
    viewStyle,
    setViewStyle,
    emailListStyle,
    setEmailListStyle,
    threadSortOrder,
    setThreadSortOrder,
    dateFormat,
    customDateFormat,
    timeFormat,
    setDateFormat,
    setCustomDateFormat,
    setTimeFormat,
    signatureDisplay,
    setSignatureDisplay,
    actionButtonDisplay,
    setActionButtonDisplay,
    emailViewerTheme,
    setEmailViewerTheme,
  } = useSettingsStore();

  return (
    <>
      {/* Appearance */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Palette size={18} className="text-mail-accent-text" />
          {t('settings.appearance.appearance')}
        </h4>

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-mail-text">{t('settings.appearance.theme')}</div>
              <div className="text-sm text-mail-text-muted">
                {t('settings.appearance.chooseBetweenLightDarkMode')}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Sun size={18} className={theme === 'light' ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
              <ToggleSwitch
                active={theme === 'dark'}
                onClick={toggleTheme}
              />
              <Moon size={18} className={theme === 'dark' ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
            </div>
          </div>

          {/* Email viewer theme — how email bodies render, independent of app theme */}
          <div className="pt-4 border-t border-mail-border">
            <div className="font-medium text-mail-text mb-1">{t('settings.appearance.emailViewerTheme')}</div>
            <div className="text-sm text-mail-text-muted mb-3">
              Some people prefer a dark app but like reading emails in light mode. Set the default theme for email content here — the per-email Light/Dark button always overrides.
            </div>
            <select
              value={emailViewerTheme}
              onChange={(e) => setEmailViewerTheme(e.target.value)}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all cursor-pointer"
            >
              <option value="system">{t('settings.appearance.matchAppTheme')}</option>
              <option value="light">{t('settings.appearance.alwaysLight')}</option>
              <option value="dark">{t('settings.appearance.alwaysDark')}</option>
            </select>
          </div>

          {/* Date Format */}
          <div className="pt-4 border-t border-mail-border">
            <div className="font-medium text-mail-text mb-1">{t('settings.appearance.dateFormat')}</div>
            <div className="text-sm text-mail-text-muted mb-3">
              {t('settings.appearance.controlsHowDatesAppearEmail')}
            </div>
            <select
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all cursor-pointer"
            >
              <option value="auto">System Default ({navigator.language})</option>
              <option value="MM/dd/yyyy">MM/DD/YYYY (US)</option>
              <option value="dd/MM/yyyy">DD/MM/YYYY (Europe)</option>
              <option value="yyyy-MM-dd">YYYY-MM-DD (ISO)</option>
              <option value="dd MMM yyyy">DD MMM YYYY (e.g., 25 Feb 2024)</option>
              <option value="custom">{t('settings.appearance.custom')}</option>
            </select>
            {dateFormat === 'custom' && (
              <div className="mt-3">
                <input
                  type="text"
                  value={customDateFormat}
                  onChange={(e) => setCustomDateFormat(e.target.value)}
                  placeholder={t('settings.appearance.eGDdMmYyyy')}
                  className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all"
                />
                <p className="text-xs text-mail-text-muted mt-1">
                  Uses date-fns tokens: yyyy=year, MM=month, dd=day, HH=hour, mm=minute
                </p>
              </div>
            )}
            <div className="mt-2 flex items-center gap-4 text-xs text-mail-text-muted">
              <span>{t('settings.appearance.today')} <span className="text-mail-text">{formatEmailDate(new Date().toISOString())}</span></span>
              <span>{t('settings.appearance.older')} <span className="text-mail-text">{formatEmailDate('2023-06-15T10:00:00Z')}</span></span>
            </div>
          </div>

          {/* Time Format */}
          <div className="pt-4 border-t border-mail-border">
            <div className="font-medium text-mail-text mb-1">{t('settings.appearance.timeFormat')}</div>
            <div className="text-sm text-mail-text-muted mb-3">
              {t('settings.appearance.controlsHowTimesAppearAcross')}
            </div>
            <select
              value={timeFormat}
              onChange={(e) => setTimeFormat(e.target.value)}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all cursor-pointer"
            >
              <option value="auto">System Default ({navigator.language})</option>
              <option value="12h">12-hour (2:30 PM)</option>
              <option value="24h">24-hour (14:30)</option>
            </select>
            <div className="mt-2 text-xs text-mail-text-muted">
              {t('settings.appearance.now')} <span className="text-mail-text">{formatEmailDate(new Date().toISOString())}</span>
            </div>
          </div>

          {/* Action Button Style */}
          <div className="pt-4 border-t border-mail-border">
            <div className="font-medium text-mail-text mb-1">{t('settings.appearance.actionButtonStyle')}</div>
            <div className="text-sm text-mail-text-muted mb-3">
              {t('settings.appearance.chooseHowEmailActionButtons')}
            </div>
            <select
              value={actionButtonDisplay}
              onChange={(e) => setActionButtonDisplay(e.target.value)}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent transition-all cursor-pointer"
            >
              <option value="icon-only">{t('settings.appearance.iconsOnly')}</option>
              <option value="icon-label">{t('settings.appearance.iconsLabels')}</option>
              <option value="text-only">{t('settings.appearance.labelsOnly')}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Layout */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <LayoutGrid size={18} className="text-mail-accent-text" />
          {t('settings.appearance.layout')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.appearance.chooseHowEmailsDisplayedDrag')}
        </p>

        {windowIsNarrow && (
          <p className="text-sm text-mail-text-muted mb-4 border-l border-mail-border pl-3">
            {t('settings.appearance.windowTooNarrowForThreeColumns')}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setLayoutMode('three-column')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${layoutMode === 'three-column'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="flex gap-1 w-full h-12">
              <div className="w-1/4 bg-mail-border rounded" />
              <div className="w-1/3 bg-mail-border rounded" />
              <div className="flex-1 bg-mail-border rounded" />
            </div>
            <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
              <Columns size={16} />
              {t('settings.appearance.threeColumns')}
            </div>
            <span className="text-xs text-mail-text-muted">
              Sidebar | List | Content
            </span>
          </button>

          <button
            onClick={() => setLayoutMode('two-column')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${layoutMode === 'two-column'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="flex gap-1 w-full h-12">
              <div className="w-1/4 bg-mail-border rounded" />
              <div className="flex-1 flex flex-col gap-1">
                <div className="h-1/2 bg-mail-border rounded" />
                <div className="h-1/2 bg-mail-border rounded" />
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
              <Rows size={16} />
              {t('settings.appearance.twoColumns')}
            </div>
            <span className="text-xs text-mail-text-muted">
              {t('settings.appearance.listAboveContent')}
            </span>
          </button>
        </div>
      </div>

      {/* Sidebar Style */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <LayoutGrid size={18} className="text-mail-accent-text" />
          {t('settings.appearance.sidebarStyle')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.appearance.howAccountsFoldersAppearSidebar')}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setSidebarStyle('list')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${sidebarStyle === 'list'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="w-full h-12 flex flex-col gap-1 justify-center">
              <div className="h-2 bg-mail-border rounded w-full" />
              <div className="h-2 bg-mail-border rounded w-5/6" />
              <div className="h-2 bg-mail-border rounded w-full" />
              <div className="h-2 bg-mail-border rounded w-4/6" />
            </div>
            <span className="text-sm font-medium text-mail-text">{t('settings.appearance.list')}</span>
            <span className="text-xs text-mail-text-muted">{t('settings.appearance.oneRowPerItem')}</span>
          </button>

          <button
            onClick={() => setSidebarStyle('tagcloud')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${sidebarStyle === 'tagcloud'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="w-full h-12 flex flex-wrap gap-1 content-center items-center">
              <div className="h-2.5 bg-mail-border rounded-full w-10" />
              <div className="h-2.5 bg-mail-accent/40 rounded-full w-8" />
              <div className="h-2.5 bg-mail-border rounded-full w-12" />
              <div className="h-2.5 bg-mail-border rounded-full w-6" />
              <div className="h-2.5 bg-mail-border rounded-full w-10" />
              <div className="h-2.5 bg-mail-border rounded-full w-8" />
            </div>
            <span className="text-sm font-medium text-mail-text">{t('settings.appearance.tagCloud')}</span>
            <span className="text-xs text-mail-text-muted">{t('settings.appearance.compactBubbles')}</span>
          </button>
        </div>
      </div>

      {/* View Style */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <MessageSquare size={18} className="text-mail-accent-text" />
          {t('settings.appearance.viewStyle')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.appearance.chooseHowDisplayEmailsTraditional')}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setViewStyle('list')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${viewStyle === 'list'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="w-full h-12 flex flex-col gap-1">
              <div className="h-3 bg-mail-border rounded w-full" />
              <div className="h-3 bg-mail-border rounded w-full" />
              <div className="h-3 bg-mail-border rounded w-3/4" />
            </div>
            <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
              <List size={16} />
              {t('settings.appearance.listView')}
            </div>
            <span className="text-xs text-mail-text-muted">
              {t('settings.appearance.traditionalEmailList')}
            </span>
          </button>

          <button
            onClick={() => setViewStyle('chat')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${viewStyle === 'chat'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="w-full h-12 flex flex-col justify-end gap-1">
              <div className="h-2.5 bg-mail-border rounded-full w-2/3 self-start" />
              <div className="h-2.5 bg-mail-accent/30 rounded-full w-1/2 self-end" />
              <div className="h-2.5 bg-mail-border rounded-full w-3/5 self-start" />
            </div>
            <div className="flex items-center gap-2 text-sm font-medium text-mail-text">
              <MessageSquare size={16} />
              {t('settings.appearance.chatView')}
            </div>
            <span className="text-xs text-mail-text-muted">
              {t('settings.appearance.conversationStyle')}
            </span>
          </button>
        </div>
      </div>

      {/* Email List Style */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <List size={18} className="text-mail-accent-text" />
          {t('settings.appearance.emailListStyle')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.appearance.chooseHowEmailsAppearList')}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setEmailListStyle('default')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${emailListStyle === 'default'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="w-full h-12 flex flex-col gap-1.5 justify-center">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 bg-mail-border rounded-sm flex-shrink-0" />
                <div className="h-2 bg-mail-border rounded flex-1" />
                <div className="h-2 bg-mail-border rounded w-8" />
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 bg-mail-border rounded-sm flex-shrink-0" />
                <div className="h-2 bg-mail-border rounded flex-1" />
                <div className="h-2 bg-mail-border rounded w-8" />
              </div>
            </div>
            <span className="text-sm font-medium text-mail-text">{t('settings.appearance.default')}</span>
            <span className="text-xs text-mail-text-muted">{t('settings.appearance.singleLinePerEmail')}</span>
          </button>

          <button
            onClick={() => setEmailListStyle('compact')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${emailListStyle === 'compact'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <div className="w-full h-12 flex flex-col gap-0.5 justify-center">
              <div className="flex items-center gap-1">
                <div className="h-1.5 bg-mail-text-muted/30 rounded w-16" />
                <div className="h-1.5 bg-mail-border rounded w-6 ml-auto" />
              </div>
              <div className="h-2 bg-mail-border rounded w-full" />
              <div className="h-px bg-mail-border/50 w-full mt-0.5" />
              <div className="flex items-center gap-1">
                <div className="h-1.5 bg-mail-text-muted/30 rounded w-12" />
                <div className="h-1.5 bg-mail-border rounded w-6 ml-auto" />
              </div>
              <div className="h-2 bg-mail-border rounded w-3/4" />
            </div>
            <span className="text-sm font-medium text-mail-text">{t('settings.appearance.compact')}</span>
            <span className="text-xs text-mail-text-muted">Sender + subject on two lines</span>
          </button>
        </div>
      </div>

      {/* Thread Sort Order */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <List size={18} className="text-mail-accent-text" />
          {t('settings.appearance.threadSortOrder')}
        </h4>
        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.appearance.chooseHowEmailsOrderedWithin')}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setThreadSortOrder('oldest-first')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${threadSortOrder === 'oldest-first'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <ChevronDown size={24} className="text-mail-text-muted" />
            <span className="text-sm font-medium text-mail-text">{t('settings.appearance.oldestFirst')}</span>
            <span className="text-xs text-mail-text-muted">{t('settings.appearance.conversationFlowsTopBottom')}</span>
          </button>
          <button
            onClick={() => setThreadSortOrder('newest-first')}
            className={`p-4 rounded-lg border-2 transition-all flex flex-col items-center gap-3
                      ${threadSortOrder === 'newest-first'
                        ? 'border-mail-accent bg-mail-accent/10'
                        : 'border-mail-border hover:border-mail-accent/50'}`}
          >
            <ChevronUp size={24} className="text-mail-text-muted" />
            <span className="text-sm font-medium text-mail-text">{t('settings.appearance.newestFirst')}</span>
            <span className="text-xs text-mail-text-muted">{t('settings.appearance.latestReplyTop')}</span>
          </button>
        </div>
      </div>

      {/* Signature Display */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <PenTool size={18} className="text-mail-accent-text" />
          {t('settings.appearance.signatureDisplay')}
        </h4>
        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.appearance.controlHowEmailSignaturesAppear')}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { value: 'smart', label: t('settings.appearance.smart'), desc: t('settings.appearance.showOncePerSenderCollapse') },
            { value: 'always-show', label: t('settings.appearance.alwaysShow'), desc: t('settings.appearance.neverCollapseSignatures') },
            { value: 'always-hide', label: t('settings.appearance.alwaysHide'), desc: t('settings.appearance.collapseAllSignatures') },
            { value: 'collapsed', label: t('settings.appearance.collapsed'), desc: t('settings.appearance.collapsedToggleExpand') },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setSignatureDisplay(opt.value)}
              className={`p-3 rounded-lg border-2 transition-all text-left
                ${signatureDisplay === opt.value
                  ? 'border-mail-accent bg-mail-accent/10'
                  : 'border-mail-border hover:border-mail-accent/50'}`}
            >
              <span className="text-sm font-medium text-mail-text block">{opt.label}</span>
              <span className="text-xs text-mail-text-muted">{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
