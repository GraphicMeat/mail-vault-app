// One ordered lane for native unread reductions. Count arithmetic stays native.
import { daemonCall } from './daemonClient';
import { useSettingsStore } from '../stores/settingsStore';

const pending = [];
let running = false;
let connectionGeneration = 0;
const idleWaiters = [];
const REPLY_BUDGET_MS = 31_000;
const FRESH_REPAIR = Symbol('fresh-unread-repair');

export function invalidateUnreadConnection() { connectionGeneration += 1; }

function validAnswer(answer) {
  return !!answer && typeof answer === 'object' && !Array.isArray(answer)
    && answer.counts && typeof answer.counts === 'object' && !Array.isArray(answer.counts)
    && Object.values(answer.counts).every(Number.isSafeInteger)
    && Array.isArray(answer.rows)
    && answer.rows.every(row => row && typeof row.id === 'string'
      && typeof row.label === 'string' && Number.isSafeInteger(row.unread))
    && Number.isSafeInteger(answer.total)
    && answer.total === answer.rows.reduce((sum, row) => sum + row.unread, 0)
    && typeof answer.wrote === 'boolean'
    && (answer.recountSource === undefined
      || ['complete', 'arrivalFallback', 'none'].includes(answer.recountSource));
}

function queuedRawMutationFor(item) {
  const account = item.request.accountId;
  return account && pending.some(next => next.accounts?.includes(account)
    && ['shift', 'followUps'].includes(next.request.op) && !next.invalid?.());
}

async function execute(item) {
  if (item.invalid?.()) return null;
  const generation = connectionGeneration;
  for (let attempt = 0; attempt < (item.repairing ? 1 : 2); attempt++) {
    const state = useSettingsStore.getState();
    const baseline = { ...(state.unreadPerAccount || {}) };
    const baselineKey = JSON.stringify(baseline);
    const request = { ...item.request, baseline, presentation: item.presentation() };
    let answer;
    let timer;
    try {
      answer = await Promise.race([
        daemonCall('counts.unread', request),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('unread reply timed out')), REPLY_BUDGET_MS); }),
      ]);
    }
    catch { return null; }
    finally { clearTimeout(timer); }
    if (!validAnswer(answer) || generation !== connectionGeneration || item.invalid?.()) return null;
    // A complete snapshot held across a later raw change may contain either
    // side of that change. Keep the raw operation and reconcile once afterward.
    // A partial-cache arrival fallback is additive and retains its lane order.
    if (item.request.op === 'recountCache' && answer.wrote && queuedRawMutationFor(item)) {
      const source = answer.recountSource
        ?? (item.request.arrivalCount > 0 ? null : 'complete');
      if (source === 'complete' || source === null) {
        if (!item.repairing && item.freshRequest) return FRESH_REPAIR;
        // The one fresh read also became stale. Keep valid raw shifts; a later
        // observation can repair any unrelated cache changes.
        return null;
      }
    }
    const current = useSettingsStore.getState();
    if (JSON.stringify(current.unreadPerAccount || {}) !== baselineKey) {
      // Hydration or another settings writer landed while the route was held.
      // Rebase by asking native again, once, with the new baseline.
      if (attempt === 0) continue;
      return null;
    }
    if (answer.wrote) current.setUnreadPerAccount(answer.counts);
    return answer;
  }
  return null;
}

async function drain() {
  if (running) return;
  running = true;
  while (pending.length) {
    const item = pending.shift();
    let answer = null;
    try { answer = await execute(item); }
    catch { /* A failed projection leaves the current settings untouched. */ }
    if (answer === FRESH_REPAIR) {
      try {
        item.request = item.freshRequest();
        item.repairing = true;
        item.coalesceKey = null;
        pending.push(item); // after every already queued raw operation
        continue;
      } catch { answer = null; }
    }
    item.cleanup?.();
    for (const settle of item.waiters) settle(answer);
  }
  running = false;
  for (const finish of idleWaiters.splice(0)) finish();
}

export function whenUnreadIdle() {
  return running || pending.length ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();
}

export function submitUnread(request, { presentation, invalid, cleanup, coalesceKey = null,
  accounts = [], freshRequest = null } = {}) {
  return new Promise(resolve => {
    const last = pending.at(-1);
    if (coalesceKey && last?.coalesceKey === coalesceKey) {
      // Only the newest pending pure recount of this one target matters.
      last.cleanup?.();
      last.request = request;
      last.presentation = presentation;
      last.invalid = invalid;
      last.cleanup = cleanup;
      last.accounts = accounts;
      last.freshRequest = freshRequest;
      last.waiters.push(resolve);
    } else {
      pending.push({ request, presentation, invalid, cleanup, coalesceKey, accounts, freshRequest,
        repairing: false, waiters: [resolve] });
    }
    void drain();
  });
}
