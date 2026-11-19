// Settings > Views on the phone: desktop's Views page and view editor (ViewsSettingsView,
// ViewEditorView) over the engine (`mobile.views.*`, engine `views.rs`, through the phone's view
// cache views.js), the phone's tags (tags.js), the active account's custom fields (fields.js) and
// its accounts. It works as desktop's page does: New makes an empty view first (refused past the
// free plan's three, which opens the paywall), a row opens its editor under the list, and a new
// view nobody saved goes when its editor is left. The editor's typeaheads and its preview read the
// phone's own index (`mobile.views.suggestSenders`, `.suggestTerms`, `.evaluate` with the
// definition), so a view finds only the mail the phone keeps offline: the page says so. A view's
// mail on the phone is one list, newest first, so the editor leaves out desktop's Presentation
// (grouping, sort, direction, timeline); a view keeps the values desktop gave it.
//
// Leaving an editor with edits asks first, as desktop's unsaved-changes prompt does (its words and
// its list of what changed, in a sheet): system Back while an editor is open, a tap on another
// row or New, and the page's own Back (`onLeaveGuard` hands Settings the check).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ViewsSettingsView } from '../../components/settings/views/ViewsSettingsView';
import { ViewEditorView } from '../../components/settings/views/ViewEditorView';
import { ViewPreviewView } from '../../components/settings/views/ViewPreviewView';
import { MAX_FREE_VIEWS, viewLimitReached } from '../../utils/viewLimit.js';
import { useMobileStore } from '../store.js';
import { useViewStore, ensureViews } from '../views.js';
import { useTagStore, ensureTags } from '../tags.js';
import { useFieldStore, requestFields } from '../fields.js';
import { daemonCall } from '../transport.js';
import { errorKey } from '../errors.js';
import { useBackLayer } from '../backStack.js';
import { useT } from '../i18n.js';
import Sheet from '../Sheet.jsx';
import { MobileViewEnv } from './MobileViewEnv.jsx';

/** Query suggestions per page, as desktop's editor asks. */
const TERM_PAGE = 20;
const NO_FIELDS = Object.freeze([]);

/** The sheet a delete asks in (desktop's ConfirmDialog's words). */
function ConfirmSheet({ open, onClose, onConfirm, title, description, confirmLabel, cancelLabel, loading }) {
  if (!open) return null;
  return (
    <Sheet kind="sheet" label={title} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{title}</h2>
      {description && <p className="mv-sheet__text" dir="auto">{description}</p>}
      <div className="mv-sheet__actions">
        <button type="button" className="mv-sheet__action mv-sheet__action--danger" disabled={loading} onClick={onConfirm}>{confirmLabel}</button>
        <button type="button" className="mv-sheet__action" onClick={onClose}>{cancelLabel}</button>
      </div>
    </Sheet>
  );
}

/** Desktop's unsaved-changes prompt in a sheet: what changed, then save, discard or keep editing. */
function LeaveSheet({ changes, busy, onAnswer }) {
  const t = useT();
  return (
    <Sheet kind="sheet" label={t('unsaved.title')} onClose={() => onAnswer('keep')}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('unsaved.title')}</h2>
      <p className="mv-sheet__text">{t('unsaved.body')}</p>
      <ul className="mv-sheet__text list-disc ps-5" data-mv-unsaved-list>
        {changes.map((change) => (typeof change === 'string'
          ? <li key={change}>{change}</li>
          : <li key={change.key} dir="auto">{change.label}: {change.after}</li>))}
      </ul>
      <div className="mv-sheet__actions">
        <button type="button" className="mv-sheet__action" disabled={busy} onClick={() => onAnswer('save')}>{t('unsaved.save')}</button>
        <button type="button" className="mv-sheet__action mv-sheet__action--danger" disabled={busy} onClick={() => onAnswer('discard')}>{t('common.discard')}</button>
        <button type="button" className="mv-sheet__action" disabled={busy} onClick={() => onAnswer('keep')}>{t('unsaved.keep')}</button>
      </div>
    </Sheet>
  );
}

/**
 * `startNew`: open on a new view (the drawer's +; `onStarted()` says it was). `onLeaveGuard(check)`: Settings' Back asks
 * `check(leave)` while this page is open; null when it closes.
 */
