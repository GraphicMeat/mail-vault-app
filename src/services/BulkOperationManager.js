import { send } from './transport.js';
import { t } from '../i18n/index.js';
import { _parseSelKey } from '../stores/slices/unifiedHelpers.js';

export function groupBulkTargets(keys, { accountId, mailbox, spans = false }) {
  const groups = new Map();
  const refused = [];
  for (const key of keys || []) {
    const parsed = _parseSelKey(key);
    const target = parsed.accountId
      ? { accountId: parsed.accountId, mailbox: parsed.mailbox }
      : { accountId: spans ? null : accountId, mailbox };
    if (
      !target.accountId ||
      !target.mailbox ||
      target.mailbox === 'UNIFIED' ||
      !Number.isInteger(parsed.uid)
    ) {
      refused.push(key);
      continue;
    }
    const id = JSON.stringify([target.accountId, target.mailbox]);
    if (!groups.has(id)) groups.set(id, { ...target, uids: new Set() });
    groups.get(id).uids.add(parsed.uid);
  }
  return {
    groups: [...groups.values()].map((g) => ({ ...g, uids: [...g.uids] })),
    refused,
  };
}

const terminal = (status) =>
  ['complete', 'cancelled', 'error', 'awaitingResume'].includes(status);
const uuid = () =>
  globalThis.crypto?.randomUUID?.() ||
  `bulk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const stable = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]])
        )
      : v
  );
// Match the typed native Scope's optional/default fields without supplying
// any missing original identity proof from another observation.
const hintValue = (hint) => ({
  accountId: hint.accountId,
  mailbox: hint.mailbox,
  uid: hint.uid,
  nativeIdentity:
    hint.nativeIdentity == null
      ? null
      : {
          accountId: hint.nativeIdentity.accountId,
          mailbox: hint.nativeIdentity.mailbox,
          uidValidity: hint.nativeIdentity.uidValidity ?? null,
          originHash: hint.nativeIdentity.originHash,
          ...(hint.nativeIdentity.jmapMailboxId == null
            ? {}
            : { jmapMailboxId: hint.nativeIdentity.jmapMailboxId }),
        },
  messageIdPresent: hint.messageIdPresent ?? false,
  messageId: hint.messageId ?? null,
  graphId: hint.graphId ?? null,
  jmapId: hint.jmapId ?? null,
  localIdentity:
    hint.localIdentity == null
      ? null
      : {
          source: hint.localIdentity.source ?? null,
          staged: hint.localIdentity.staged ?? false,
        },
});
const scopeValue = (scope) => ({
  accountId: scope?.accountId ?? null,
  mailbox: scope?.mailbox ?? null,
  spans: scope?.spans ?? false,
  keys: scope?.keys || [],
  targetHints: (scope?.targetHints || []).map(hintValue),
});
export const originalTargetId = (hint) => stable(hint);
const tuple = (target) =>
  JSON.stringify([target.accountId, target.mailbox, target.uid]);
const targetFields = [
  'accountId',
  'mailbox',
  'uid',
  'proof',
  'server',
  'local',
  'mirror',
  'mirrorRemoved',
  'mirrorIssue',
  'refused',
  'skipped',
  'needsResync',
  'lastError',
];
function supportedTarget(target) {
  return (
    target &&
    typeof target.accountId === 'string' &&
    typeof target.mailbox === 'string' &&
    Number.isInteger(target.uid) &&
    target.uid > 0 &&
    Object.keys(target).every((key) => targetFields.includes(key)) &&
    ['pending', 'attempted', 'complete', 'failed'].includes(target.server) &&
    ['pending', 'attempted', 'complete', 'failed', 'conflict'].includes(
      target.local
    ) &&
    [
      'pending',
      'attempted',
      'complete',
      'queued',
      'unconfigured',
      'unresolved',
    ].includes(target.mirror) &&
    Number.isInteger(target.mirrorRemoved) &&
    target.mirrorRemoved >= 0 &&
    typeof target.needsResync === 'boolean' &&
    typeof target.refused === 'boolean' &&
    typeof target.skipped === 'boolean' &&
    (target.proof === null || ['server', 'local'].includes(target.proof?.kind))
  );
}
function fullTargets(raw, owner) {
  const intent = raw?.intent;
  const work = raw?.worker;
  if (
    raw?.id !== owner.id ||
    raw?.attemptId !== owner.attempt ||
    raw?.schemaVersion !== 1 ||
    raw?.type !== 'delete_everywhere' ||
    intent?.operation !== raw.type ||
    !Array.isArray(intent.groups) ||
    intent.groups.length ||
    !Array.isArray(work?.groups) ||
    work.groups.length ||
    stable(scopeValue(intent.scope)) !== stable(scopeValue(owner.scope)) ||
    stable(work.intent) !== stable(intent) ||
    !Array.isArray(work.purgeTargets) ||
    !work.purgeTargets.every(supportedTarget)
  )
    return null;
  const expected = groupBulkTargets(
    owner.scope.keys,
    owner.scope
  ).groups.flatMap((group) =>
    group.uids.map((uid) => tuple({ ...group, uid }))
  );
  if (
    expected.length !== work.purgeTargets.length ||
    work.purgeTargets.some((target, i) => tuple(target) !== expected[i])
  )
    return null;
  return work.purgeTargets;
}

// All mail decisions and pending writes belong to the native worker. This
// adapter owns only one subscription, attempt matching and status recovery.
export class BulkOperationManager {
  constructor() {
    this._operation = null;
    this._owner = null;
    this._subscribers = new Set();
  }
  get operation() {
    return this._operation;
  }
  get isRunning() {
    return !!this._owner;
  }
  subscribe(listener) {
    this._subscribers.add(listener);
    if (this._operation) listener({ ...this._operation });
    return () => this._subscribers.delete(listener);
  }
  status() {
    return send('bulk.status');
  }
  discard(operationId) {
    return send('bulk.discard', { operationId });
  }

  start({
    type,
    scope,
    accountId,
    mailbox,
    spans = false,
    uids = [],
    onProgress,
  }) {
    return this._run(
      'bulk.start',
      {
        operationId: uuid(),
        attemptId: uuid(),
        type,
        scope: scopeValue(scope || { accountId, mailbox, spans, keys: uids }),
      },
      onProgress
    );
  }
  resume(pending, _account, onProgress) {
    return this._run(
      'bulk.resume',
      { operationId: pending.id, attemptId: uuid(), type: pending.type },
      onProgress
    );
  }
  attach(active, onProgress) {
    return this._run(
      null,
      {
        operationId: active.id,
        attemptId: active.attemptId,
        type: active.type,
      },
      onProgress,
      active
    );
  }
  async _run(command, params, onProgress, attached) {
    if (this._owner) throw new Error(t('errors.operationRunning'));
    const hints = new Map();
    for (const hint of params.scope?.targetHints || []) {
      const key = tuple(hint);
      if (!hints.has(key)) hints.set(key, []);
      hints.get(key).push(hint);
    }
    const owner = {
      hints,
      id: params.operationId,
      requested: params.attemptId,
      attempt: null,
      scope: params.scope,
      outcomes: new Map(),
      early: new Map(),
      onProgress,
      finishing: false,
    };
    this._owner = owner;
    this._operation = {
      id: owner.id,
      type: params.type,
      status: 'starting',
      total: params.scope?.keys.length || 0,
      completed: 0,
    };
    owner.done = new Promise((resolve) => {
      owner.resolve = resolve;
    });
    this._emit(owner);
    try {
      const { listen } = await import('@tauri-apps/api/event');
      owner.unlisten = await listen('bulk-progress', (event) =>
        this._event(owner, event.payload)
      );
      if (attached) this._accept(owner, attached, false);
      else {
        try {
          this._accept(owner, await send(command, params));
        } catch (error) {
          // A lost reply says nothing about whether admission or work started.
          owner.error = error;
          await this._recover(owner);
        }
      }
      if (this._owner === owner && !owner.finishing) this._poll(owner);
      return await owner.done;
    } catch (error) {
      if (this._owner === owner) {
        this._operation = {
          ...this._operation,
          status: 'error',
          lastError: error.message || String(error),
        };
        this._emit(owner);
        this._cleanup();
      }
      throw error;
    }
  }
  _emit(owner) {
    if (this._owner !== owner) return;
    owner.onProgress?.({ ...this._operation });
    for (const listener of this._subscribers) listener({ ...this._operation });
  }
  _accept(owner, operation, inactive = true) {
    if (
      this._owner !== owner ||
      !operation ||
      operation.id !== owner.id ||
      !operation.attemptId
    )
      return false;
    if (owner.attempt && operation.attemptId !== owner.attempt) return false;
    owner.attempt = operation.attemptId;
    this._operation = { ...operation };
    this._emit(owner);
    for (const event of owner.early.values()) this._event(owner, event);
    owner.early.clear();
    if (inactive && terminal(operation.status)) void this._finish(owner);
    return true;
  }
  _record(owner, target) {
    if (!supportedTarget(target)) return;
    // Cache size is bounded by the frozen original selection, never by events.
    for (const hint of owner.hints.get(tuple(target)) || [])
      owner.outcomes.set(originalTargetId(hint), { hint, target });
  }
  _event(owner, event) {
    if (
      this._owner !== owner ||
      event?.operationId !== owner.id ||
      !event.attemptId
    )
      return;
    if (!owner.attempt) {
      const limit = Math.max(1, owner.scope?.targetHints.length || 1);
      const key = `${event.attemptId}:${event.target ? tuple(event.target) : 'status'}`;
      if (owner.early.size < limit + 1 || owner.early.has(key))
        owner.early.set(key, event);
      return;
    }
    if (
      event.attemptId !== owner.attempt ||
      event.operation?.id !== owner.id ||
      event.operation?.attemptId !== owner.attempt
    )
      return;
    this._record(owner, event.target);
    if (terminal(this._operation.status) && !event.finished) return;
    this._operation = { ...event.operation };
    this._emit(owner);
    if (event.finished) void this._finish(owner);
  }
  async _recover(owner) {
    let status = await send('bulk.status', {
      operationId: owner.id,
      attemptId: owner.requested,
    });
    if (this._owner !== owner) return;
    if (status?.active?.id === owner.id) {
      this._accept(owner, status.active, false);
      return;
    }
    const matchingReceipt = (status) =>
      status?.admission?.operationId === owner.id &&
      status.admission.attemptId === owner.requested
        ? status.admission
        : null;
    const receipt = matchingReceipt(status);
    if (
      status?.pending?.id === owner.id &&
      receipt?.state === 'done' &&
      status.pending.attemptId ===
        (receipt.ownerAttemptId || owner.attempt || owner.requested)
    ) {
      this._accept(owner, status.pending);
      return;
    }
    if (!receipt || receipt.state === 'freezing') {
      status = await send('bulk.status', {
        operationId: owner.id,
        attemptId: owner.requested,
        fenceUnstarted: true,
      });
      if (this._owner !== owner) return;
      if (status?.active?.id === owner.id) {
        this._accept(owner, status.active, false);
        return;
      }
    }
    const final = matchingReceipt(status);
    if (final && ['done', 'rejected', 'fenced'].includes(final.state)) {
      if (
        status?.pending?.id === owner.id &&
        status.pending.attemptId ===
          (final.ownerAttemptId || owner.attempt || owner.requested)
      )
        this._accept(owner, status.pending);
      else {
        // Terminal pending rows remain available, but compact status omits
        // them after drain. Read only the exact owned row, never another job.
        const raw =
          final.state === 'done' ? await send('read_pending_operation') : null;
        if (this._owner !== owner) return;
        if (
          raw?.schemaVersion === 1 &&
          raw.id === owner.id &&
          raw.attemptId ===
            (owner.attempt || final.ownerAttemptId || owner.requested) &&
          ['complete', 'cancelled', 'error'].includes(raw.status)
        ) {
          owner.raw = raw;
          this._accept(owner, {
            ...this._operation,
            id: raw.id,
            attemptId: raw.attemptId,
            type: raw.type,
            status: raw.status,
            result: raw.result,
            lastError: raw.lastError,
            errors: raw.errors,
          });
          return;
        }
        this._operation = {
          ...this._operation,
          status: 'error',
          lastError: owner.error?.message || t('errors.bulkStale'),
        };
        await this._finish(owner);
      }
    }
  }
  _poll(owner) {
    owner.timer = setTimeout(async () => {
      try {
        await this._recover(owner);
      } catch {
        /* reconnect on the next bounded tick */
      }
      if (this._owner === owner && !owner.finishing) this._poll(owner);
    }, 500);
  }
  async _finish(owner) {
    if (this._owner !== owner || owner.finishing) return;
    owner.finishing = true;
    if (
      this._operation.type === 'delete_everywhere' &&
      owner.scope &&
      owner.attempt
    ) {
      try {
        const raw = owner.raw || (await send('read_pending_operation'));
        if (this._owner !== owner) return;
        const targets = fullTargets(raw, owner);
        if (targets) for (const target of targets) this._record(owner, target);
      } catch {
        /* Missing full outcomes never becomes inferred success. */
      }
    }
    if (this._owner !== owner) return;
    this._operation = {
      ...this._operation,
      outcomes: [...owner.outcomes.values()],
    };
    const result = this._operation;
    this._emit(owner);
    this._cleanup();
    owner.resolve(result);
  }
  async cancel() {
    const owner = this._owner;
    if (!owner || !owner.attempt) throw new Error(t('errors.bulkStale'));
    const status = await send('bulk.status', {
      operationId: owner.id,
      attemptId: owner.requested,
    });
    if (
      this._owner !== owner ||
      status?.active?.id !== owner.id ||
      status.active.attemptId !== owner.attempt
    )
      throw new Error(t('errors.bulkStale'));
    await send('bulk.cancel', {
      operationId: owner.id,
      attemptId: owner.attempt,
    });
    // Cancelling is still running; only a native drain settles the subscription.
    if (this._owner === owner) {
      this._operation = { ...this._operation, status: 'cancelling' };
      this._emit(owner);
    }
  }
  _cleanup() {
    const owner = this._owner;
    if (owner) {
      clearTimeout(owner.timer);
      owner.unlisten?.();
    }
    this._owner = null;
  }
}
export const bulkOperationManager = new BulkOperationManager();
