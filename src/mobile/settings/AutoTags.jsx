// Settings > Auto Tags on the phone: desktop's view (AutoTagsView) over the engine's rules
// (`auto_tags.rs`, `mobile.autoTags.*`).
//
// - The phone's one provider is the endpoint of Settings > AI. Turning on "Allow a remote AI
//   provider" goes through the same review sheet as the AI actions (AiActions.jsx), naming that
//   endpoint, and stores it as the rule's provider: the engine runs a rule only on the endpoint it
//   was allowed for, and says so under a rule that cannot run (`mobile.autoTag.needsRemote`).
// - With no endpoint the page shows the AI actions' "needs an endpoint" note; with one off this
//   phone and a Google account here, the note that Gmail mail is never sent to it (the engine
//   leaves that mail out).
// - Preview runs only when pressed (every phone rule is remote); a backfill runs on the engine's
//   worker and its progress comes in `mobile.autoTags.progress`, shown as desktop's readout.
// - Hide from Inbox stays with a rule (it applies on desktop); the phone's list does not hide
//   mail, so the page does not offer it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoTagsView } from '../../components/settings/views/AutoTagsView';
import { daemonCall, listen } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { AiReview, aiErrorKey } from '../AiActions.jsx';
import { ensureTags, refreshTags, useTagStore } from '../tags.js';

/** An engine refusal (`{ok: false, code}`) as an error the view shows through `errorText`. */
function refusal(reply) {
  const e = new Error(reply.code);
  e.code = reply.code;
  return e;
}

export default function AutoTags() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const url = (useMobileStore((s) => s.prefs?.aiEndpointUrl) || '').trim();
  const model = (useMobileStore((s) => s.prefs?.aiEndpointModel) || '').trim();
  const tags = useTagStore((s) => s.tags);
  const [rules, setRules] = useState([]);
  const [status, setStatus] = useState(null);
  const [backfills, setBackfills] = useState({});
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await daemonCall('mobile.autoTags.status', {});
      if (!mounted.current) return;
      setStatus(s);
      setBackfills(s?.backfills || {});
    } catch {
      // The page still lists and edits rules.
    }
  }, []);

  useEffect(() => {
    ensureTags();
    daemonCall('mobile.autoTags.list', {}).then((r) => { if (mounted.current) setRules(r?.rules || []); }, () => {});
    loadStatus();
    let stop = () => {};
    try {
      stop = listen('mobile.autoTags.progress', (p) => {
        if (!p?.ruleId || !mounted.current) return;
        setBackfills((b) => ({ ...b, [p.ruleId]: p }));
      });
    } catch {
      // No event bridge (plain browser dev): the readout follows the next status read.
    }
    return () => { if (typeof stop === 'function') stop(); };
  }, [loadStatus]);
  // The endpoint changed in Settings > AI: whether it leaves the phone changed with it.
  useEffect(() => { loadStatus(); }, [url, loadStatus]);

  const accountOptions = useMemo(() => accounts.map((a) => ({ value: a.id, label: a.email })), [accounts]);

  const saved = (reply) => {
    if (mounted.current) setRules(reply?.rules || []);
    return reply?.rule;
  };
  const onCreate = (draft) => daemonCall('mobile.autoTags.create', { rule: draft }).then(saved);
  const onUpdate = (id, draft) => daemonCall('mobile.autoTags.update', { id, rule: draft }).then(saved);
  const onDelete = (id) => daemonCall('mobile.autoTags.delete', { id }).then(saved, () => {});
  const onCreateTag = async (name) => {
    const id = await useTagStore.getState().createTag(name);
    return id ? { id } : null;
  };
  const onPreview = useCallback(async ({ rule, accountId }) => {
    const reply = await daemonCall('mobile.autoTags.preview', { rule, accountId });
    if (reply?.ok === false) throw refusal(reply);
    return Array.isArray(reply?.candidates) ? reply.candidates : [];
  }, []);
  const onBackfill = async ({ ruleId, accountId }) => {
    const reply = await daemonCall('mobile.autoTags.backfill', { ruleId, accountId });
    if (reply?.ok === false) throw refusal(reply);
    setBackfills((b) => ({ ...b, [ruleId]: { batchId: reply.batchId, ruleId, processed: 0, total: 0, matched: 0, done: false } }));
  };
  const onUndo = async (ruleId, batchId) => {
    try {
      await daemonCall('mobile.autoTags.undoBackfill', { batchId });
      // The rows on screen ask for their tags again.
      refreshTags();
    } finally {
      if (mounted.current) {
        setBackfills((b) => {
          if (b[ruleId]?.batchId !== batchId) return b;
          const next = { ...b };
          delete next[ruleId];
          return next;
        });
      }
    }
  };

  const errorText = (e) => {
    if (e?.code === 'NEEDS_REMOTE') return t('mobile.autoTag.needsRemote');
    if (e?.code) return t(aiErrorKey(e.code));
    return e?.message || String(e);
  };
  const configured = status?.configured === true;
  const runsHere = (rule) => rule.allowRemote && rule.provider?.type === 'endpoint' && (rule.provider.url || '').trim() === url;
  let notice = null;
  if (status && !configured) notice = <p className="text-xs text-mail-warning mb-3" role="note">{t('mobile.ai.notConfigured')}</p>;
  else if (status?.googleSkipped?.length) notice = <p className="text-xs text-mail-text-muted mb-3" role="note">{t('mobile.ai.googleNote')}</p>;

  return (
    <AutoTagsView rules={rules} backfills={backfills} tags={tags} accountOptions={accountOptions}
      defaultAccountId={accounts[0]?.id || ''}
      onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} onCreateTag={onCreateTag}
      onPreview={onPreview} onBackfill={onBackfill} onUndo={onUndo}
      currentProvider={() => (url ? { type: 'endpoint', url, model } : null)}
      errorText={errorText} autoPreview={false} showInboxAction={false}
      intro={t('mobile.autoTag.intro')} allowRemoteHint={t('mobile.autoTag.allowRemoteHint')} notice={notice}
      ruleNote={(rule) => (configured && !runsHere(rule) ? t('mobile.autoTag.needsRemote') : null)}
      renderRemoteConfirm={({ open, text, onCancel, onConfirm }) => (open ? (
        <AiReview review={{ prompt: text, destination: url, leavesDevice: Boolean(status?.leavesDevice) }}
          onCancel={onCancel} onConfirm={onConfirm} />
      ) : null)} />
  );
}
