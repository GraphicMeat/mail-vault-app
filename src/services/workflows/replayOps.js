// ── replayOps — finish the server ops a previous session never sent ──

import * as db from '../db';
import * as api from '../api';
import { ensureFreshToken } from '../authUtils';
import { isGraphAccount } from '../graphConfig';
import { markServerDeleted } from './messageMutations';
import { useConnectivityStore } from '../../stores/connectivityStore';

/**
 * Relay to the Rust log as well as the console.
 *
 * This runs before any UI exists and reports on work the user cannot see, so a
 * console-only line is invisible in exactly the situations worth diagnosing —
 * a packaged build, or a headless runner where the webview console goes nowhere.
 */
const log = (...args) => {
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  console.log(msg);
  window.__TAURI__?.core?.invoke?.('log_from_frontend', { message: msg }).catch(() => {});
};

/**
 * Re-issue every server mutation the user confirmed but that never reached the
 * server, then forget it.
 *
 * The journal is written before the optimistic update and cleared after the
 * last round-trip (see messageMutations), so anything still in it belongs to a
 * session that died mid-op — a reload, a quit, a crash — or to a stretch with
 * no link. Those messages are unchanged on the server while the user watched
 * their rows move, vanish or change colour, so finishing the job is the only
 * outcome that matches what they were shown.
 *
 * Entries are cleared only when the op LANDS. A failure keeps its entry: the
 * row it belongs to is already gone from the list, so dropping the entry left
 * the server holding a message the app had shown as deleted with nothing
 * anywhere to finish the job — a dead pooled socket was enough to lose a
 * confirmed delete. A journal that never drains is the cost, and Settings ›
 * Background Daemon is where a user cancels an entry that has been failing for
 * too long. The reason is kept in memory (db.noteOpFailure) for that list.
 *
 * ponytail: unbounded retry, capped only by the user. An attempt counter in
 * the entry (src-core/src/op_journal.rs) is the upgrade path if launches ever
 * spend real time on ops that will never land.
 *
 * The keep-on-failure rule is applied to every op kind here, deliberately —
 * a replay cannot tell which live path wrote an entry. The live paths differ:
 * only delete keeps its row evicted and its entry queued when the server
 * refuses (messageMutations). A refused move or flag still restores the row
 * and clears its entry at the call site, so this only ever sees theirs when a
 * session died before the round trip.
 */
export async function replayOps({ reason = 'launch' } = {}) {
  const { useMailStore } = await import('../../stores/mailStore');
  const finish = (result) => {
    // Park the outcome in the store. It is the only trace this leaves: the work
    // happens before any UI exists, and on a packaged build the console goes
    // nowhere. Something has to be able to answer "did the last launch finish
    // what the one before it started".
    useMailStore.setState({ opReplay: { ...result, at: Date.now() } });
    return result;
  };

  const ops = await db.readOps();
  if (!ops.length) return finish({ attempted: 0, done: 0, failed: 0, kept: 0, errors: [] });

  // Withdraw the undo offer before sending anything.
  //
  // A move made offline is undone by forgetting its journal entry — that is
  // the whole undo, because nothing was ever sent. Once this replay has read
  // the journal into memory, the entry WILL be sent, so a clearOps arriving
  // after this line undoes nothing: the messages move, the rows come back for
  // one repaint, and the next sync takes them away again. Taking the offer
  // down means the undo either ran before the replay started or is no longer
  // on the table.
  useMailStore.getState().clearUndo?.();

  log(
    `[replayOps] ${ops.length} unfinished op(s) from a previous session (${reason}):`,
    ops.map((o) => `${o.op} ${o.accountId}/${o.mailbox} ${o.uids.join(',')}`),
  );

  // Wait for credentials before touching a server.
  //
  // Accounts land in the store as soon as they are read, but their passwords
  // arrive with the keychain, which is a separate async load behind an OS
  // permission prompt. Replaying against the store's first snapshot failed
  // every op with "Password missing" — and then cleared the journal, turning a
  // recoverable delay into permanent data loss. The timeout is a backstop for a
  // keychain that never resolves (a denied prompt): leaving the journal
  // untouched is the right outcome there, not hanging forever.
  db.startKeychainLoad();
  await Promise.race([
    new Promise((resolve) => db.onKeychainReady(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 30_000)),
  ]);

  // Read accounts from the db rather than the store: this runs at launch, and
  // the store's copy is whatever had loaded by the time the effect fired.
  let accounts = [];
  try {
    accounts = await db.getAccounts();
  } catch (e) {
    log('[replayOps] could not load accounts, keeping everything queued:', String(e?.message || e));
    return finish({ attempted: 0, done: 0, failed: 0, kept: ops.length, errors: [] });
  }

  let attempted = 0;
  let ok = 0;
  let failed = 0;
  let kept = 0;
  const errors = [];

  for (const entry of ops) {
    const { op, accountId, mailbox, uids, arg } = entry;
    if (!op || !accountId || !mailbox || !uids?.length) continue;

    const account = accounts.find((a) => a.id === accountId);
    // Account removed since, or a Graph account that should never have been
    // journalled: nothing here can act on it, so stop carrying it.
    if (!account || isGraphAccount(account)) {
      await db.clearOps({ op, accountId, mailbox, uids, arg });
      continue;
    }

    let fresh;
    try {
      fresh = await ensureFreshToken(account);
    } catch (e) {
      kept += uids.length;
      log(`[replayOps] ${account.email}: cannot authenticate, keeping ${uids.length} queued:`, String(e?.message || e));
      continue;
    }

    // `answered` is "dealt with, one way or another" — cleared from the journal.
    // A credentials failure is not an answer, so those uids stay.
    // `removed` is the narrower set that is no longer in this mailbox.
    const answered = [];
    const removed = [];
    for (const uid of uids) {
      attempted++;
      try {
        if (op === 'delete') {
          await api.deleteEmail(fresh, uid, mailbox);
          removed.push(uid);
        } else if (op === 'flag') {
          await api.updateEmailFlags(fresh, uid, arg?.flags, arg?.action, mailbox);
        } else if (op === 'move') {
          await api.moveEmails(fresh, [uid], mailbox, arg?.target);
          removed.push(uid);
        } else {
          // Written by a newer build, or corrupt. Nothing here can apply it and
          // nothing later will either, so drop it rather than carry it forever.
          log(`[replayOps] unknown op ${op} — dropping`);
          answered.push(uid);
          continue;
        }
        ok++;
        answered.push(uid);
      } catch (e) {
        const message = String(e?.message || e);
        failed++;
        errors.push(`${op} ${mailbox}/${uid}: ${message}`);
        log(`[replayOps] ${account.email} ${op} ${mailbox} uid ${uid} failed:`, message);
        // Kept, whatever the reason: see the header. A credentials problem is
        // simply the case where not even the next launch should read anything
        // into the failure.
        db.noteOpFailure({ op, accountId, mailbox, uid }, message);
        kept++;
      }
    }
    if (answered.length) await db.clearOps({ op, accountId, mailbox, uids: answered, arg });

    // A replayed delete is still this app deleting the server copy, so a
    // surviving vault copy earns the same stamp the live paths write — without
    // it, a delete that finished after a crash leaves the row saying "also
    // still on the server" for good. See stores/slices/custody.js.
    if (op === 'delete') for (const uid of removed) await markServerDeleted(accountId, mailbox, uid);

    if (removed.length) {
      // Prune the header sidecar too, or the row comes straight back.
      //
      // The session that died never got to its own prune, and the cache is what
      // the list paints from on the next visit — so without this the message is
      // gone from the mailbox and still on screen. Empty emails + null total:
      // this writes no headers and leaves the stored count alone, it only drops
      // the uids (same shape the delete workflows use when the view has moved).
      await db.saveEmailHeaders(accountId, mailbox, [], null, { removedUids: removed });
    }

    // If that mailbox is what the user is looking at right now, reload it — the
    // rows on screen were painted before the op landed. A flag changes no uid,
    // so it prunes nothing, but the row still paints the old read/starred state.
    if (removed.length || (op === 'flag' && answered.length)) {
      const s = useMailStore.getState();
      if (s.activeAccountId === accountId && s.activeMailbox === mailbox) {
        s.loadEmails?.();
      }
    }
  }

  log(`[replayOps] finished ${attempted} unfinished op(s): ${ok} ok, ${failed} failed, ${kept} still queued`);
  return finish({ attempted, done: ok, failed, kept, errors });
}

