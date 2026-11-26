import React, { useMemo } from 'react';
import { useAccountSections } from '../ui/EmailSelector';
import { useAutoTagStore } from '../../stores/autoTagStore';
import { useTagStore } from '../../stores/tagStore';
import { useAccountStore } from '../../stores/accountStore';
import { useMailStore } from '../../stores/mailStore';
import { aiErrorText, currentProvider, googleMailRefusal, isOnDevice, mailMustStayOnDevice } from '../../services/aiClient';
import { AiContextPreview } from '../ai/AiContextPreview';
import { useT } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { AutoTagsView, remoteSampleText, ruleToForm } from './views/AutoTagsView';
import { TagListView } from '../tags/TagViews';

export { remoteSampleText };

/**
 * Auto Tags (Phase 4) settings tab: create/edit/delete natural-language
 * rules, preview them before enabling, and run/undo a backfill. The privacy
 * surface (`allowRemote`) reuses the same confirmation Quick Replies/AI
 * Compose already use (`AiContextPreview`) rather than inventing a second
 * one — the destination is named there, not softened here.
 *
 * Hide-from-Inbox itself (what actually removes a row from the Inbox list)
 * lives in `src/utils/autoTagInboxFilter.js`, called from
 * `deriveDisplayRows` in `messageListSlice.js` — this component only edits
 * the rule that asks for it.
 *
 * The page itself is views/AutoTagsView.jsx, which the phone renders too; this
 * container gives it the daemon's `auto_tags.*` through the stores.
 */
export function AutoTagSettings() {
  const t = useT();
  const rules = useAutoTagStore(s => s.rules);
  const backfills = useAutoTagStore(s => s.backfills);
  const createRule = useAutoTagStore(s => s.createRule);
  const updateRule = useAutoTagStore(s => s.updateRule);
  const deleteRule = useAutoTagStore(s => s.deleteRule);
  const previewRule = useAutoTagStore(s => s.preview);
  const runBackfill = useAutoTagStore(s => s.backfill);
  const undoBackfill = useAutoTagStore(s => s.undoBackfill);
  const tags = useTagStore(s => s.tags);
  const createTag = useTagStore(s => s.createTag);
  const deleteTag = useTagStore(s => s.deleteTag);
  const loadedEmails = useMailStore(s => s.emails) || [];
  const senderOptions = useMemo(() => {
    const addresses = [...new Set(loadedEmails.map(email => email.from?.address?.toLowerCase()).filter(Boolean))].sort();
    return {
      addresses: addresses.slice(0, 100).map(value => ({ value, label: value })),
      domains: [...new Set(addresses.map(address => address.split('@')[1]).filter(Boolean))].slice(0, 100)
        .map(value => ({ value, label: value })),
    };
  }, [loadedEmails]);
  const accounts = useAccountStore(s => s.accounts) || [];
  const accountOptions = useMemo(() => accounts.map(account => ({ value: account.id, label: account.email })), [accounts]);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const accountRows = useAccountSections(accounts);

  // Google mail never goes to a cloud endpoint (the daemon refuses it too):
  // say so here instead of sending a request that is bound to be turned away.
  const providerFor = (provider, accountId) => {
    if (provider && !isOnDevice(provider) && mailMustStayOnDevice([accountId])) throw googleMailRefusal();
    return provider;
  };

  return <DesktopViewEnv>
    <AutoTagsView rules={rules} backfills={backfills} tags={tags} senderOptions={senderOptions}
      accountOptions={accountOptions} accountRows={accountRows} defaultAccountId={activeAccountId || accounts[0]?.id || ''}
      onCreate={createRule} onUpdate={updateRule} onDelete={deleteRule}
      onToggle={rule => updateRule(rule.id, { ...ruleToForm(rule), enabled: !rule.enabled }).catch(() => {})}
      onCreateTag={createTag} onPreview={previewRule} onBackfill={runBackfill} onUndo={undoBackfill}
      providerFor={providerFor} currentProvider={() => currentProvider()}
      errorText={e => aiErrorText(e, t, e?.message || String(e))}
      renderRemoteConfirm={({ open, text, onCancel, onConfirm }) => (
        <AiContextPreview open={open} text={text} provider={currentProvider()} onCancel={onCancel} onConfirm={onConfirm} />
      )} />
    {/* The local labels themselves, with their delete buttons: kept with the
        rules that apply them rather than among the quick actions. */}
    {tags.length > 0 && <TagListView tags={tags} onDelete={id => deleteTag(id)} />}
  </DesktopViewEnv>;
}
