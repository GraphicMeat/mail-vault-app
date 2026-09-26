import React, { useState } from 'react';
import { Archive, ArchiveRestore, ArrowRight, Code, ExternalLink, FileText, FolderInput, Forward, ImageDown, Mail, MailOpen, MailPlus, Moon, Reply, ReplyAll, ShieldAlert, ShieldX, Star, StarOff, Sun, Tag, Trash2 } from 'lucide-react';
import { useTagStore } from '../../stores/tagStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { SettingsTabs } from '../ui/SettingsTabs';
import { SegmentedChoice } from '../ui/SegmentedChoice';
import { QuickActions } from '../QuickActions';
import { ColorOptionPreview } from '../settings/PreferencePreview';
import { AppearancePreview } from './AppearancePreview';
import { DEFAULT_QUICK_ACTIONS, isQuickActionStyleLinked, normalizeQuickActions, QUICK_ACTION_MODES, QUICK_ACTION_SURFACES } from '../../utils/quickActions';

const QUICK_ACTION_ICONS = { archive: Archive, unarchive: ArchiveRestore, delete: Trash2, deleteServer: Trash2, deleteEverywhere: ShieldX, toggleRead: MailOpen, markRead: MailOpen, markUnread: Mail, star: Star, unstar: StarOff, tag: Tag, move: FolderInput, spam: ShieldAlert, reply: Reply, replyAll: ReplyAll, forward: Forward, replyTemplate: FileText, export: ImageDown, newMessage: MailPlus, open: ExternalLink, source: Code, theme: Moon };
const QUICK_ACTION_LABELS = { archive: 'common.archive', unarchive: 'rowMenu.unarchive', delete: 'common.delete', deleteServer: 'rowMenu.deleteServer', deleteEverywhere: 'rowMenu.deleteEverywhere', toggleRead: 'quickActions.action.toggleRead', markRead: 'rowMenu.markRead', markUnread: 'rowMenu.markUnread', star: 'rowMenu.star', unstar: 'rowMenu.unstar', tag: 'quickActions.action.tag', move: 'quickActions.action.move', spam: 'quickActions.action.spam', reply: 'emailActionBar.reply', replyAll: 'emailActionBar.replyAll', forward: 'emailActionBar.forward', replyTemplate: 'quickActions.action.replyTemplate', export: 'common.export', newMessage: 'quickActions.action.newMessage', open: 'common.open', source: 'emailActionBar.source', theme: 'emailActionBar.dark' };

function Choice({ id, active, value, onPick, disabled, children }) {
  return <button type="button" data-testid={id} onClick={() => onPick(value)}
    disabled={disabled} aria-pressed={active === value}>{children}</button>;
}

const SECTIONS = ['colors', 'layout', 'reading', 'quick-actions'];

