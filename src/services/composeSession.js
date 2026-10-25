import { useCallback, useEffect, useRef, useState } from 'react';
import { splitWireHtml } from '../utils/quoteWire';
import { safeStorage, flushSafeStorage } from '../stores/safeStorage';
import { flushSync } from 'react-dom';
import { t } from '../i18n/index.js';

const KEY = 'mailvault-compose-session';

// Shared identity allocation stays free of the mail-store/import graph.
export const newDraftId = () => globalThis.crypto.randomUUID();

const unfinished = (window) => Boolean(window?.initialData);

export const composeSessionData = window => window.snapshot || window.initialData;
const dataFor = composeSessionData;
export const isTerminalCompose = data => Boolean(data?._draftCleanupOnly || data?._draftTerminal);
const discardSessionDraft = snapshot => import('./localDrafts').then(module => module.discardDraftFor(snapshot));
const cleanupSessionDraft = snapshot => import('./localDrafts').then(module => module.cleanupDraftFor(snapshot));
const conditionalCleanup = data => ['sent', 'scheduled'].includes(data?._draftTerminal);
const terminalRequestKey = (data, kind = data?._draftTerminal) => JSON.stringify([
  data?._draftId || [data?._draftAccountId || data?._accountId, data?._draftMailbox, data?._draftUid],
  kind, kind === 'discard' ? null : data?._draftCleanupThroughRevision ?? data?._draftRevision,
]);
const sameSessionRecord = (left, right) => sameComposeDraft(left, right)
  && !(isTerminalCompose(left) && isTerminalCompose(right) && terminalRequestKey(left) !== terminalRequestKey(right));
const reconcileSessionDraft = (id, fence) => import('./localDrafts').then(module => module.reconcileLocalDraft(id, fence));
const projectionSignal = data => JSON.stringify([data?._draftId, data?._draftAcceptedRevision, data?._draftAccountId, data?._draftMailbox, data?._draftUid, data?._draftTerminal, data?._draftCleanupState]);

export function sameComposeDraft(left, right) {
  if (!left || !right) return false;
  if (left._draftId && right._draftId) return left._draftId === right._draftId;
  return Boolean(left._draftUid && right._draftUid && left._draftMailbox && right._draftMailbox
    && left._draftUid === right._draftUid && left._draftMailbox === right._draftMailbox
    && (left._draftAccountId || left._accountId) === (right._draftAccountId || right._accountId));
}

// Content and accepted location advance independently. A shorter complete
// edit can be newer than disk; a legacy session keeps its existing words.
export function mergeComposeSnapshot(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  if (!sameComposeDraft(current, incoming)) return incoming;
  // Terminal intent cannot become editable through a late save or hydration.
  if (isTerminalCompose(current) || isTerminalCompose(incoming)) {
    const terminal = current._draftTerminal === 'discard' ? current : incoming._draftTerminal === 'discard' ? incoming
      : isTerminalCompose(current) ? current : incoming;
    const other = terminal === current ? incoming : current;
    if (conditionalCleanup(terminal) && !isTerminalCompose(other)) return { ...terminal,
      _draftCleanupContender: mergeComposeSnapshot(terminal._draftCleanupContender, other) };
    return { ...other, ...terminal };
  }
  const currentVersioned = Number.isSafeInteger(current._draftRevision);
  const incomingVersioned = Number.isSafeInteger(incoming._draftRevision);
  let content = currentVersioned !== incomingVersioned
    ? (currentVersioned ? incoming : current)
    : (current._draftRevision || 0) > (incoming._draftRevision || 0) ? current : incoming;
  const sameRevision = currentVersioned && incomingVersioned && current._draftRevision === incoming._draftRevision;
  if (sameRevision && compatibleContent(current, incoming)) content = joinContent(current, incoming);
  const accepted = (current._draftAcceptedRevision || 0) > (incoming._draftAcceptedRevision || 0) ? current : incoming;
  const request = content._draftContent;
  const exactAcceptance = request && [current, incoming].some(data => data._draftContent
    && data._draftRevision === content._draftRevision && data._draftAcceptedRevision === content._draftRevision
    && !data._draftAcceptanceUnknown && JSON.stringify(requestEvidence(data._draftContent)) === JSON.stringify(requestEvidence(request)));
  const acceptanceUnknown = request && !exactAcceptance && (content._draftAcceptanceUnknown
    || (accepted._draftAcceptedRevision || 0) >= (content._draftRevision || 0));

  return { ...content,
    _draftId: current._draftId || incoming._draftId,
    _draftRevision: content._draftRevision || 0,
    _draftAcceptedRevision: accepted._draftAcceptedRevision || 0,
    ...(request ? { _draftAcceptanceUnknown: Boolean(acceptanceUnknown) } : {}),
    _draftAccountId: accepted._draftAccountId || accepted._accountId,
    _draftMailbox: accepted._draftMailbox,
    _draftUid: accepted._draftUid,
  };
}

