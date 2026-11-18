// An open message's custom fields on the phone: desktop's strip (components/fields/FieldViews.jsx)
// over the phone's field cache (fields.js), under the message's header. Nothing when its account
// has no field.
import React from 'react';
import { FieldStripView } from '../components/fields/FieldViews';
import { SettingsViewProvider } from '../components/settings/views/viewContext';
import { useT } from './i18n.js';
import { useFieldStore, useRowFields } from './fields.js';
import '../styles/quick-actions.css';

export default function FieldStrip({ accountId, folder, uid, className = '' }) {
  const t = useT();
  const { schema, values } = useRowFields(accountId, folder, uid);
  if (!schema.length) return null;
  return (
    <SettingsViewProvider t={t}>
      <FieldStripView schema={schema} values={values} className={className}
        onChange={(field, value) => useFieldStore.getState().setValue({ accountId, folder, uid }, field.id, value)} />
    </SettingsViewProvider>
  );
}
