import React, { useId } from 'react';
import { Check, Columns, Rows } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingRow } from './SettingRow';
import { SidebarLayoutPreview, WorkspacePreview } from './PreferencePreview';
import { useT } from '../../i18n/index.js';

export function WorkspaceSettings({ windowIsNarrow }) {
  const t = useT();
  const settings = useSettingsStore();
  const choiceId = useId();
  const chat = settings.viewStyle === 'chat';
  const groups = [
    { key: 'viewStyle', setter: 'setViewStyle', title: 'mailExperience',
      options: [['list', 'emailView', 'emailViewHint'], ['chat', 'chatView', 'chatViewHint']] },
    { key: 'layoutMode', setter: 'setLayoutMode', title: 'readingPane', disabled: chat,
      options: [['three-column', 'besideList', 'besideListHint', Columns], ['two-column', 'belowList', 'belowListHint', Rows]] },
    { key: 'sidebarLayout', title: 'sidebarLayout' },
    { key: 'sidebarStyle', setter: 'setSidebarStyle', title: 'navigation',
      options: [['list', 'navigationList', 'navigationListHint'], ['tagcloud', 'navigationBubbles', 'navigationBubblesHint']] },
    { key: 'emailListStyle', setter: 'setEmailListStyle', title: 'messageRows', disabled: chat,
      options: [['compact', 'twoLineRows', 'twoLineRowsHint'], ['default', 'singleLineRows', 'singleLineRowsHint']] },
  ];
  return (
    <section className="settings-preference-group" aria-labelledby="workspace-settings-title">
      <h4 id="workspace-settings-title">{t('workspace.title')}</h4>
      {groups.map(({ key, setter, title, options, disabled }) => key === 'sidebarLayout' ? (
        <SettingRow key={key} label={t('workspace.sidebarLayout')} className="sidebar-layout-setting">
          <div role="group" className="sidebar-layout-choices">
            {['stacked', 'split', 'switcher'].map(value => {
              const suffix = value[0].toUpperCase() + value.slice(1);
              const label = t(`workspace.sidebarLayout${suffix}`);
              const hintId = `${choiceId}-${value}-hint`;
              return <button key={value} type="button" className="sidebar-layout-choice" aria-label={label}
                aria-describedby={hintId} aria-pressed={settings.sidebarLayout === value}
                onClick={() => settings.setSidebarLayout(value)}>
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
        <SettingRow key={key} label={t(`workspace.${title}`)} description={
          key === 'layoutMode' && !chat && windowIsNarrow
            ? t('settings.appearance.windowTooNarrowForThreeColumns')
            : disabled ? undefined : t(`workspace.${options.find(([value]) => value === settings[key])?.[2] || options[0][2]}`)
        } preview={<WorkspacePreview setting={key} value={settings[key]} label={t(`workspace.${title}`)} disabled={disabled} />}>
          <div role="group" className="settings-segments">
            {options.map(([value, label, , Icon]) => (
              <button type="button" key={value} aria-pressed={settings[key] === value} disabled={disabled}
                onClick={() => settings[setter](value)}>
                {Icon && <Icon size={16} aria-hidden="true" />}{t(`workspace.${label}`)}
              </button>
            ))}
          </div>
        </SettingRow>
      ))}
      {chat && <p className="mt-2 text-xs text-mail-text-muted">{t('workspace.emailViewOnly')}</p>}
    </section>
  );
}
