import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Tag, Trash2, PenTool, Plus, Eye, PlayCircle, Undo2 } from 'lucide-react';
import { useAutoTagStore } from '../../stores/autoTagStore';
import { useTagStore } from '../../stores/tagStore';
import { useAccountStore } from '../../stores/accountStore';
import { currentProvider } from '../../services/aiClient';
import { AiContextPreview } from '../ai/AiContextPreview';
import { Button } from '../ui/Button';
import { ToggleSwitch } from './ToggleSwitch';
import { useT } from '../../i18n/index.js';

const EMPTY_CONSTRAINTS = {
  fromDomain: '', fromAddress: '', subjectContains: '', mailbox: '',
  hasAttachments: '', olderThanDays: '', newerThanDays: '', listIdPresent: '',
};

function emptyDraft() {
  return {
    name: '', instruction: '', constraints: { ...EMPTY_CONSTRAINTS },
    tagId: '', inboxAction: 'keep', minConfidence: 0.7,
    allowRemote: false, provider: null, enabled: false,
  };
}

/// `RuleDraft.constraints` (auto_tags.rs `Constraints`) only keeps a field
/// that is actually set — an empty string or blank number means "don't
/// care", never a literal empty-string constraint.
function packConstraints(form) {
  const c = {};
  if (form.fromDomain.trim()) c.fromDomain = form.fromDomain.trim();
  if (form.fromAddress.trim()) c.fromAddress = form.fromAddress.trim();
  if (form.subjectContains.trim()) c.subjectContains = form.subjectContains.trim();
  if (form.mailbox.trim()) c.mailbox = form.mailbox.trim();
  if (form.hasAttachments) c.hasAttachments = form.hasAttachments === 'yes';
  if (form.olderThanDays !== '') c.olderThanDays = Number(form.olderThanDays);
  if (form.newerThanDays !== '') c.newerThanDays = Number(form.newerThanDays);
  if (form.listIdPresent) c.listIdPresent = form.listIdPresent === 'yes';
  return c;
}

function unpackConstraints(c = {}) {
  return {
    fromDomain: c.fromDomain || '', fromAddress: c.fromAddress || '', subjectContains: c.subjectContains || '',
    mailbox: c.mailbox || '',
    hasAttachments: c.hasAttachments == null ? '' : (c.hasAttachments ? 'yes' : 'no'),
    olderThanDays: c.olderThanDays ?? '', newerThanDays: c.newerThanDays ?? '',
    listIdPresent: c.listIdPresent == null ? '' : (c.listIdPresent ? 'yes' : 'no'),
  };
}

function ruleToForm(rule) {
  return {
    name: rule.name, instruction: rule.instruction, constraints: unpackConstraints(rule.constraints),
    tagId: rule.tagId, inboxAction: rule.inboxAction, minConfidence: rule.minConfidence,
    allowRemote: rule.allowRemote, provider: rule.provider, enabled: rule.enabled,
  };
}

function formToDraft(form) {
  return {
    name: form.name.trim(), instruction: form.instruction.trim(), constraints: packConstraints(form.constraints),
    tagId: form.tagId, inboxAction: form.inboxAction, minConfidence: Number(form.minConfidence),
    allowRemote: form.allowRemote, provider: form.allowRemote ? form.provider : null, enabled: form.enabled,
  };
}

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
 */