// Weak memoization is scoped to the restored array (one hydration attempt),
// so React updater replay allocates the same recovery identity. Durable exact
// provenance below also recognizes that recovery after save/load/remerge.
const hydrationIds = new WeakMap();
const clone = value => JSON.parse(JSON.stringify(value));
const editable = data => data && !data._editScheduledId && !data._draftCleanupOnly
  && !data._draftTerminal && !data._discarded && !data._sent;
function completeContent(data) {
  const request = data._draftContent || data._draftRecoveredContent;
  const payload = request?.payload || {};
  const wire = payload.html == null ? {} : splitWireHtml(payload.html);
  return {
    to: data.to ?? payload.to, cc: data.cc ?? payload.cc, bcc: data.bcc ?? payload.bcc,
    subject: data.subject ?? payload.subject, body: data.body ?? wire.body,
    inReplyTo: data.inReplyTo ?? payload.inReplyTo, references: data.references ?? payload.references,
    attachments: data.attachments && payload.attachments && data.attachments.length === payload.attachments.length
      ? joinKnown(data.attachments, payload.attachments) : data.attachments ?? payload.attachments,
    _quotedHtml: data._quotedHtml ?? wire.quotedHtml, _forward: data._forward ?? wire.forward,
    _accountId: data._accountId ?? request?.accountId, _fromAddress: data._fromAddress ?? request?.fromAddress,
    // Retain request-only plain text, snippet and sender as complete content.
    request: request ? { accountId: request.accountId, fromAddress: request.fromAddress, displayName: request.displayName,
      payload: request.payload, snippet: request.snippet } : null,
  };
}
// These bounded content trees retain explicit empty values. Missing is
// unknown: compatibility does not establish equality or native acceptance.
function compatibleKnown(left, right) {
  if (left === undefined || right === undefined) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => compatibleKnown(value, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => compatibleKnown(left[key], right[key]));
  }
  return left === right;
}
function joinKnown(preferred, other) {
  if (preferred === undefined) return other;
  if (other === undefined) return preferred;
  if (Array.isArray(preferred)) return preferred.map((value, index) => joinKnown(value, other[index]));
  if (preferred && other && typeof preferred === 'object' && typeof other === 'object') {
    return Object.fromEntries([...new Set([...Object.keys(preferred), ...Object.keys(other)])].map(key => [key, joinKnown(preferred[key], other[key])]));
  }
  return preferred;
}
const attachmentEvidence = attachment => ({ filename: attachment.filename, contentType: attachment.contentType,
  content: attachment.content ?? undefined, encoding: attachment.encoding ?? (attachment.content != null ? 'base64' : undefined),
  cid: attachment.cid ?? undefined,
  source: attachment.source || attachment._source,
});
function requestEvidence(request) {
  const payload = request.payload || {};
  return { accountId: request.accountId, fromAddress: request.fromAddress, displayName: request.displayName,
    payload: { to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, html: payload.html, text: payload.text,
      inReplyTo: payload.inReplyTo, references: payload.references, attachments: payload.attachments?.map(attachmentEvidence) }, snippet: request.snippet };
}
function nativeKnowledge(data) {
  return data._draftNativeContent && data._draftNativeContent.revision === data._draftRevision ? data._draftNativeContent : data._draftRecoveredKnown || {};
}
function contentEvidence(data) {
  const { request, ...form } = completeContent(data);
  const native = nativeKnowledge(data);
  form.attachments = form.attachments?.map(attachmentEvidence);
  const exact = request ? requestEvidence(request) : { payload: {} };
  // Native text/name/HTML are known return values, never a fake complete
  // request. In particular, no preview snippet becomes a raw snippet.
  const wire = joinKnown(exact, { displayName: native.displayName, payload: { html: native.html, text: native.text } });
  return { form, wire };
}
function compatibleContent(left, right) {
  const a = contentEvidence(left), b = contentEvidence(right);
  if (!compatibleKnown(a, b)) return false;
  // An unresolved descriptor cannot prove agreement with supplied bytes.
  // Native must resolve that relationship; retain both recoverable versions.
  return !(a.form.attachments && b.form.attachments && a.form.attachments.some((attachment, index) => {
    const other = b.form.attachments[index];
    return (attachment.content !== undefined && other.content === undefined && other.source !== undefined)
      || (other.content !== undefined && attachment.content === undefined && attachment.source !== undefined);
  }));
}
function joinContent(current, incoming) {
  // Keep the richer exact request atomic, with its revision/UI signature.
  const preferred = current._draftContent && !incoming._draftContent ? current
    : current._draftRecoveredContent && !incoming._draftContent && !incoming._draftRecoveredContent ? current : incoming;
  const other = preferred === current ? incoming : current;
  const { request: _preferredRequest, ...preferredForm } = completeContent(preferred);
  const { request: _otherRequest, ...otherForm } = completeContent(other);
  const form = joinKnown(preferredForm, otherForm);
  const native = joinKnown(nativeKnowledge(preferred), nativeKnowledge(other));
  return { ...preferred, ...form,
    ...(Object.keys(native).length ? { _draftNativeContent: { ...native, revision: preferred._draftRevision } } : {}),
  };
}
function recoveredWindow(window, provenance, draftId) {
  const source = dataFor(window);
  const { request, ...content } = completeContent(source);
  const data = { ...clone(source), ...clone(content) };
  for (const field of ['_draftId', '_draftRevision', '_draftAcceptedRevision', '_draftAccountId', '_draftMailbox', '_draftUid',
    '_draftContent', '_draftUiSignature', '_draftAcceptanceUnknown', '_draftNativeContent', '_draftPreviousIdentity', 'previousIdentity', '_composeWindowId',
    '_draftCleanupOnly', '_draftTerminal', '_draftCleanupState', '_draftCleanupThroughRevision', '_draftCleanupPersistError', '_draftCleanupContender']) delete data[field];
  Object.assign(data, { _draftId: draftId, _draftRevision: 0, _draftAcceptedRevision: 0, _draftRecovery: provenance,
    ...(request ? { _draftRecoveredContent: clone(request) } : {}),
    ...(Object.keys(nativeKnowledge(source)).length ? { _draftRecoveredKnown: clone(nativeKnowledge(source)) } : {}) });
  return { ...window, initialData: data, snapshot: data, minimized: true, detached: false, nativeLabel: undefined };
}

