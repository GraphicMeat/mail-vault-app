import React from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useFieldStore } from '../../stores/fieldStore';
import { useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { SettingsViewProvider } from './views/viewContext';
import { FieldsView } from './views/FieldsView';

/// The custom fields of the active account: desktop's container of the shared
/// view (views/FieldsView.jsx), over the field store. The view needs only the
/// translator and the privacy mask, so it gets those two (DesktopViewEnv would
/// also bring the date formatters and the language, which it never reads).
export function FieldsSettings() {
  const t = useT();
  const privateAttr = usePrivateAttr();
  const accountId = useMailStore(state => state.activeAccountId);
  const accounts = useMailStore(state => state.accounts) || [];
  const fields = useFieldStore(state => state.fields);
  const loadFields = useFieldStore(state => state.loadFields);
  const saveField = useFieldStore(state => state.saveField);
  const deleteField = useFieldStore(state => state.deleteField);
  const moveField = useFieldStore(state => state.moveField);
  const copyFields = useFieldStore(state => state.copyFields);
  const optionUsage = useFieldStore(state => state.optionUsage);
  return <SettingsViewProvider t={t} privateAttr={privateAttr}>
    <FieldsView accountId={accountId} accounts={accounts} fields={fields} onLoad={loadFields} onSave={saveField}
      onDelete={deleteField} onMove={moveField} onCopy={copyFields} optionUsage={optionUsage} />
  </SettingsViewProvider>;
}
