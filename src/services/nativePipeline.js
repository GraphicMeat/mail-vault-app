// Thin client for the native download-ahead pipeline (Wave 4 S7). The daemon owns
// the queues, the policy, the retries and the daily limits; this file only turns
// the view on screen into raw facts, numbers the observation, and reads status.
// It sends no credentials, no policy, no selected uids and no date cutoff.

import { daemonCall } from './daemonClient.js';

/** Rows are hints about the loaded list; the daemon's cache decides what exists. */
const MAX_ROWS = 5000;

let revision = 0;
let seeded = false;
let online = true;
let latest = null;
let statusByAccount = {};

const stamp = value => (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : null);
const rowOf = (accountId, mailbox, email) => ({ accountId, mailbox, uid: email.uid,
  date: stamp(email.date), internalDate: stamp(email.internalDate) });
const usable = email => Number.isInteger(email?.uid) && email.uid > 0;

/**
 * The view on screen as raw facts. A unified list stamps each row with its own
 * account and the folder resolved for it; a branch listing's rows come from every
 * folder under its root; an ordinary list belongs wholly to the active folder.
 */
export function viewFacts(state) {
  const accountId = state?.activeAccountId;
  const mailbox = state?.activeMailbox;
  if (!accountId || !mailbox) return null;
  const emails = (state.emails || []).slice(0, MAX_ROWS).filter(usable);
  if (mailbox === 'UNIFIED') {
    return { accountId, mailbox, scope: 'unified',
      rows: emails.filter(email => email._accountId && email._mailbox)
        .map(email => rowOf(email._accountId, email._mailbox, email)) };
  }
  if (state.mailboxScope) {
    return { accountId, mailbox, scope: 'subtree',
      rows: emails.map(email => rowOf(accountId, email._mailbox ?? mailbox, email)) };
  }
  return { accountId, mailbox, scope: 'folder', rows: emails.map(email => rowOf(accountId, mailbox, email)) };
}

export async function readNativeStatus() {
  const status = await daemonCall('pipeline.status', {});
  statusByAccount = { ...(status?.accounts || {}) };
  return status;
}

async function send(focus, isOnline) {
  revision += 1;
  return daemonCall('pipeline.focus', { revision, online: isOnline, focus });
}

/**
 * Report the view. The revision only ever grows; a window that starts while the
 * daemon already holds a newer one adopts the daemon's number once and goes on.
 */
export async function focusNative(facts, isOnline = online) {
  online = isOnline;
  latest = facts ? { facts, online: isOnline } : null;
  if (!seeded) {
    const status = await readNativeStatus().catch(() => null);
    if (Number.isSafeInteger(status?.revision)) revision = Math.max(revision, status.revision);
    seeded = true;
  }
  let answer = await send(facts, isOnline);
  if (answer?.accepted === false && Number.isSafeInteger(answer.revision)) {
    revision = Math.max(revision, answer.revision);
    // The wait may have outlived this view: retry what is on screen now. A window that
    // retired its observation meanwhile sends nothing; only an explicit stop (no facts) repeats itself.
    const next = latest ?? (facts ? null : { facts: null, online: isOnline });
    if (next) answer = await send(next.facts, next.online);
  }
  return answer;
}

/** The latest view again, once, under a newer revision (after a reconnect or a lag). */
export async function resendNative() {
  return latest ? focusNative(latest.facts, online) : null;
}

export async function setNativeOnline(next) {
  online = next;
  return latest ? focusNative(latest.facts, next) : null;
}

/** An explicit stop (clearing the cache): the daemon drops its queues. Not for unmount. */
export async function stopNative() {
  latest = null;
  return focusNative(null, online);
}

/** The window retires its own observation; the daemon's work and children carry on. */
export function retireObservation() {
  latest = null;
}

export function noteProgress(payload) {
  if (!payload?.accountId) return;
  const { accountId, ...entry } = payload;
  statusByAccount = { ...statusByAccount, [accountId]: entry };
}

/** A synchronous snapshot for the e2e debug hooks. */
export function snapshot() {
  return Object.entries(statusByAccount).map(([id, entry]) => ({ id, phase: entry.phase, queued: entry.queued ?? 0,
    held: 0, activeSlots: entry.activeSlots ?? 0 }));
}

export function resetForTests() {
  revision = 0; seeded = false; online = true; latest = null; statusByAccount = {};
}
