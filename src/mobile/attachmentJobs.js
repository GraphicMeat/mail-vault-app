// The engine's attachment events, routed by job id. `mobile.attachment.fetch` answers `{jobId}` at
// once, but the job runs on the engine's own thread, so its first `progress` (or even its `done`)
// can reach the page before that reply does. Events for a job nobody watches yet are kept, a few
// jobs' worth, and replayed to the first watcher. One subscription per event name for the page's
// life: subscribing is asynchronous, so a chip subscribes when it mounts, not when it is tapped.
import { listen } from './transport.js';

/** Jobs whose unclaimed events are kept; older ones are dropped first. */
const KEEP_JOBS = 32;

let subscribed = false;
/** jobId -> Set of handlers `(kind, payload)`. */
const watchers = new Map();
/** jobId -> events not yet claimed, oldest first: the latest progress and the end, if any. */
const early = new Map();

function keep(jobId, kind, payload) {
  const list = early.get(jobId) || [];
  // Only the latest progress matters.
  const kept = kind === 'progress' ? list.filter((e) => e.kind !== 'progress') : list;
  kept.push({ kind, payload });
  early.delete(jobId);
  early.set(jobId, kept);
  while (early.size > KEEP_JOBS) early.delete(early.keys().next().value);
}

function deliver(kind, payload) {
  const jobId = payload?.jobId;
  if (jobId == null) return;
  const set = watchers.get(jobId);
  if (set && set.size) {
    for (const handler of [...set]) handler(kind, payload);
  } else {
    keep(jobId, kind, payload);
  }
}

/** Subscribes to the three attachment events once. Safe to call from every chip. */
export function ensureAttachmentEvents() {
  if (subscribed) return;
  try {
    listen('mobile.attachment.progress', (p) => deliver('progress', p));
    listen('mobile.attachment.done', (p) => deliver('done', p));
    listen('mobile.attachment.failed', (p) => deliver('failed', p));
    subscribed = true;
  } catch {
    // No event bridge (a test without one): chips still work from replies, never from events.
  }
}

/** Calls `handler(kind, payload)` for every event of `jobId`, first those that came early. */
export function watchJob(jobId, handler) {
  let set = watchers.get(jobId);
  if (!set) {
    set = new Set();
    watchers.set(jobId, set);
  }
  set.add(handler);
  const backlog = early.get(jobId);
  if (backlog) {
    early.delete(jobId);
    for (const e of backlog) handler(e.kind, e.payload);
  }
  return () => {
    set.delete(handler);
    if (set.size === 0 && watchers.get(jobId) === set) watchers.delete(jobId);
  };
}

/** Tests only: forget the subscription and everything kept. */
export function resetAttachmentJobs() {
  subscribed = false;
  watchers.clear();
  early.clear();
}
