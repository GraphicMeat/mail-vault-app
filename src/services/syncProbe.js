// The daemon decides mailbox freshness; this adapter orders account mutations.
import { send } from './transport';

const ADAPTER_BUDGET_MS = 31_000;
const tails = new Map();
const uncertain = new Set();
const conservative = () => ({ unchanged: false, reason: 'probe-failed' });

function bounded(work) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('errors.daemonUnavailable')), ADAPTER_BUDGET_MS);
  });
  let task;
  try { task = Promise.resolve(work()); }
  catch (error) { task = Promise.reject(error); }
  return Promise.race([task, expired])
    .finally(() => clearTimeout(timer));
}

function queueMutation(accountId, work, failure, clearsUncertainty = false) {
  const previous = tails.get(accountId);
  const operation = async () => {
    try {
      const result = await bounded(work);
      if (clearsUncertainty) uncertain.delete(accountId);
      return result;
    } catch {
      uncertain.add(accountId);
      return failure;
    }
  };
  const next = previous ? previous.then(operation) : operation();
  tails.set(accountId, next);
  void next.then(() => {
    if (tails.get(accountId) === next && !uncertain.has(accountId)) tails.delete(accountId);
  });
  return next;
}

export function markVerified(accountId, mailbox, evidence) {
  const hasProof = typeof evidence?.verificationRef === 'string'
    && evidence.verificationRef.length > 0;
  const hasTicket = Number.isSafeInteger(evidence?.ticket) && evidence.ticket >= 0;
  if (hasProof === hasTicket) return Promise.resolve({ marked: false });
  const source = hasProof ? { verificationRef: evidence.verificationRef }
    : { ticket: evidence.ticket };
  return queueMutation(accountId, async () => {
    const result = await send('sync.probe', { op: 'mark', accountId, mailbox, ...source });
    if (typeof result?.marked !== 'boolean') throw new Error('errors.daemonUnavailable');
    return result;
  }, { marked: false });
}

export function invalidate(accountId, mailbox) {
  return queueMutation(accountId, async () => {
    // A failed mutation may have left any native marker live. Recovery must
    // invalidate the whole account, even when this call names one mailbox.
    const scope = uncertain.has(accountId) ? {} : mailbox ? { mailbox } : {};
    const result = await send('sync.probe', { op: 'invalidate', accountId, ...scope });
    if (result?.invalidated !== true) throw new Error('errors.daemonUnavailable');
    return result;
  }, { invalidated: false }, true);
}

export async function mailboxIsUnchanged(_account, accountId, mailbox) {
  let active = true;
  try {
    const result = await bounded(async () => {
      const prior = tails.get(accountId);
      if (prior) await prior;
      if (!active || uncertain.has(accountId)) return conservative();
      return send('sync.probe', { op: 'check', accountId, mailbox });
    });
    return typeof result?.unchanged === 'boolean' && typeof result?.reason === 'string'
      ? result : conservative();
  } catch {
    return conservative();
  } finally {
    active = false;
  }
}
