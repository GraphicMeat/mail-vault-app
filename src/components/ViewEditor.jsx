import React, { useCallback, useEffect } from 'react';
import { useViewStore } from '../stores/viewStore';
import { ViewPreview } from './ViewPreview';
import { useTagStore } from '../stores/tagStore';
import { useFieldStore } from '../stores/fieldStore';
import { useMailStore } from '../stores/mailStore';
import { useUnsavedStore } from '../stores/unsavedStore';
import { useT } from '../i18n/index.js';
import { Private } from './privacy/Private';
import { usePrivateTag } from './SearchTagInput';
import { usePrivateAttr } from '../hooks/usePrivacy';
import { registerPopoverLayer } from '../hooks/useDialogA11y';
import { daemonCall } from '../services/daemonClient';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsViewProvider } from './settings/views/viewContext';
import { ViewEditorView } from './settings/views/ViewEditorView';

/// Query suggestions per page: the top 20, then 20 more as the list scrolls.
const TERM_PAGE = 20;

/// Desktop's view editor: the shared form (settings/views/ViewEditorView.jsx)
/// over the view, tag, field and mail stores, the daemon's typeaheads, the
/// unsaved-changes prompt, the preview and the delete confirmation.
///
/// `onSaved` and `onDiscard` answer the unsaved-changes prompt for the host:
/// a draft it created is kept once saved, deleted once discarded.
export function ViewEditor({ view, onClose, onSaved, onDiscard, showPreview = true, isNew = false }) {
  const t = useT();
  const saveView = useViewStore(state => state.saveView);
  const deleteView = useViewStore(state => state.deleteView);
  const tags = useTagStore(state => state.tags) || [];
  const accounts = useMailStore(state => state.accounts) || [];
  const accountId = useMailStore(state => state.activeAccountId);
  const schema = useFieldStore(state => state.fieldsFor(accountId)) || [];
  // A word like `from:ann@x.test` names someone: masked like a search tag.
  const privateTag = usePrivateTag();
  const pa = usePrivateAttr();

  /// Senders the index holds, in `chosen`: the accounts the view reads (the
  /// form says which; none chosen is every account).
  // Masked here, not in the typeahead: only this list's options are people.
  const suggestSenders = useCallback((prefix, chosen) => daemonCall('views.suggest_senders', {
    prefix, accounts: chosen, limit: 8,
  }).then(found => (Array.isArray(found) ? found : []).map(sender => ({
    value: sender.address,
    label: sender.name ? pa(sender.name, 'name') : pa(sender.address, 'email'),
    detail: [sender.name ? pa(sender.address, 'email') : '', sender.count].filter(Boolean).join(' · '),
  }))).catch(() => []), [pa]);
  /// Words and phrases from the subjects and attachment names of the mail the
  /// view reads, most messages first, a page at a time.
  const suggestTerms = useCallback((prefix, offset, chosen) => daemonCall('views.suggest_terms', {
    prefix, accounts: chosen, offset, limit: TERM_PAGE,
  }).then(found => (Array.isArray(found) ? found : []).map(term => ({
    value: term.term, label: term.term, detail: String(term.count),
  }))).catch(() => []), []);

  const onGuard = useCallback(guard => useUnsavedStore.getState().setGuard(guard), []);
  useEffect(() => () => useUnsavedStore.getState().setGuard(null), []);

  return <SettingsViewProvider t={t} Private={Private} privateAttr={pa} registerPopoverLayer={registerPopoverLayer}>
    <ViewEditorView view={view} onClose={onClose} onSaved={onSaved} onDiscard={onDiscard}
      showPreview={showPreview} isNew={isNew} accounts={accounts} tags={tags} schema={schema}
      suggestSenders={suggestSenders} suggestTerms={suggestTerms} privateTag={privateTag}
      onSave={saveView} onDelete={deleteView} onGuard={onGuard}
      renderPreview={def => <ViewPreview def={def} />}
      renderConfirm={({ open, onClose: close, onConfirm, title, description, confirmLabel, cancelLabel, loading }) =>
        <ConfirmDialog isOpen={open} onClose={close} onConfirm={onConfirm} title={title}
          description={description} confirmLabel={confirmLabel} cancelLabel={cancelLabel} destructive loading={loading} />} />
  </SettingsViewProvider>;
}