export function mergeComposeSession(current, restored) {
  let nextId = Math.max(0, ...current.map(window => window.id || 0), ...restored.map(window => window.id || 0));
  const merged = [...current];
  const used = new Set(current.map(window => window.id));
  let ids = hydrationIds.get(restored);
  if (!ids) { ids = new Map(); hydrationIds.set(restored, ids); }
  for (const [sourceIndex, sourceWindow] of restored.entries()) {
    let window = sourceWindow;
    const existing = merged.find(item => sameSessionRecord(dataFor(item), dataFor(window)));
    if (existing && editable(dataFor(existing)) && editable(dataFor(window))
        && dataFor(existing)._draftId && dataFor(existing)._draftId === dataFor(window)._draftId
        && (dataFor(existing)._draftRevision || 0) === (dataFor(window)._draftRevision || 0)
        && !compatibleContent(dataFor(existing), dataFor(window))) {
      const provenance = JSON.stringify([dataFor(window)._draftId, dataFor(window)._draftRevision || 0, window.id, sourceIndex]);
      const exactContent = JSON.stringify(contentEvidence(dataFor(window)));
      const recovered = merged.find(item => dataFor(item)?._draftRecovery === provenance
        && compatibleContent(dataFor(item), dataFor(window)));
      if (recovered) {
        // Retain newly known fields too. Skipping a compatible unknown view
        // would forget evidence needed to distinguish a later conflict.
        const normalized = recoveredWindow(window, provenance, dataFor(recovered)._draftId);
        const data = joinContent(dataFor(recovered), dataFor(normalized));
        merged[merged.indexOf(recovered)] = { ...recovered, initialData: data, snapshot: data };
        continue;
      }
      const memoKey = provenance + exactContent;
      if (!ids.has(memoKey)) ids.set(memoKey, newDraftId());
      window = recoveredWindow(window, provenance, ids.get(memoKey));
    } else if (existing) {
      const data = mergeComposeSnapshot(dataFor(existing), dataFor(window));
      merged[merged.indexOf(existing)] = { ...existing, initialData: data, snapshot: data,
        ...(isTerminalCompose(data) ? { minimized: true, detached: false, nativeLabel: undefined, _terminalActive: false } : {}) };
      continue;
    }
    if (!used.has(window.id)) {
      used.add(window.id);
      merged.push(window);
    } else {
      nextId += 1;
      used.add(nextId);
      merged.push({ ...window, id: nextId });
    }
  }
  return merged;
}

