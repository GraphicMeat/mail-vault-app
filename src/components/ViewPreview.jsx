import React, { useCallback } from 'react';
import { useViewStore } from '../stores/viewStore';
import { useT } from '../i18n/index.js';
import { Private } from './privacy/Private';
import { SettingsViewProvider } from './settings/views/viewContext';
import { ViewPreviewView } from './settings/views/ViewPreviewView';

/// What the definition on screen would find, right now: the shared preview
/// (settings/views/ViewPreviewView.jsx) over the view store's `previewDef`.
///
/// The preview never calls `showRows`: that repaints the mail list, and this
/// is a panel inside Settings.
export function ViewPreview({ def, limit = 25 }) {
  const t = useT();
  const previewDef = useViewStore(state => state.previewDef);
  const run = useCallback(async (definition, max) => {
    const reply = await previewDef(definition, max);
    if (!reply) return reply;
    return {
      ...reply,
      rows: (reply.rows || []).map(email => ({
        key: [email._accountId, email._mailbox, email.uid].join('/'),
        sender: email.from?.name || email.from?.address || '',
        subject: email.subject,
        date: email.date,
      })),
    };
  }, [previewDef]);
  return <SettingsViewProvider t={t} Private={Private}>
    <ViewPreviewView def={def} limit={limit} run={run} />
  </SettingsViewProvider>;
}