// Tab changes only affect what is shown. Preferences keep using the same
// setters as Settings, and Continue never resets choices the user already made.
// The primary button walks the tabs (Next) and only the last one offers Continue.
export function AppearanceStep({ onContinue }) {
  const t = useT();
  const [section, setSection] = useState('colors');
  const { theme, setTheme, palette, setPalette } = useThemeStore();
  const settings = useSettingsStore();
  const tags = useTagStore(state => state.tags) || [];
  const [quickSurface, setQuickSurface] = useState('row');
  const chat = settings.viewStyle === 'chat';
  const nextSection = SECTIONS[SECTIONS.indexOf(section) + 1];
  const tabs = SECTIONS.map(id => ({ id, label: id === 'quick-actions' ? t('quickActions.title') : t(`settings.appearance.section.${id}`) }));
  const quickActions = normalizeQuickActions(settings.quickActions);
  const quickConfig = quickActions.defaults[quickSurface];
  const quickStyleLinked = isQuickActionStyleLinked(quickActions);
  const quickActionLabel = entry => {
    if (entry.action === 'tag') return tags.find(tag => tag.id === entry.params?.tagId)?.name || t(QUICK_ACTION_LABELS.tag);
    if (entry.action === 'move' && entry.params?.mailbox) return `${t(QUICK_ACTION_LABELS.move)}: ${entry.params.mailbox}`;
    if (entry.action === 'replyTemplate') return settings.emailTemplates?.find(template => template.id === entry.params?.templateId)?.name || t(QUICK_ACTION_LABELS.replyTemplate);
    return t(QUICK_ACTION_LABELS[entry.action] || 'quickActions.title');
  };
  const quickDescriptors = quickConfig.entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    label: quickActionLabel(entry),
    Icon: QUICK_ACTION_ICONS[entry.action] || Archive,
    onActivate: () => {},
  }));
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
    QUICK_ACTION_SURFACES.forEach(surface => {
      const defaults = DEFAULT_QUICK_ACTIONS.defaults[surface];
      settings.setQuickActionStyle(surface, null, {
        mode: defaults.mode,
        palette: defaults.palette,
        radialPagination: defaults.radialPagination,
      });
    });
  };

  return <div className="onboarding-appearance">
    <header className="onboarding-appearance-heading">
      <h2>{t('onboarding.appearanceTitle')}</h2>
      <p>{t('onboarding.appearanceSubtitle')}</p>
    </header>
    <SettingsTabs tabs={tabs} value={section} onChange={setSection} label={t('onboarding.appearanceTitle')}>
      <div className={`onboarding-appearance-grid ${section === 'quick-actions' ? 'onboarding-quick-actions-grid' : ''}`}>
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
          {section === 'quick-actions' && <>
            <fieldset data-testid="appearance-control-quick-surface">
              <legend>{t('quickActions.surface')}</legend>
              <SegmentedChoice label={t('quickActions.surface')} value={quickSurface} onChange={setQuickSurface}
                options={QUICK_ACTION_SURFACES.map(value => ({ value, label: t(`quickActions.surface.${value}`) }))} />
            </fieldset>
            <fieldset data-testid="appearance-control-quick-layout">
              <legend>{t('quickActions.layout')}</legend>
              <SegmentedChoice label={t('quickActions.layout')} value={quickConfig.mode}
                onChange={mode => settings.setQuickActionStyle(quickSurface, null, { mode })}
                options={QUICK_ACTION_MODES.map(value => ({ value, label: t(`quickActions.layout.${value === 'favorite-menu' ? 'favoriteMenu' : value}`) }))} />
            </fieldset>
            <fieldset data-testid="appearance-control-quick-palette">
              <legend>{t('quickActions.palette')}</legend>
              <SegmentedChoice label={t('quickActions.palette')} value={quickConfig.palette}
                onChange={palette => settings.setQuickActionStyle(quickSurface, null, { palette })}
                options={['neutral', 'semantic', 'custom'].map(value => ({ value, label: t(`quickActions.palette.${value}`) }))} />
            </fieldset>
            <fieldset data-testid="appearance-control-quick-link">
              <legend>{t('quickActions.styleAcrossSurfaces')}</legend>
              <SegmentedChoice label={t('quickActions.styleAcrossSurfaces')} value={quickStyleLinked ? 'linked' : 'separate'}
                onChange={value => settings.setQuickActionStyleLink(null, value === 'linked', quickSurface)}
                options={[{ value: 'separate', label: t('quickActions.styleSeparate') }, { value: 'linked', label: t('quickActions.styleLinked') }]} />
            </fieldset>
            {quickConfig.mode === 'radial' && <fieldset data-testid="appearance-control-quick-pagination">
              <legend>{t('quickActions.radialPagination')}</legend>
              <SegmentedChoice label={t('quickActions.radialPagination')} value={quickConfig.radialPagination ? 'pages' : 'all'}
                onChange={value => settings.setQuickActionStyle(quickSurface, null, { radialPagination: value === 'pages' })}
                options={[{ value: 'all', label: t('quickActions.radialPagination.all') }, { value: 'pages', label: t('quickActions.radialPagination.pages') }]} />
            </fieldset>}
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
          {chat && ['layout', 'reading'].includes(section) && <p className="onboarding-choice-hint">{t('workspace.emailViewOnly')}</p>}
        </div>
        <div className="onboarding-appearance-example">
          {section === 'quick-actions'
            ? <section className="onboarding-quick-actions-preview" aria-labelledby="onboarding-quick-actions-preview-title">
              <div><h3 id="onboarding-quick-actions-preview-title">{t('quickActions.preview')}</h3><p>{t('quickActions.previewDescription')}</p></div>
              <div className="onboarding-quick-actions-surface" data-radial={quickConfig.mode === 'radial'}>
                <span className="onboarding-quick-actions-label">{t(`quickActions.surface.${quickSurface}`)}</span>
                <QuickActions
                  surface={quickSurface}
                  config={quickConfig}
                  descriptors={quickDescriptors}
                  display={quickSurface === 'selection' ? quickConfig.selectionDisplay || 'icon-label' : undefined}
                  inlineLimit={quickSurface === 'selection' && quickConfig.selectionDisplay !== 'icon-only' ? quickConfig.selectionActionLimit || 3 : undefined}
                  className="onboarding-quick-actions"
                  preview
                  identity={`onboarding:${quickSurface}:${quickConfig.mode}`}
                />
              </div>
            </section>
            : <AppearancePreview layoutMode={settings.layoutMode} sidebarStyle={settings.sidebarStyle}
            viewStyle={settings.viewStyle} emailListStyle={settings.emailListStyle} threadMode={settings.threadMode}
            theme={theme} palette={palette} emailViewerTheme={settings.emailViewerTheme}
            highlight={settings.emailRowHighlight} actionButtonDisplay={settings.actionButtonDisplay} />}
        </div>
      </div>
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