/// What the consent sheet has to show: not the rule's own words, which the
/// user just typed, but the message fields that travel with them. The daemon
/// builds this prompt in `auto_tags::verdict_prompt` — a rule pointed at a
/// provider sends every candidate's sender, subject, mailbox and attachment
/// flag, and someone approving "use my endpoint" deserves to see that before
/// their mail's subject lines start leaving the machine.
export function remoteSampleText(instruction, translate) {
  return [
    `Rule: ${instruction || ''}`,
    '',
    translate('autoTag.remote.sampleHeading'),
    'From: sender@example.com',
    'Subject: Your receipt for order 1041',
    'Mailbox: INBOX',
    'Has attachments: true',
    '',
    translate('autoTag.remote.sampleQuestion'),
  ].join('\n');
}

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
  const accounts = useAccountStore(s => s.accounts) || [];
  const activeAccountId = useAccountStore(s => s.activeAccountId);

  const [editing, setEditing] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [form, setForm] = useState(emptyDraft());
  const [newTagName, setNewTagName] = useState('');
  const [accountId, setAccountId] = useState(activeAccountId || accounts[0]?.id || '');
  const [previewRows, setPreviewRows] = useState(null); // null | rows | { error }
  const [previewing, setPreviewing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [pendingRemoteConfirm, setPendingRemoteConfirm] = useState(false);
  const [saveError, setSaveError] = useState('');

  const patch = (fields) => setForm(f => ({ ...f, ...fields }));
  const patchConstraints = (fields) => setForm(f => ({ ...f, constraints: { ...f.constraints, ...fields } }));

  const startAdd = () => {
    setEditing({ mode: 'add' });
    setForm(emptyDraft());
    setPreviewRows(null);
    setSaveError('');
  };

  const startEdit = (rule) => {
    setEditing({ mode: 'edit', id: rule.id });
    setForm(ruleToForm(rule));
    setPreviewRows(null);
    setSaveError('');
  };

  const closeEditor = () => {
    setEditing(null);
    setForm(emptyDraft());
    setPreviewRows(null);
    setSaveError('');
  };

  const save = async () => {
    if (!form.name.trim() || !form.instruction.trim() || !form.tagId) return;
    setSaveError('');
    try {
      const draft = formToDraft(form);
      if (editing.mode === 'add') await createRule(draft);
      else await updateRule(editing.id, draft);
      closeEditor();
    } catch (e) {
      setSaveError(e?.message || String(e));
    }
  };

  const addTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    const tag = await createTag(name);
    patch({ tagId: tag.id });
    setNewTagName('');
  };

  const providerFor = () => (form.allowRemote ? (form.provider || currentProvider()) : { type: 'localGguf' });

  // Always the live form, never the saved `ruleId` — the whole point is
  // previewing changes before Save commits them, edit or add alike (the
  // daemon's `rule_for_eval` accepts an inline draft either way).
  const runPreview = async () => {
    setPreviewing(true);
    setPreviewRows(null);
    try {
      const rows = await previewRule({ rule: formToDraft(form), accountId, provider: providerFor() });
      setPreviewRows(rows);
    } catch (e) {
      setPreviewRows({ error: e?.message || String(e) });
    } finally {
      setPreviewing(false);
    }
  };

  const startBackfill = async () => {
    setBackfilling(true);
    try {
      await runBackfill({ ruleId: editing.id, accountId, provider: providerFor() });
    } catch (e) {
      setSaveError(e?.message || String(e));
    } finally {
      setBackfilling(false);
    }
  };

  const toggleAllowRemote = () => {
    if (form.allowRemote) { patch({ allowRemote: false, provider: null }); return; }
    setPendingRemoteConfirm(true);
  };

  const confirmAllowRemote = () => {
    patch({ allowRemote: true, provider: currentProvider() });
    setPendingRemoteConfirm(false);
  };

  const backfillState = editing?.mode === 'edit' ? backfills[editing.id] : null;

  return (
    <div className="settings-form space-y-6">
      <div data-testid="settings-auto-tags" className="settings-section">
        <h4 className="font-semibold text-mail-text mb-2 flex items-center gap-2">
          <Tag size={18} className="text-mail-accent-text" />
          {t('autoTag.tabLabel')}
        </h4>
        <p className="text-sm text-mail-text-muted mb-4">{t('autoTag.intro')}</p>

        <div className="space-y-3">
          {rules.map(rule => (
            <div key={rule.id} className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
              <div className="flex-1 min-w-0 mr-3">
                <div className="text-sm font-medium text-mail-text truncate">{rule.name}</div>
                <div className="text-xs text-mail-text-muted truncate">{rule.instruction}</div>
                <div className="text-xs text-mail-text-muted mt-0.5">
                  {rule.inboxAction === 'hide' ? t('autoTag.inboxActionHide') : t('autoTag.inboxActionKeep')}
                  {rule.allowRemote && ` · ${t('autoTag.allowRemote')}`}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ToggleSwitch
                  testId={`auto-tag-enabled-${rule.id}`}
                  active={rule.enabled}
                  label={t('autoTag.enabledLabel')}
                  onClick={() => updateRule(rule.id, { ...ruleToForm(rule), enabled: !rule.enabled }).catch(() => {})}
                />
                <button onClick={() => startEdit(rule)} className="p-1.5 text-mail-text-muted hover:text-mail-text hover:bg-mail-border rounded-lg transition-colors" title={t('autoTag.edit')}>
                  <PenTool size={14} />
                </button>
                <button onClick={() => deleteRule(rule.id)} className="p-1.5 text-mail-text-muted hover:text-mail-danger hover:bg-mail-border rounded-lg transition-colors" title={t('common.delete')}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}

          {rules.length === 0 && !editing && (
            <div className="text-sm text-mail-text-muted text-center py-3">{t('autoTag.empty')}</div>
          )}

          {!editing && (
            <Button variant="secondary" size="sm" onClick={startAdd}>
              <Plus size={14} /> {t('autoTag.newRule')}
            </Button>
          )}

          <AnimatePresence>
            {editing && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="p-4 bg-mail-bg rounded-lg border border-mail-border space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-mail-text mb-1">{t('autoTag.name')}</label>
                    <input aria-label={t('autoTag.name')} type="text" value={form.name} onChange={e => patch({ name: e.target.value })}
                      placeholder={t('autoTag.namePlaceholder')} className="settings-input" autoFocus />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-mail-text mb-1">{t('autoTag.instruction')}</label>
                    <textarea aria-label={t('autoTag.instruction')} value={form.instruction} onChange={e => patch({ instruction: e.target.value })}
                      placeholder={t('autoTag.instructionPlaceholder')} rows={2} className="settings-input resize-y" />
                    <p className="mt-1 text-xs text-mail-text-muted">{t('autoTag.instructionHint')}</p>
                  </div>

                  <div>
                    <p className="text-sm font-medium text-mail-text mb-1">{t('autoTag.constraints')}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <input aria-label={t('autoTag.fromDomain')} placeholder={t('autoTag.fromDomain')} value={form.constraints.fromDomain}
                        onChange={e => patchConstraints({ fromDomain: e.target.value })} className="settings-input" />
                      <input aria-label={t('autoTag.fromAddress')} placeholder={t('autoTag.fromAddress')} value={form.constraints.fromAddress}
                        onChange={e => patchConstraints({ fromAddress: e.target.value })} className="settings-input" />
                      <input aria-label={t('autoTag.subjectContains')} placeholder={t('autoTag.subjectContains')} value={form.constraints.subjectContains}
                        onChange={e => patchConstraints({ subjectContains: e.target.value })} className="settings-input" />
                      <input aria-label={t('autoTag.mailbox')} placeholder={t('autoTag.mailbox')} value={form.constraints.mailbox}
                        onChange={e => patchConstraints({ mailbox: e.target.value })} className="settings-input" />
                      <select aria-label={t('autoTag.hasAttachments')} value={form.constraints.hasAttachments}
                        onChange={e => patchConstraints({ hasAttachments: e.target.value })} className="settings-input">
                        <option value="">{t('autoTag.hasAttachments')}: {t('autoTag.any')}</option>
                        <option value="yes">{t('autoTag.hasAttachments')}: {t('autoTag.yes')}</option>
                        <option value="no">{t('autoTag.hasAttachments')}: {t('autoTag.no')}</option>
                      </select>
                      <select aria-label={t('autoTag.listIdPresent')} value={form.constraints.listIdPresent}
                        onChange={e => patchConstraints({ listIdPresent: e.target.value })} className="settings-input">
                        <option value="">{t('autoTag.listIdPresent')}: {t('autoTag.any')}</option>
                        <option value="yes">{t('autoTag.listIdPresent')}: {t('autoTag.yes')}</option>
                        <option value="no">{t('autoTag.listIdPresent')}: {t('autoTag.no')}</option>
                      </select>
                      <input aria-label={t('autoTag.olderThanDays')} type="number" min="0" placeholder={t('autoTag.olderThanDays')}
                        value={form.constraints.olderThanDays} onChange={e => patchConstraints({ olderThanDays: e.target.value })} className="settings-input" />
                      <input aria-label={t('autoTag.newerThanDays')} type="number" min="0" placeholder={t('autoTag.newerThanDays')}
                        value={form.constraints.newerThanDays} onChange={e => patchConstraints({ newerThanDays: e.target.value })} className="settings-input" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-mail-text mb-1">{t('autoTag.tag')}</label>
                    <div className="flex gap-2">
                      <select aria-label={t('autoTag.tag')} value={form.tagId} onChange={e => patch({ tagId: e.target.value })} className="settings-input flex-1">
                        <option value="">{t('autoTag.tagPlaceholder')}</option>
                        {tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-2 mt-2">
                      <input aria-label={t('autoTag.newTagPlaceholder')} placeholder={t('autoTag.newTagPlaceholder')} value={newTagName}
                        onChange={e => setNewTagName(e.target.value)} className="settings-input flex-1" />
                      <Button variant="secondary" size="sm" onClick={addTag} disabled={!newTagName.trim()}>{t('autoTag.newTag')}</Button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-mail-text mb-1">{t('autoTag.inboxAction')}</label>
                    <select aria-label={t('autoTag.inboxAction')} value={form.inboxAction} onChange={e => patch({ inboxAction: e.target.value })} className="settings-input">
                      <option value="keep">{t('autoTag.inboxActionKeep')}</option>
                      <option value="hide">{t('autoTag.inboxActionHide')}</option>
                    </select>
                    {form.inboxAction === 'hide' && <p className="mt-1 text-xs text-mail-text-muted">{t('autoTag.inboxActionHideHint')}</p>}
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-mail-text mb-1">
                      {t('autoTag.minConfidence')}: {Math.round(form.minConfidence * 100)}%
                    </label>
                    <input aria-label={t('autoTag.minConfidence')} type="range" min="0" max="1" step="0.05" value={form.minConfidence}
                      onChange={e => patch({ minConfidence: e.target.value })} className="w-full" />
                  </div>

                  <div className="flex items-center justify-between p-3 bg-mail-surface rounded-lg border border-mail-border">
                    <div className="mr-3">
                      <div className="text-sm font-medium text-mail-text">{t('autoTag.allowRemote')}</div>
                      <p className="text-xs text-mail-text-muted mt-0.5">{t('autoTag.allowRemoteHint')}</p>
                    </div>
                    <ToggleSwitch testId="auto-tag-allow-remote" active={form.allowRemote} label={t('autoTag.allowRemote')} onClick={toggleAllowRemote} />
                  </div>

                  {form.enabled === false && (
                    <p className="text-xs text-mail-text-muted">{t('autoTag.neverAppliesToOldMail')}</p>
                  )}

                  <div className="flex items-center gap-2">
                    <label className="text-sm text-mail-text">{t('autoTag.enabledLabel')}</label>
                    <ToggleSwitch testId="auto-tag-enabled-editor" active={form.enabled} label={t('autoTag.enabledLabel')} onClick={() => patch({ enabled: !form.enabled })} />
                  </div>

                  {accounts.length > 1 && (
                    <div>
                      <label className="block text-sm font-medium text-mail-text mb-1">{t('common.from')}</label>
                      <select aria-label={t('common.from')} value={accountId} onChange={e => setAccountId(e.target.value)} className="settings-input">
                        {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.email}</option>)}
                      </select>
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <Button variant="secondary" size="sm" onClick={runPreview} disabled={previewing || !form.instruction.trim() || !accountId}>
                      <Eye size={14} /> {previewing ? t('autoTag.previewing') : t('autoTag.preview')}
                    </Button>
                    {editing.mode === 'edit' && (
                      <Button variant="secondary" size="sm" onClick={startBackfill} disabled={backfilling || !accountId}>
                        <PlayCircle size={14} /> {t('autoTag.backfill')}
                      </Button>
                    )}
                    {backfillState?.batchId && backfillState.done && (
                      <Button variant="secondary" size="sm" onClick={() => undoBackfill(editing.id, backfillState.batchId)}>
                        <Undo2 size={14} /> {t('autoTag.undo')}
                      </Button>
                    )}
                  </div>

                  {backfillState && (
                    <p className="text-xs text-mail-text-muted" data-testid="auto-tag-backfill-status">
                      {backfillState.done
                        ? t('autoTag.backfillDone', { assigned: backfillState.assigned || 0, processed: backfillState.processed || 0 })
                        : t('autoTag.backfillRunning', { processed: backfillState.processed || 0, total: backfillState.total || 0 })}
                    </p>
                  )}

                  {previewRows && (
                    <div className="rounded-lg border border-mail-border p-2 max-h-56 overflow-y-auto" data-testid="auto-tag-preview-results">
                      <p className="text-xs text-mail-text-muted mb-2">{t('autoTag.previewWritesNothing')}</p>
                      {previewRows.error && <p className="text-xs text-mail-danger">{previewRows.error}</p>}
                      {!previewRows.error && previewRows.length === 0 && (
                        <p className="text-xs text-mail-text-muted">{t('autoTag.previewEmpty', { count: 200 })}</p>
                      )}
                      {!previewRows.error && previewRows.map((row, i) => (
                        <div key={`${row.mailbox}-${row.uid}-${i}`} className="text-xs py-1 border-b border-mail-border last:border-0 flex justify-between gap-2">
                          <span className="truncate">{row.subject || t('common.noSubject')}</span>
                          <span className="shrink-0 text-mail-text-muted">
                            {row.matched
                              ? t('autoTag.confidence', { value: Math.round((row.confidence || 0) * 100) })
                              : (row.refused ? t('autoTag.previewRefused') : t('autoTag.previewNoMatch'))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {saveError && <p className="text-xs text-mail-danger">{t('autoTag.saveFailed', { error: saveError })}</p>}

                  <div className="flex items-center gap-2 justify-end">
                    <Button variant="ghost" size="sm" onClick={closeEditor}>{t('common.cancel')}</Button>
                    <Button variant="primary" size="sm" onClick={save} disabled={!form.name.trim() || !form.instruction.trim() || !form.tagId}>
                      {t('common.save')}
                    </Button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AiContextPreview
        open={pendingRemoteConfirm}
        text={remoteSampleText(form.instruction, t)}
        provider={currentProvider()}
        onCancel={() => setPendingRemoteConfirm(false)}
        onConfirm={confirmAllowRemote}
      />
    </div>
  );
}
