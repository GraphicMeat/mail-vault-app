// Settings > Appearance > Layout as a view. `values`: the layout settings by key; `onChange(key,
// value)` sets one. `rows`: the keys this app shows (desktop all; the phone those a phone layout
// has). `preview`: the extra props WorkspacePreviewView draws with (sample accounts, chat sample,
// the app's own list rows). `hintKeys`: catalog keys a host uses in place of an option's own hint
// (`'<row key>.<value>'` to a key), where desktop's wording names a pointer the host has not got.
// Message list density and preview lines sit together and share one sample, under the pair. A
// hint that follows the choice keeps the height of its longest, so a change moves nothing.
import React, { useId } from 'react';
import { Check, Columns, Rows } from 'lucide-react';
import { SettingRow } from '../../ui/SettingRow';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { SidebarLayoutPreview, WorkspacePreviewView } from './PreviewViews';
import { SIDEBAR_LAYOUTS } from '../../../utils/sidebarLayouts';
import { useT } from './viewContext';

const PREVIEW_LINE_CHOICES = [[0, 'listPreview.off'], [1, 'listPreview.one'], [2, 'listPreview.two'], [3, 'listPreview.three']];

const GROUPS = [
  { key: 'viewStyle', titleKey: 'workspace.mailExperience',
    options: [['list', 'emailView', 'emailViewHint'], ['chat', 'chatView', 'chatViewHint']] },
  { key: 'layoutMode', titleKey: 'workspace.readingPane', chatDisables: true,
    options: [['three-column', 'besideList', 'besideListHint', Columns], ['two-column', 'belowList', 'belowListHint', Rows]] },
  { key: 'sidebarLayout', titleKey: 'workspace.sidebarLayout' },
  { key: 'sidebarDensity', titleKey: 'workspace.sidebarDensity',
    options: [['comfortable', 'sidebarDensityComfortable', 'sidebarDensityComfortableHint'], ['compact', 'sidebarDensityCompact', 'sidebarDensityCompactHint']] },
  // The message list's rows, the same two choices beside the sidebar's, then their preview lines.
  { key: 'listDensity', titleKey: 'workspace.listDensity', chatDisables: true,
    options: [['comfortable', 'sidebarDensityComfortable', 'listDensityComfortableHint'], ['compact', 'sidebarDensityCompact', 'listDensityCompactHint']] },
  { key: 'listPreviewLines', titleKey: 'listPreview.title', chatDisables: true },
  { key: 'folderIconStyle', titleKey: 'workspace.folderIcons',
    options: [['colorful', 'folderIconsColorful', 'folderIconsColorfulHint'], ['theme', 'folderIconsTheme', 'folderIconsThemeHint']] },
  { key: 'sidebarBackupStatusLocation', titleKey: 'workspace.backupStatusLocation',
    options: [['avatar', 'backupStatusAvatar', 'backupStatusAvatarHint'], ['row', 'backupStatusRow', 'backupStatusRowHint'], ['hidden', 'backupStatusHidden', 'backupStatusHiddenHint']] },
  { key: 'sidebarStyle', titleKey: 'workspace.navigation',
    options: [['list', 'navigationList', 'navigationListHint'], ['tagcloud', 'navigationBubbles', 'navigationBubblesHint']] },
  { key: 'emailListStyle', titleKey: 'workspace.messageRows', chatDisables: true,
    options: [['compact', 'twoLineRows', 'twoLineRowsHint'], ['default', 'singleLineRows', 'singleLineRowsHint']] },
];
export const WORKSPACE_ROWS = [...GROUPS.map(group => group.key), 'showMenuBar'];

/** The hint of the current choice among all of them, stacked: as tall as the longest. */
function StableHint({ hints, current }) {
  return <span className="setting-hint-stack">
    {[...new Set(hints)].map(hint => <span key={hint} aria-hidden={hint === current ? undefined : 'true'}>{hint}</span>)}
  </span>;
}

