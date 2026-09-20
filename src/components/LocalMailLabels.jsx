import React from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { localMailLabelKey } from '../utils/quickActions';
import { resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { useT } from '../i18n/index.js';

export function LocalMailLabels({ email, className = '' }) {
  const t = useT();
  const labels = useSettingsStore(state => state.localMailLabels);
  const assignments = useSettingsStore(state => state.localMailLabelAssignments);
  const removeLabel = useSettingsStore(state => state.removeLocalMailLabelFromEmail);
  const rows = Array.isArray(email) ? email : email ? [email] : [];
  const state = useMailStore.getState();
  const represented = labels?.length ? rows.map(row => {
    const location = resolveEmailLocation(row, state);
    const key = localMailLabelKey(row, location);
    return { row, location, ids: key ? assignments?.[key] || [] : [] };
  }) : [];
  const assigned = labels?.filter(label => represented.some(item => item.ids.includes(label.id))) || [];
  if (!assigned.length) return null;
  return <span className={`local-mail-labels ${className}`} aria-label={t('quickActions.localLabels')}>
    {assigned.map(label => <span key={label.id} className="local-mail-label">
      <span>{label.name}</span>
      <button type="button" aria-label={t('quickActions.removeLabel', { label: label.name })}
        title={t('quickActions.removeLabel', { label: label.name })}
        onClick={event => {
          event.stopPropagation();
          for (const item of represented) if (item.location && item.ids.includes(label.id)) removeLabel(item.row, item.location, label.id);
        }}>×</button>
    </span>)}
  </span>;
}
