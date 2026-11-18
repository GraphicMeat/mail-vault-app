import React, { useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useFieldStore, requestRowValues, requestSchema, fieldRowKey } from '../stores/fieldStore';
import { resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { useT } from '../i18n/index.js';
import { SettingsViewProvider } from './settings/views/viewContext';
import { FieldStripView } from './fields/FieldViews';

/// The custom fields of the message being read, editable in place: desktop's
/// container of the shared view (fields/FieldViews.jsx), over the field store.
///
/// Nothing here writes to the message: a value is MailVault's own note about
/// it, stored locally and keyed to the message's identity.
const EMPTY_VALUES = {};

export function FieldStrip({ email, className = '' }) {
  const t = useT();
  const fields = useFieldStore(state => state.fields);
  const byRow = useFieldStore(state => state.byRow);
  const setValue = useFieldStore(state => state.setValue);
  const location = email ? resolveEmailLocation(email, useMailStore.getState()) : null;
  const schema = (location && fields[location.accountId]) || [];

  useEffect(() => {
    if (!location) return;
    // A unified list shows several accounts, and only the active one's schema
    // is loaded at startup. Without this the strip is simply absent for the
    // others — no error, no empty state.
    requestSchema(location.accountId);
    if (schema.length) requestRowValues(email, location);
  });

  if (!location || !schema.length) return null;
  // Read from the subscribed cache, not from a `getState()` snapshot: a value
  // that arrives after the strip mounts has to repaint it.
  const values = byRow[fieldRowKey(location.accountId, location.mailbox, email.uid)] || EMPTY_VALUES;

  return <SettingsViewProvider t={t}>
    <FieldStripView schema={schema} values={values} className={className}
      onChange={(field, value) => setValue(email, location, field.id, value)} />
  </SettingsViewProvider>;
}
