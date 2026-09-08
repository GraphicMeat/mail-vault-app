import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ColorSchemeSettings } from './ColorSchemeSettings';
import { WorkspaceSettings } from './WorkspaceSettings';
import { SettingRow } from './SettingRow';
import { DateTimePreview, ReadingPreview } from './PreferencePreview';
import { SettingsTabs } from './SettingsTabs';
import { useT } from '../../i18n/index.js';
import '../../styles/settings-usability.css';

// Match App's stacked-layout breakpoint so the explanation reflects the
// actual window, while preserving the user's preferred reading-pane layout.
function useWindowIsNarrow() {
  const [narrow, setNarrow] = React.useState(
    () => window.matchMedia('(max-width: 767px)').matches,
  );
  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const onChange = event => setNarrow(event.matches);
    media.addEventListener('change', onChange);
    setNarrow(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

const sections = [
  { id: 'colors', key: 'colors' },
  { id: 'layout', key: 'layout' },
  { id: 'reading', key: 'reading' },
  { id: 'date-time', key: 'dateTime' },
];
const validSection = value => sections.some(section => section.id === value) ? value : 'colors';

export function AppearanceSettings({ initialSection = 'colors', onSectionChange }) {
  const t = useT();
  const windowIsNarrow = useWindowIsNarrow();
  const settings = useSettingsStore();
  const [section, setSection] = React.useState(() => validSection(initialSection));
  React.useEffect(() => setSection(validSection(initialSection)), [initialSection]);
  const readingOptions = [
    { key: 'threadMode', setter: 'setThreadMode', label: 'threadMode',
      options: [['grouped', 'threadModeGrouped', 'threadModeGroupedHint'], ['expandable', 'threadModeExpandable', 'threadModeExpandableHint'], ['flat', 'threadModeFlat', 'threadModeFlatHint']] },
    { key: 'threadSortOrder', setter: 'setThreadSortOrder', label: 'threadSortOrder',
      options: [['oldest-first', 'oldestFirst', 'conversationFlowsTopBottom'], ['newest-first', 'newestFirst', 'latestReplyTop']] },
    { key: 'signatureDisplay', setter: 'setSignatureDisplay', label: 'signatureDisplay',
      options: [['smart', 'smart', 'showOncePerSenderCollapse'], ['always-show', 'alwaysShow', 'neverCollapseSignatures'], ['always-hide', 'alwaysHide', 'collapseAllSignatures'], ['collapsed', 'collapsed', 'collapsedToggleExpand']] },
    { key: 'emailRowHighlight', setter: 'setEmailRowHighlight', label: 'rowHighlight',
      options: [['hover', 'rowHighlightHover', 'rowHighlightHoverHint'], ['selection', 'rowHighlightSelection', 'rowHighlightSelectionHint']] },
    { key: 'actionButtonDisplay', setter: 'setActionButtonDisplay', label: 'actionButtonStyle',
      options: [['icon-only', 'iconsOnly'], ['icon-label', 'iconsLabels'], ['text-only', 'labelsOnly']] },
  ];
  return (
    <SettingsTabs tabs={sections.map(({ id, key }) => ({ id, label: t(`settings.appearance.section.${key}`) }))}
      value={section} onChange={value => { setSection(value); onSectionChange?.(value); }} label={t('settings.appearance.appearance')}>
    <div className="appearance-settings">
      <p className="appearance-preview-intro">{t('settings.preview.intro')}</p>
      {section === 'colors' && <ColorSchemeSettings />}
      {section === 'layout' && <WorkspaceSettings windowIsNarrow={windowIsNarrow} />}
      {section === 'reading' && <section className="settings-preference-group" aria-labelledby="reading-settings-title">
        <h4 id="reading-settings-title">{t('settings.appearance.readingAndConversations')}</h4>
        {readingOptions.map(({ key, setter, label, options }) => {
          const hint = options.find(([value]) => value === settings[key])?.[2];
          return (
            <SettingRow key={key} label={t(`settings.appearance.${label}`)} description={hint && t(`settings.appearance.${hint}`)}
              preview={<ReadingPreview setting={key} value={settings[key]} label={t(`settings.appearance.${label}`)} />}>
              <select value={settings[key]} onChange={event => settings[setter](event.target.value)}>
                {options.map(([value, optionLabel]) => <option key={value} value={value}>{t(`settings.appearance.${optionLabel}`)}</option>)}
              </select>
            </SettingRow>
          );
        })}
      </section>}
      {section === 'date-time' && <section className="settings-preference-group" aria-labelledby="date-settings-title">
        <h4 id="date-settings-title">{t('settings.appearance.dateAndTime')}</h4>
        <SettingRow label={t('settings.appearance.dateFormat')} preview={<DateTimePreview label={t('settings.appearance.dateFormat')} />}>
          <select value={settings.dateFormat} onChange={event => settings.setDateFormat(event.target.value)}>
            <option value="auto">{t('settings.appearance.systemDefault', { lang: navigator.language })}</option>
            <option value="MM/dd/yyyy">{t('settings.appearance.mmDdYyyyUs')}</option>
            <option value="dd/MM/yyyy">{t('settings.appearance.ddMmYyyyEurope')}</option>
            <option value="yyyy-MM-dd">{t('settings.appearance.yyyyMmDdIso')}</option>
            <option value="dd MMM yyyy">{t('settings.appearance.ddMmmYyyyExample')}</option>
            <option value="custom">{t('settings.appearance.custom')}</option>
          </select>
        </SettingRow>
        {settings.dateFormat === 'custom' && (
          <SettingRow label={t('settings.appearance.custom')} description={t('settings.appearance.usesDateFnsTokens')} preview={<DateTimePreview label={t('settings.appearance.custom')} />}>
            <input type="text" value={settings.customDateFormat} onChange={event => settings.setCustomDateFormat(event.target.value)} placeholder={t('settings.appearance.eGDdMmYyyy')} />
          </SettingRow>
        )}
        <SettingRow label={t('settings.appearance.timeFormat')} preview={<DateTimePreview time label={t('settings.appearance.timeFormat')} />}>
          <select value={settings.timeFormat} onChange={event => settings.setTimeFormat(event.target.value)}>
            <option value="auto">{t('settings.appearance.systemDefault', { lang: navigator.language })}</option>
            <option value="12h">{t('settings.appearance.twelveHour')}</option>
            <option value="24h">{t('settings.appearance.twentyFourHour')}</option>
          </select>
        </SettingRow>
      </section>}
    </div>
    </SettingsTabs>
  );
}