export async function loadComposeSession() {
  try {
    const raw = await safeStorage.getItem(KEY);
    const windows = raw ? JSON.parse(raw) : [];
    return Array.isArray(windows)
      ? windows.filter(unfinished).map(window => ({ ...window, minimized: true, detached: false, nativeLabel: undefined }))
      : [];
  } catch { return []; }
}

export function saveComposeSession(windows) {
  const drafts = windows
    .map(({ _awaitDraftHydration, _terminalActive, ...window }) => ({ ...window, initialData: window.snapshot || window.initialData, snapshot: undefined }))
    .filter(unfinished)
    .map(window => ({ ...window, minimized: true, detached: false, nativeLabel: undefined }));
  if (!drafts.length) return clearComposeSession();
  safeStorage.setItem(KEY, JSON.stringify(drafts));
}

export function clearComposeSession() {
  safeStorage.removeItem(KEY);
}


// App's existing hydration and draft-open state owner, also exercised with
// the real editor without mounting the unrelated mail shell.
export function useComposeSessionHydration({ windows, setWindows, idRef, focus, loader = loadComposeSession, persist = saveComposeSession,
  discard = discardSessionDraft, discardThrough = cleanupSessionDraft, flush = flushSafeStorage, reconcile = reconcileSessionDraft }) {
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const terminalOperations = useRef(new Map());
  const projectionSignals = useRef(new Map());
  const restoredCleanup = useRef(new Set());
  // This rare operation must persist the committed array, including updates
  // from other compose windows. flushSync commits pending React updates before
  // reading it; cache writes alone never acknowledge a durable settings write.
  const commit = useCallback(updater => { flushSync(() => setWindows(updater)); }, [setWindows]);
  const removeSource = useCallback(id => setWindows(prev => prev.filter(window => window.id !== id || isTerminalCompose(dataFor(window)))), [setWindows]);
  const terminalCleanup = useCallback((snapshot, kind = 'discard', sourceId) => {
    const captured = clone(snapshot || {});
    const conditional = kind !== 'discard';
    if (!captured._draftId && !captured._draftUid) return Promise.resolve({ discarded: true, cleanup: 'complete' });
    if (conditional) {
      const bound = captured._draftCleanupThroughRevision ?? captured._draftRevision;
      if (!captured._draftId || !Number.isSafeInteger(bound) || bound < 0) {
        return Promise.resolve({ discarded: false, skipped: true, reason: 'unbound_revision' });
      }
      captured._draftCleanupThroughRevision = bound;
    }
    const key = terminalRequestKey(captured, kind);
    if (terminalOperations.current.has(key)) return terminalOperations.current.get(key);
    restoredCleanup.current.add(key);
    let ownerId, retained = false;
    // Reserve before any await. A newly reopened live owner is never the old
    // send's captured source, even when its parent snapshot has not advanced.
    commit(prev => {
      const existing = prev.find(window => window.id === sourceId && sameComposeDraft(dataFor(window), captured));
      if (conditional && prev.some(window => sameComposeDraft(dataFor(window), captured) && !isTerminalCompose(dataFor(window))
        && (window.id !== sourceId || (dataFor(window)._draftRevision || 0) > captured._draftCleanupThroughRevision))) {
        retained = true;
        return prev;
      }
      const retry = prev.find(window => sameComposeDraft(dataFor(window), captured) && isTerminalCompose(dataFor(window))
        && dataFor(window)._draftTerminal === kind && dataFor(window)._draftCleanupThroughRevision === captured._draftCleanupThroughRevision);
      const source = retry || existing || (!conditional && prev.find(window => sameComposeDraft(dataFor(window), captured)));
      ownerId = retry?.id || (!conditional && source?.id) || ownerId || ++idRef.current;
      const data = { ...captured, _draftCleanupOnly: true, _draftTerminal: kind,
        _draftCleanupState: captured._draftCleanupState || 'unknown', _draftCleanupPersistError: false };
      const owner = { ...source, id: ownerId, initialData: data, snapshot: data,
        _terminalActive: Boolean(!conditional && source && !source.minimized && !source.detached),
        minimized: conditional || !source || source.minimized || source.detached, detached: false, nativeLabel: undefined };
      return [...prev.filter(window => window.id !== ownerId && window.id !== source?.id), owner];
    });
    if (retained) {
      void Promise.resolve().then(() => reconcile(captured._draftId)).catch(() => {});
      return Promise.resolve({ draftId: captured._draftId, discarded: false, skipped: true, reason: 'retained_current' });
    }
    const operation = (async () => {
      let result;
      try {
        result = await (conditional ? discardThrough(captured) : discard(captured));
        const skipped = conditional && result?.discarded === false && result.skipped === true && result.reason === 'newer_revision';
        if (!skipped && (!result?.discarded || !['complete', 'pending'].includes(result.cleanup))) throw new Error(t('compose.draftCleanupUnknown'));
      } catch { result = { draftId: captured._draftId, discarded: false, cleanup: 'unknown' }; }
      let recoveryId, recoveryDraftId;
      commit(prev => {
        const owner = prev.find(window => window.id === ownerId);
        if (!owner) return prev;
        const data = dataFor(owner);
        const contender = data._draftCleanupContender;
        const settled = result.skipped || result.cleanup !== 'unknown';
        const keep = !result.skipped && result.cleanup !== 'complete';
        let next = prev.filter(window => window.id !== ownerId);
        if (keep) {
          const retainedData = { ...data, _draftId: result.draftId || captured._draftId, _draftCleanupState: result.cleanup };
          if (settled) delete retainedData._draftCleanupContender;
          next.push({ ...owner, initialData: retainedData, snapshot: retainedData, minimized: true, _terminalActive: false });
        }
        if (contender && settled) {
          recoveryId ||= ++idRef.current;
          if (result.skipped) next.push({ id: recoveryId, initialData: contender, snapshot: contender, minimized: false });
          else {
            recoveryDraftId ||= newDraftId();
            next.push({ ...recoveredWindow({ id: recoveryId, initialData: contender },
              JSON.stringify([captured._draftId, captured._draftCleanupThroughRevision, 'terminal-recovery']), recoveryDraftId), id: recoveryId });
          }
        }
        return next;
      });
      if (!result.skipped && result.cleanup !== 'complete') {
        try {
          await persist(windowsRef.current);
          await flush();
        } catch {
          commit(prev => prev.map(window => {
            if (window.id !== ownerId) return window;
            const data = { ...dataFor(window), _draftCleanupPersistError: true };
            return { ...window, initialData: data, snapshot: data };
          }));
          result = { ...result, persistenceFailed: true };
        }
      }
      return result;
    })().finally(() => terminalOperations.current.delete(key));
    terminalOperations.current.set(key, operation);
    return operation;
  }, [commit, discard, discardThrough, flush, idRef, persist, reconcile]);
  const retryCleanup = useCallback(id => {
    const owner = windowsRef.current.find(window => window.id === id);
    return owner ? terminalCleanup(dataFor(owner), dataFor(owner)._draftTerminal, id) : Promise.resolve();
  }, [terminalCleanup]);
  useEffect(() => {
    let alive = true;
    const settle = restored => {
      if (!alive) return;
      setWindows(current => {
        const merged = mergeComposeSession(current, restored).map(window => {
          if (!window._awaitDraftHydration) return window;
          const { _awaitDraftHydration, ...released } = window;
          return { ...released, initialData: dataFor(window) };
        });
        idRef.current = Math.max(idRef.current, 0, ...merged.map(window => window.id || 0));
        return merged;
      });
      readyRef.current = true;
      setReady(true);
    };
    Promise.resolve().then(loader).then(settle, () => settle([]));
    return () => { alive = false; };
  }, [loader, setWindows, idRef]);
  useEffect(() => { if (ready) persist(windows); }, [ready, windows, persist]);
  const openDraft = useCallback(initialData => {
    const id = ++idRef.current;
    setWindows(prev => {
      const already = prev.find(w => sameComposeDraft(dataFor(w), initialData));
      if (already) {
        if (isTerminalCompose(dataFor(already))) {
          if (!conditionalCleanup(dataFor(already))) return prev;
          const data = { ...dataFor(already), _draftCleanupContender: mergeComposeSnapshot(dataFor(already)._draftCleanupContender, initialData) };
          return prev.map(window => window.id === already.id ? { ...window, snapshot: data, initialData: data } : window);
        }
        if (already.detached && already.nativeLabel) void Promise.resolve(focus?.(already.nativeLabel)).catch(() => {});
        return prev.map(w => {
          if (w.id !== already.id) return w;
          const saved = dataFor(w);
          const canonical = !saved?._draftId && initialData._draftId ? mergeComposeSnapshot(saved, initialData) : saved;
          return { ...w, initialData: canonical, snapshot: canonical, minimized: false };
        });
      }
      return [...prev, { id, minimized: false, initialData, ...(!readyRef.current ? { _awaitDraftHydration: true } : {}) }];
    });
  }, [focus, idRef, setWindows]);
  // App's existing identity-bearing Outbox/Undo restore branch, extracted
  // unchanged so its admission behavior is exercised without the mail shell.
  const restoreCompose = useCallback(state => {
    const id = ++idRef.current;
    setWindows(prev => [...prev, { id, minimized: false, ...state }]);
  }, [idRef, setWindows]);
  const saveState = useCallback((id, savedData) => {
    setWindows(prev => prev.map(w => {
      if (w.id !== id || JSON.stringify(w.snapshot) === JSON.stringify(savedData)) return w;
      return { ...w, snapshot: mergeComposeSnapshot(dataFor(w), savedData) };
    }));
  }, [setWindows]);
  useEffect(() => {
    if (!ready) return;
    for (const window of windows) {
      const data = dataFor(window);
      const key = terminalRequestKey(data);
      if (!isTerminalCompose(data) || restoredCleanup.current.has(key)) continue;
      restoredCleanup.current.add(key);
      // Restore/reconciliation is a single cleanup attempt, never a transport
      // retry or a polling worker. Existing live operations are coalesced.
      void Promise.resolve().then(() => terminalCleanup(data, data._draftTerminal, window.id));
    }
  }, [ready, windows, terminalCleanup]);
  useEffect(() => {
    const live = new Set(windows.map(window => window.id));
    for (const id of projectionSignals.current.keys()) if (!live.has(id)) projectionSignals.current.delete(id);
    for (const window of windows) {
      const data = dataFor(window);
      const signal = projectionSignal(data);
      const previous = projectionSignals.current.get(window.id);
      projectionSignals.current.set(window.id, signal);
      if (previous === undefined || previous === signal || !data?._draftId || isTerminalCompose(data)) continue;
      const id = window.id;
      const isCurrent = () => projectionSignals.current.get(id) === signal
        && windowsRef.current.some(owner => owner.id === id && !isTerminalCompose(dataFor(owner)) && projectionSignal(dataFor(owner)) === signal);
      void Promise.resolve().then(() => isCurrent() && reconcile(data._draftId, { isCurrent })).catch(() => {});
    }
  }, [windows, reconcile]);
  const canMount = useCallback(window => !window._awaitDraftHydration
    && (!isTerminalCompose(dataFor(window)) || Boolean(window._terminalActive)), []);
  return { ready, openDraft, restoreCompose, saveState, canMount, terminalCleanup, retryCleanup, removeSource };
}
