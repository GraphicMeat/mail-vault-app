import { useCallback, useEffect, useRef, useState } from 'react';
import { splitWireHtml } from '../utils/quoteWire';
import { safeStorage } from '../stores/safeStorage';

const KEY = 'mailvault-compose-session';

// Shared identity allocation stays free of the mail-store/import graph.
export const newDraftId = () => globalThis.crypto.randomUUID();

const unfinished = (window) => Boolean(window?.initialData);

const dataFor = window => window.snapshot || window.initialData;

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
  const legacy = !Number.isSafeInteger(current._draftRevision) && Number.isSafeInteger(incoming._draftRevision);
  const content = legacy || (current._draftRevision || 0) > (incoming._draftRevision || 0) ? current : incoming;
  const accepted = (current._draftAcceptedRevision || 0) > (incoming._draftAcceptedRevision || 0) ? current : incoming;
  return { ...content,
    _draftId: current._draftId || incoming._draftId,
    _draftRevision: content._draftRevision || 0,
    _draftAcceptedRevision: accepted._draftAcceptedRevision || 0,
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
  const wire = splitWireHtml(payload.html || '');
  return {
    to: data.to ?? payload.to ?? '', cc: data.cc ?? payload.cc ?? '', bcc: data.bcc ?? payload.bcc ?? '',
    subject: data.subject ?? payload.subject ?? '', body: data.body ?? wire.body ?? '',
    inReplyTo: data.inReplyTo ?? payload.inReplyTo ?? '', references: data.references ?? payload.references ?? '',
    attachments: data.attachments ?? payload.attachments ?? [],
    _quotedHtml: data._quotedHtml ?? wire.quotedHtml, _forward: data._forward ?? wire.forward,
    _accountId: data._accountId ?? request?.accountId, _fromAddress: data._fromAddress ?? request?.fromAddress,
    // Retain request-only plain text, snippet and sender as complete content.
    request: request ? { accountId: request.accountId, fromAddress: request.fromAddress, displayName: request.displayName,
      payload: request.payload, snippet: request.snippet } : null,
  };
}
function recoveredWindow(window, provenance, draftId) {
  const source = dataFor(window);
  const { request, ...content } = completeContent(source);
  const data = { ...clone(source), ...clone(content) };
  for (const field of ['_draftId', '_draftRevision', '_draftAcceptedRevision', '_draftAccountId', '_draftMailbox', '_draftUid',
    '_draftContent', '_draftUiSignature', '_draftPreviousIdentity', 'previousIdentity', '_composeWindowId']) delete data[field];
  Object.assign(data, { _draftId: draftId, _draftRevision: 0, _draftAcceptedRevision: 0, _draftRecovery: provenance,
    ...(request ? { _draftRecoveredContent: clone(request) } : {}) });
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
    const existing = merged.find(item => sameComposeDraft(dataFor(item), dataFor(window)));
    if (existing && editable(dataFor(existing)) && editable(dataFor(window))
        && dataFor(existing)._draftId && dataFor(existing)._draftId === dataFor(window)._draftId
        && (dataFor(existing)._draftRevision || 0) === (dataFor(window)._draftRevision || 0)
        && JSON.stringify(completeContent(dataFor(existing))) !== JSON.stringify(completeContent(dataFor(window)))) {
      const provenance = JSON.stringify([dataFor(window)._draftId, dataFor(window)._draftRevision || 0, window.id, sourceIndex]);
      const exactContent = JSON.stringify(completeContent(dataFor(window)));
      if (merged.some(item => dataFor(item)?._draftRecovery === provenance
          && JSON.stringify(completeContent(dataFor(item))) === exactContent)) continue;
      const memoKey = provenance + exactContent;
      if (!ids.has(memoKey)) ids.set(memoKey, newDraftId());
      window = recoveredWindow(window, provenance, ids.get(memoKey));
    } else if (existing) {
      const data = mergeComposeSnapshot(dataFor(existing), dataFor(window));
      merged[merged.indexOf(existing)] = { ...existing, initialData: data, snapshot: data };
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
    .map(({ _awaitDraftHydration, ...window }) => ({ ...window, initialData: window.snapshot || window.initialData, snapshot: undefined }))
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
export function useComposeSessionHydration({ windows, setWindows, idRef, focus, loader = loadComposeSession, persist = saveComposeSession }) {
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
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
  const saveState = useCallback((id, savedData) => {
    setWindows(prev => prev.map(w => {
      if (w.id !== id || JSON.stringify(w.snapshot) === JSON.stringify(savedData)) return w;
      return { ...w, snapshot: mergeComposeSnapshot(dataFor(w), savedData) };
    }));
  }, [setWindows]);
  const canMount = useCallback(window => !window._awaitDraftHydration, []);
  return { ready, openDraft, saveState, canMount };
}
