// Settings > Appearance > Reading and Date & time as views. `values`: the settings by key;
// `onChange(key, value)` sets one. `rows` (Reading): the keys this app shows.
import React from 'react';
import { SettingRow } from '../../ui/SettingRow';
import { DateTimePreview, ReadingPreview } from './PreviewViews';
import { useT } from './viewContext';

const READING = [
  { key: 'threadMode', labelKey: 'settings.appearance.threadMode',
    options: [['grouped', 'threadModeGrouped', 'threadModeGroupedHint'], ['expandable', 'threadModeExpandable', 'threadModeExpandableHint'], ['flat', 'threadModeFlat', 'threadModeFlatHint']] },
  { key: 'threadSortOrder', labelKey: 'settings.appearance.threadSortOrder',
    options: [['oldest-first', 'oldestFirst', 'conversationFlowsTopBottom'], ['newest-first', 'newestFirst', 'latestReplyTop']] },
  { key: 'signatureDisplay', labelKey: 'settings.appearance.signatureDisplay',
    options: [['smart', 'smart', 'showOncePerSenderCollapse'], ['always-show', 'alwaysShow', 'neverCollapseSignatures'], ['always-hide', 'alwaysHide', 'collapseAllSignatures'], ['collapsed', 'collapsed', 'collapsedToggleExpand']] },
  { key: 'emailRowHighlight', labelKey: 'settings.appearance.rowHighlight',
    options: [['hover', 'rowHighlightHover', 'rowHighlightHoverHint'], ['selection', 'rowHighlightSelection', 'rowHighlightSelectionHint']] },
  { key: 'actionButtonDisplay', labelKey: 'settings.appearance.actionButtonStyle',
    options: [['icon-only', 'iconsOnly'], ['icon-label', 'iconsLabels'], ['text-only', 'labelsOnly']] },
];
export const READING_ROWS = READING.map(row => row.key);

export function ReadingView({ values, onChange, rows = READING_ROWS }) {
  const t = useT();
  return <section className="settings-preference-group" aria-labelledby="reading-settings-title">
    <h4 id="reading-settings-title">{t('settings.appearance.readingAndConversations')}</h4>
    {READING.filter(({ key }) => rows.includes(key)).map(({ key, labelKey, options }) => {
      const hint = options.find(([value]) => value === values[key])?.[2];
      return (
        <SettingRow key={key} label={t(labelKey)} description={hint && t(`settings.appearance.${hint}`)}
          preview={<ReadingPreview setting={key} value={values[key]} label={t(labelKey)} />}>
          <select value={values[key]} onChange={event => onChange(key, event.target.value)}>
            {options.map(([value, optionLabel]) => <option key={value} value={value}>{t(`settings.appearance.${optionLabel}`)}</option>)}
          </select>
        </SettingRow>
      );
    })}
  </section>;
}

/** `systemLanguage`: the language "System default" names (desktop `navigator.language`). */
export function DateTimeView({ values, onChange, systemLanguage }) {
  const t = useT();
  const systemDefault = t('settings.appearance.systemDefault', { lang: systemLanguage });
  return <section className="settings-preference-group" aria-labelledby="date-settings-title">
    <h4 id="date-settings-title">{t('settings.appearance.dateAndTime')}</h4>
    <SettingRow label={t('settings.appearance.dateFormat')} preview={<DateTimePreview label={t('settings.appearance.dateFormat')} />}>
      <select value={values.dateFormat} onChange={event => onChange('dateFormat', event.target.value)}>
        <option value="auto">{systemDefault}</option>
        <option value="MM/dd/yyyy">{t('settings.appearance.mmDdYyyyUs')}</option>
        <option value="dd/MM/yyyy">{t('settings.appearance.ddMmYyyyEurope')}</option>
        <option value="yyyy-MM-dd">{t('settings.appearance.yyyyMmDdIso')}</option>
        <option value="dd MMM yyyy">{t('settings.appearance.ddMmmYyyyExample')}</option>
        <option value="custom">{t('settings.appearance.custom')}</option>
      </select>
    </SettingRow>
    {values.dateFormat === 'custom' && (
      <SettingRow label={t('settings.appearance.custom')} description={t('settings.appearance.usesDateFnsTokens')} preview={<DateTimePreview label={t('settings.appearance.custom')} />}>
        <input type="text" value={values.customDateFormat} onChange={event => onChange('customDateFormat', event.target.value)} placeholder={t('settings.appearance.eGDdMmYyyy')} />
      </SettingRow>
    )}
    <SettingRow label={t('settings.appearance.timeFormat')} preview={<DateTimePreview time label={t('settings.appearance.timeFormat')} />}>
      <select value={values.timeFormat} onChange={event => onChange('timeFormat', event.target.value)}>
        <option value="auto">{systemDefault}</option>
        <option value="12h">{t('settings.appearance.twelveHour')}</option>
        <option value="24h">{t('settings.appearance.twentyFourHour')}</option>
      </select>
    </SettingRow>
  </section>;
}