// How often an online session re-attempts whatever is still owed.
const RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * May the periodic tick replay right now? Exported because the interval it
 * guards lives for the life of the process, which no test can hold still.
 */
export async function shouldRetryNow() {
  if (!useConnectivityStore.getState().online) return false;
  const { useMailStore } = await import('../../stores/mailStore');
  return !useMailStore.getState().undo;
}

let _wired = false;

/**
 * Replay when the link comes back.
 *
 * Ops queued while offline are the whole point of the journal being ordered:
 * waiting for the next launch to apply them means the server disagrees with
 * what the user was shown for as long as the app stays open. Idempotent, so the
 * scheduler can call it on every mount.
 *
 * The 2 s debounce is for a link that flaps on the way up (Wi-Fi rejoining, a
 * captive portal settling), and the single-flight guard is for a flap that
 * outlasts it — a second replay racing the first would re-issue ops the first
 * has already sent but not yet cleared.
 */
export function wireReplayOnReconnect() {
  if (_wired) return;
  _wired = true;
  let was = useConnectivityStore.getState().online;
  let timer = null;
  let running = false;
  const run = async (reason) => {
    if (running) return;
    running = true;
    try {
      await replayOps({ reason });
    } catch (e) {
      log(`[replayOps] ${reason} replay failed:`, String(e?.message || e));
    } finally {
      running = false;
    }
  };
  useConnectivityStore.subscribe((s) => {
    const now = s.online;
    if (now && !was && !running) {
      clearTimeout(timer);
      timer = setTimeout(() => run('online'), 2000);
    }
    was = now;
  });
  // A failure now keeps its entry, so "the link came back" is no longer the
  // only thing that can unstick one: a provider that refused a delete for a
  // minute would otherwise hold it until the next launch, with the row already
  // gone from the list. Cheap — the journal is empty in the normal case, and
  // replayOps returns on the first read.
  //
  // Never over a live undo offer. A replay that reads a non-empty journal
  // withdraws the offer (see the clearUndo call above), and a permanently
  // stuck entry — the case this whole feature exists to surface — makes the
  // journal permanently non-empty. Without this guard the tick would take down
  // the user's undo toast every five minutes for reasons that have nothing to
  // do with the delete they just made. Skipping the tick is the right half to
  // give up: the entry is already stuck, five more minutes costs nothing.
  setInterval(async () => { if (await shouldRetryNow()) run('retry'); }, RETRY_INTERVAL_MS);
}