export default function Views({ startNew = false, onStarted, onLeaveGuard }) {
  const t = useT();
  const views = useViewStore((s) => s.views);
  const premium = useMobileStore((s) => s.premium.premium);
  const accountsAll = useMobileStore((s) => s.accounts);
  const active = useMobileStore((s) => s.activeAccountId);
  const accountId = accountsAll.some((a) => a.id === active) ? active : accountsAll[0]?.id || null;
  const tags = useTagStore((s) => s.tags);
  const schema = useFieldStore((s) => (accountId && s.fields[accountId]) || NO_FIELDS);
  const [editingId, setEditingId] = useState(null);
  const [newlyCreatedId, setNewlyCreatedId] = useState(null);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  /// The open editor's unsaved-changes guard (`{ changes, save, discard }`), and the question a
  /// leave is waiting on.
  const guard = useRef(null);
  const [asking, setAsking] = useState(null);
  const [answering, setAnswering] = useState(false);
  /// The draft's id, read at the moment of discarding: a leave held by the question runs later
  /// than the render that queued it.
  const draft = useRef(null);
  const setDraft = (id) => { draft.current = id; setNewlyCreatedId(id); };
  const switching = useRef(false);
  const editorRef = useRef(null);

  useEffect(() => {
    ensureViews();
    ensureTags();
  }, []);
  useEffect(() => { if (accountId) requestFields(accountId); }, [accountId]);

  const full = viewLimitReached(views, premium);
  const say = (cause) => (cause?.code === 'PREMIUM_REQUIRED' ? t('views.limitReached', { max: MAX_FREE_VIEWS }) : t(errorKey(cause?.code)));

  /// A new view never saved goes with its editor, once.
  const discardUnsaved = async () => {
    const id = draft.current;
    setDraft(null);
    if (id && useViewStore.getState().views.some((view) => view.id === id)) await useViewStore.getState().deleteView(id);
  };

  /// Every way away from an open editor asks first when it holds edits.
  const leave = useCallback((action) => {
    if (guard.current?.changes?.length) setAsking({ action });
    else void action();
  }, []);

  const answer = async (choice) => {
    const pending = asking;
    if (!pending) return;
    if (choice === 'keep') { setAsking(null); return; }
    setAnswering(true);
    try {
      if (choice === 'save') {
        if (!(await guard.current?.save())) { setAsking(null); return; }
      } else {
        await guard.current?.discard();
      }
      guard.current = null;
      setAsking(null);
      await pending.action();
    } finally {
      setAnswering(false);
    }
  };

  const openPaywall = () => useMobileStore.getState().openPaywall(null);

  const newView = async () => {
    if (switching.current) return;
    switching.current = true;
    try {
      setError('');
      await discardUnsaved();
      const view = {
        id: globalThis.crypto?.randomUUID?.() || `view-${Date.now()}`,
        name: t('views.new'),
        icon: 'tag',
        // The engine puts a new view last on its own.
        position: 0,
        builtin: null,
        def: {},
      };
      // Asked before the builder opens: filling one in only to be refused at Save is the worse order.
      const reply = await useViewStore.getState().createView(view, premium);
      if (!reply.ok) {
        setRefused(true);
        openPaywall();
        return;
      }
      setRefused(false);
      setEditingId(view.id);
      setDraft(view.id);
    } catch (cause) {
      setError(say(cause));
    } finally { switching.current = false; }
  };

  const selectView = async (id) => {
    if (switching.current) return;
    switching.current = true;
    try {
      setError('');
      if (draft.current) await discardUnsaved();
      setEditingId((current) => (current === id ? null : id));
    } catch (cause) {
      setError(say(cause));
    } finally { switching.current = false; }
  };

  const closeEditor = async (saved) => {
    if (switching.current) return;
    switching.current = true;
    try {
      if (!saved) await discardUnsaved();
      else setDraft(null);
      setEditingId(null);
    } catch (cause) {
      setError(say(cause));
    } finally { switching.current = false; }
  };

  // The drawer's + opens the page on a new view, once.
  const started = useRef(false);
  useEffect(() => {
    if (!startNew || started.current) return;
    started.current = true;
    onStarted?.();
    void newView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNew]);

  // System Back with an editor open leaves the editor (asking first), not the page. Off while the
  // question is up, so Keep editing arms it again.
  useBackLayer(Boolean(editingId) && !asking, () => leave(() => closeEditor(false)));
  // Back while the question is up is Keep editing.
  useBackLayer(Boolean(asking), () => setAsking(null));
  // The page's own Back asks the same.
  useEffect(() => {
    onLeaveGuard?.((then) => leave(then));
    return () => onLeaveGuard?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLeaveGuard, leave]);

  // However the page is left (its own Back, a search result, Settings closing), a new view nobody
  // saved goes with it, as system Back's editor close takes it.
  useEffect(() => () => {
    const id = draft.current;
    draft.current = null;
    if (id && useViewStore.getState().views.some((view) => view.id === id)) {
      void useViewStore.getState().deleteView(id).catch(() => {});
    }
  }, []);

  // An editor opens under the list: brought into view.
  useEffect(() => {
    if (editingId) editorRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [editingId]);

  const onGuard = useCallback((next) => { guard.current = next; }, []);
  const suggestSenders = useCallback((prefix, accounts) => daemonCall('mobile.views.suggestSenders', { prefix, accounts, limit: 8 })
    .then((reply) => (Array.isArray(reply?.senders) ? reply.senders : []).map((sender) => ({
      value: sender.address,
      label: sender.name || sender.address,
      detail: [sender.name ? sender.address : '', sender.count].filter(Boolean).join(' · '),
    })))
    .catch(() => []), []);
  const suggestTerms = useCallback((prefix, offset, accounts) => daemonCall('mobile.views.suggestTerms', { prefix, accounts, offset, limit: TERM_PAGE })
    .then((reply) => (Array.isArray(reply?.terms) ? reply.terms : []).map((term) => ({ value: term.term, label: term.term, detail: String(term.count) })))
    .catch(() => []), []);
  /// The preview: the definition run over the phone's index, its first page (`limit` rows).
  const preview = useCallback(async (def, limit) => {
    try {
      const reply = await daemonCall('mobile.views.evaluate', { def });
      if (reply?.available === false) return { available: false, reason: 'unavailable', rows: [], total: 0 };
      return {
        available: true,
        total: reply?.total ?? 0,
        rows: (reply?.rows ?? []).slice(0, limit).map((row) => ({
          key: `${row.accountId}|${row.folder}|${row.uid}`,
          sender: row.fromName || row.fromAddress || '',
          subject: row.subject,
          date: row.dateMs,
        })),
      };
    } catch {
      return { available: false, reason: 'error', rows: [], total: 0 };
    }
  }, []);

  const editing = views.find((view) => view.id === editingId);
  const store = useViewStore.getState();
  return (
    <MobileViewEnv>
      <ViewsSettingsView views={views} editingId={editingId} premium={premium} full={full} max={MAX_FREE_VIEWS}
        refused={refused} error={error} onUpgrade={openPaywall}
        note={<p className="mt-3 text-xs text-mail-text-muted" data-mv-views-note>{t('mobile.views.offlineNote')}</p>}
        onNew={() => leave(newView)} onSelect={(id) => leave(() => selectView(id))}
        onReorder={(ids) => { void store.reorderViews(ids).catch((cause) => setError(say(cause))); }}>
        {editing && (
          <div ref={editorRef} data-mv-view-editor={editing.id}>
            <ViewEditorView key={editing.id} view={editing} isNew={editing.id === newlyCreatedId} presentation={false}
              accounts={accountsAll} tags={tags} schema={schema}
              suggestSenders={suggestSenders} suggestTerms={suggestTerms}
              onSave={store.saveView} onDelete={store.deleteView} errorText={say} onGuard={onGuard}
              onSaved={() => setDraft(null)} onDiscard={discardUnsaved} onClose={closeEditor}
              renderPreview={(def) => <ViewPreviewView def={def} run={preview} />}
              renderConfirm={(props) => <ConfirmSheet {...props} />} />
          </div>
        )}
      </ViewsSettingsView>
      {asking && <LeaveSheet changes={guard.current?.changes || []} busy={answering} onAnswer={(choice) => { void answer(choice); }} />}
    </MobileViewEnv>
  );
}