export function WorkspaceView({ values, onChange, rows = WORKSPACE_ROWS, windowIsNarrow = false, preview = {}, hintKeys = {} }) {
  const t = useT();
  const choiceId = useId();
  const chat = values.viewStyle === 'chat';
  const previewLines = values.listPreviewLines;
  const shown = new Set(rows);
  const hintOf = (key, option) => t(hintKeys[`${key}.${option[0]}`] || `workspace.${option[2]}`);
  const previewOf = (key, value, label, disabled) => <WorkspacePreviewView {...preview} setting={key} value={value} label={label}
    disabled={disabled} layoutMode={values.layoutMode} sidebarDensity={values.sidebarDensity} emailListStyle={values.emailListStyle}
    listDensity={values.listDensity} listPreviewLines={previewLines} />;
  // Density and preview lines share one sample, under preview lines when both are here.
  const listLabel = t('workspace.messages');
  return (
    <section className="settings-preference-group" data-testid="appearance-layout-section" aria-labelledby="workspace-settings-title">
      <h4 id="workspace-settings-title">{t('workspace.title')}</h4>
      {GROUPS.filter(({ key }) => shown.has(key)).map(({ key, titleKey, options, chatDisables }) => {
        const disabled = chatDisables && chat;
        if (key === 'listPreviewLines') return <SettingRow key={key} label={t('listPreview.title')}
          description={disabled ? undefined : <StableHint hints={[t('listPreview.linesHint'), t('listPreview.offHint')]} current={t(previewLines ? 'listPreview.linesHint' : 'listPreview.offHint')} />}
          preview={previewOf(key, previewLines, shown.has('listDensity') ? listLabel : t('listPreview.title'), disabled)}>
          <div role="group" className="settings-segments" data-testid="list-preview-lines">
            {PREVIEW_LINE_CHOICES.map(([value, choiceKey]) => (
              <button type="button" key={value} aria-pressed={previewLines === value} disabled={disabled}
                onClick={() => onChange('listPreviewLines', value)}>
                {t(choiceKey)}
              </button>
            ))}
          </div>
        </SettingRow>;
        return key === 'sidebarLayout' ? (
          <SettingRow key={key} label={t('workspace.sidebarLayout')} className="sidebar-layout-setting">
            <div role="group" className="sidebar-layout-choices">
              {SIDEBAR_LAYOUTS.map(value => {
                const suffix = value[0].toUpperCase() + value.slice(1);
                const label = t(`workspace.sidebarLayout${suffix}`);
                const hintId = `${choiceId}-${value}-hint`;
                return <button key={value} type="button" className="sidebar-layout-choice" aria-label={label}
                  aria-describedby={hintId} aria-pressed={values.sidebarLayout === value}
                  onClick={() => onChange('sidebarLayout', value)}>
                  <SidebarLayoutPreview layout={value} />
                  <span className="sidebar-layout-choice-copy">
                    <span className="sidebar-layout-choice-label">{label}<Check size={15} aria-hidden="true" /></span>
                    <span id={hintId} className="sidebar-layout-choice-hint">{t(`workspace.sidebarLayout${suffix}Hint`)}</span>
                  </span>
                </button>;
              })}
            </div>
          </SettingRow>
        ) : (
          <SettingRow key={key} label={t(titleKey)} description={
            key === 'layoutMode' && !chat && windowIsNarrow
              ? t('settings.appearance.windowTooNarrowForThreeColumns')
              : disabled ? undefined : <StableHint hints={options.map(option => hintOf(key, option))}
                current={hintOf(key, options.find(([value]) => value === values[key]) || options[0])} />
          } preview={key === 'listDensity' && shown.has('listPreviewLines') ? undefined : previewOf(key, values[key], t(titleKey), disabled)}>
            <div role="group" className="settings-segments">
              {options.map(([value, label, , Icon]) => (
                <button type="button" key={value} aria-pressed={values[key] === value} disabled={disabled}
                  onClick={() => onChange(key, value)}>
                  {Icon && <Icon size={16} aria-hidden="true" />}{t(`workspace.${label}`)}
                </button>
              ))}
            </div>
          </SettingRow>
        );
      })}
      {chat && <p className="mt-2 text-xs text-mail-text-muted">{t('workspace.emailViewOnly')}</p>}
      {shown.has('showMenuBar') && <SettingRow label={t('workspace.menuBar')} description={t('workspace.menuBarHint')}>
        <ToggleSwitch active={values.showMenuBar !== false} testId="show-menu-bar"
          onClick={() => onChange('showMenuBar', values.showMenuBar === false)} />
      </SettingRow>}
    </section>
  );
}
